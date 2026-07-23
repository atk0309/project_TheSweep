// Thin Postgres layer (raw pg, no ORM). Server is the ONLY DB client.
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function sslFor(connectionString) {
  let host = '';
  try { host = new URL(connectionString).hostname.toLowerCase(); } catch { /* pg reports malformed URLs */ }
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.railway.internal')) {
    return false;
  }
  return { rejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== '0' };
}

export const pool = config.databaseUrl
  ? new pg.Pool({
      connectionString: config.databaseUrl,
      ssl: sslFor(config.databaseUrl),
      max: 10,
      idleTimeoutMillis: 30_000,
      application_name: 'the-sweep',
    })
  : null;

export const hasDb = !!pool;

export async function query(text, params) {
  if (!pool) throw new Error('DATABASE_URL not configured');
  return pool.query(text, params);
}

// Run a callback inside a transaction with a dedicated client.
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

// Idempotent schema + seed, run on every boot (CREATE TABLE IF NOT EXISTS).
export async function initSchema() {
  if (!pool) {
    console.warn('[db] No DATABASE_URL — skipping schema init.');
    return;
  }
  const sql = await readFile(join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
  await seedTeams();
  await pruneRetainedData();
  startRetentionTimer();
  console.log('[db] schema ready');
}

// Bound operational PII and token retention. Active player accounts remain until
// an admin removes them; short-lived authentication and audit data do not.
export async function pruneRetainedData() {
  if (!pool) return;
  await pool.query("DELETE FROM magic_tokens WHERE created_at < now() - interval '7 days'");
  await pool.query(
    `DELETE FROM auth_throttle
      WHERE (banned=false AND updated_at < now() - interval '30 days')
         OR (banned=true  AND updated_at < now() - interval '365 days')`,
  );
  await pool.query("DELETE FROM audit_log WHERE created_at < now() - interval '90 days'");
}

let retentionTimer = null;
function startRetentionTimer() {
  if (retentionTimer) return;
  retentionTimer = setInterval(() => {
    pruneRetainedData().catch((e) => console.error('[db] retention cleanup:', e.message));
  }, 24 * 60 * 60 * 1000);
  retentionTimer.unref();
}

// Seed the 48 design-derived demo teams, but ONLY on a fresh table. Once teams
// exist — whether the demo seed or the real participants the poller fills in by
// name-match — we leave them alone. Re-running an upsert on every boot would
// clobber the poller's real data and collide on the idx UNIQUE constraint
// (teams_idx_key) whenever a real team sits at a demo team's idx but under a
// different code (so ON CONFLICT (code) never fires). reset/wipe never deletes
// teams, so after the first seed this is a permanent no-op.
export async function seedTeams() {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM teams');
  if (rows[0].n > 0) {
    console.log(`[db] teams present (${rows[0].n}) — skipping seed`);
    return;
  }
  const raw = await readFile(join(__dirname, 'teams.seed.json'), 'utf8');
  const teams = JSON.parse(raw);
  for (const t of teams) {
    await pool.query(
      `INSERT INTO teams (idx, code, name, group_letter, flag)
       VALUES ($1,$2,$3,$4,$5)`,
      [t.idx, t.code, t.name, t.group_letter, t.flag],
    );
  }
  console.log(`[db] seeded ${teams.length} teams`);
}
