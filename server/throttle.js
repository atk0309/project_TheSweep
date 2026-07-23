// Persistent, escalating, multi-identity throttle for magic-link sends, plus a
// global send cap. Protects the owner's Resend quota from abuse.
//
// Per identity (IP / signed cookie / recipient email), uniform ladder:
//   5 attempts → 15-min cooldown → 5 → 1-hour cooldown → 5 → long-lived ban.
// A request is blocked if ANY of its identities is currently cooling or banned,
// so rotating one identity (clearing the cookie, switching IP, varying the email)
// does not grant a fresh quota. Strikes are monotonic; only the admin clear route
// resets them. State lives in Postgres so cooldowns/bans survive restarts.
import { isIP } from 'node:net';
import { pool, query, tx } from './db.js';
import { config } from './config.js';

export const MAX_PER_BURST = 5;
const COOLDOWN_MIN = { 1: 15, 2: 60 };                 // strike → cooldown minutes
const BAN_AT = Math.max(...Object.keys(COOLDOWN_MIN).map(Number)) + 1; // = 3 (derived)
export const SCOPES = ['cookie', 'email', 'ip'];        // fixed lock order ⇒ no deadlocks

// ── Pure decision functions (no DB; unit-tested in scripts/throttle.test.mjs) ──

// Is this identity currently blocked? (no mutation)
export function isBlocked(row, now) {
  return row.banned || (!!row.cooldown_until && new Date(row.cooldown_until) > now);
}

// Record one attempt against an identity and return its next persisted state.
// cooldownMinutes is applied SQL-side (now() + interval) so there is a single clock.
// Callers must only invoke this when the identity is NOT already blocked.
// neverBan ⇒ cooldown-only escalation: never set `banned`; cap at the top cooldown
// (used for admin recipient addresses so the owner can't be banned).
export function nextState(row, now, { neverBan = false } = {}) {
  let { attempts, strikes, banned } = row;
  const expired = !!row.cooldown_until && new Date(row.cooldown_until) <= now;
  if (expired) attempts = 0;                            // cooldown elapsed → fresh burst
  attempts += 1;                                        // the 5th attempt is allowed; it closes the burst
  let cooldownMinutes = null;
  let clearCooldown = expired;                          // drop the stale cooldown timestamp
  if (attempts >= MAX_PER_BURST) {
    strikes += 1;
    if (strikes >= BAN_AT) {
      if (neverBan) cooldownMinutes = COOLDOWN_MIN[BAN_AT - 1]; // stay at the top cooldown rung
      else { banned = true; clearCooldown = true; }
    } else {
      cooldownMinutes = COOLDOWN_MIN[strikes];
    }
  }
  return { attempts, strikes, banned, cooldownMinutes, clearCooldown };
}

// ── DB helpers ────────────────────────────────────────────────────────────

// Treat attacker-induced contention (lock/statement timeout, serialization) as a
// signal to fail CLOSED; a genuine connectivity outage fails OPEN (issuance would
// fail anyway, so nothing is sent regardless).
const CONTENTION_CODES = new Set(['55P03', '57014', '40001', '40P01']); // lock_timeout, statement_timeout (query_canceled), serialization, deadlock
function isContention(e) { return e && CONTENTION_CODES.has(e.code); }

// Accept only a single real IP address and collapse equivalent IPv6 spellings.
// This keeps attacker-controlled forwarding text, oversized values, and alternate
// representations of one address from becoming distinct throttle-table keys.
export function canonicalIp(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 64 || raw.includes('%')) return '';
  const version = isIP(raw);
  if (version === 4) return raw;
  if (version !== 6) return '';
  try {
    const normalized = new URL(`http://[${raw}]/`).hostname.slice(1, -1).toLowerCase();
    const mapped = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (!mapped) return normalized;
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  } catch {
    return '';
  }
}

// Normalize + drop empty identifiers; never key a row on ''.
function buildIdentities({ ip, cookieId, email }) {
  const out = [];
  const push = (scope, v) => { const s = String(v || '').trim(); if (s) out.push({ scope, identifier: s }); };
  push('ip', canonicalIp(ip));
  push('cookie', cookieId);
  push('email', email);
  return out;
}

async function persist(client, { scope, identifier }, ns) {
  await client.query(
    `UPDATE auth_throttle
        SET attempts = $3,
            strikes  = $4,
            banned   = $5,
            cooldown_until = CASE
              WHEN $6::int IS NOT NULL THEN now() + ($6 * interval '1 minute')
              WHEN $7::boolean THEN NULL
              ELSE cooldown_until END,
            updated_at = now()
      WHERE scope = $1 AND identifier = $2`,
    [scope, identifier, ns.attempts, ns.strikes, ns.banned, ns.cooldownMinutes, ns.clearCooldown],
  );
  if (ns.banned) console.warn(`[throttle] identity banned · scope=${scope}`);
  else if (ns.cooldownMinutes) console.warn(`[throttle] cooldown ${ns.cooldownMinutes}m · scope=${scope}`);
}

const tuples = (ids, base = 0) => ids.map((_, i) => `($${base + i * 2 + 1}, $${base + i * 2 + 2})`).join(',');

// ── Gate: block if ANY identity is cooling/banned; record IP + cookie only ────
// Email is never written here — it's recorded post-send via recordEmailSend(), so
// unregistered emails / typos never create email rows or trip the email ladder.
// A blocked request creates no rows and performs no writes at all.
// Returns { blocked }. Fails closed on contention, open on connectivity errors.
export async function gateRequest({ ip, cookieId, email }) {
  const all = buildIdentities({ ip, cookieId, email });
  if (!all.length || !pool) return { blocked: false };
  const recordIds = all.filter((x) => x.scope !== 'email'); // ip + cookie
  try {
    return await tx(async (c) => {
      await c.query("SET LOCAL lock_timeout = '2s'");
      await c.query("SET LOCAL statement_timeout = '3s'");
      const now = (await c.query('SELECT now() AS t')).rows[0].t;

      // 1. Block check on EXISTING rows only — no row creation, no writes.
      const params = all.flatMap((x) => [x.scope, x.identifier]);
      const existing = await c.query(
        `SELECT scope, identifier, attempts, strikes, cooldown_until, banned
           FROM auth_throttle WHERE (scope, identifier) IN (${tuples(all)})`,
        params,
      );
      for (const r of existing.rows) if (isBlocked(r, now)) return { blocked: true };

      // 2. Record IP + cookie: create-if-missing, lock in scope order, re-check, escalate.
      if (recordIds.length) {
        const rp = recordIds.flatMap((x) => [x.scope, x.identifier]);
        await c.query(`INSERT INTO auth_throttle (scope, identifier) VALUES ${tuples(recordIds)} ON CONFLICT DO NOTHING`, rp);
        const locked = await c.query(
          `SELECT scope, identifier, attempts, strikes, cooldown_until, banned
             FROM auth_throttle WHERE (scope, identifier) IN (${tuples(recordIds)}) ORDER BY scope FOR UPDATE`,
          rp,
        );
        // Re-check under the lock: if one flipped to blocked concurrently, refuse without escalating.
        for (const r of locked.rows) if (isBlocked(r, now)) return { blocked: true };
        const byKey = new Map(locked.rows.map((r) => [`${r.scope}|${r.identifier}`, r]));
        for (const id of recordIds) await persist(c, id, nextState(byKey.get(`${id.scope}|${id.identifier}`), now));
      }
      return { blocked: false };
    });
  } catch (e) {
    if (isContention(e)) {
      console.warn('[throttle] gate fail-closed (contention):', e.code);
      return { blocked: true };
    }
    console.error('[throttle] gate fail-open:', e.message);
    return { blocked: false };
  }
}

const GLOBAL_CAP_LOCK = 1398362448; // 'SWEP' — stable key for pg_advisory_xact_lock

// Atomically decide AND commit a send in one advisory-locked transaction:
//   (1) global-cap check (when enforceCap)  →  (2) email-slot reservation (when reserveEmail)
//   →  (3) the token insert.
// All-or-nothing, ordered so the recipient's email ladder is consumed ONLY when a link is
// actually issued (cap has room, email not blocked, token inserted). This avoids burning a
// recipient's quota on requests that the cap rejects. insertToken(q) runs the magic_tokens
// INSERT with the provided query fn. neverBan keeps an admin recipient cooldown-only.
// Returns { sent, reason }. Fails closed on the send for contention/connectivity errors.
export async function reserveSend({ email, reserveEmail = false, neverBan = false, enforceCap = true, insertToken }) {
  if (!pool) { await insertToken((t, p) => query(t, p)); return { sent: true }; }
  try {
    return await tx(async (c) => {
      await c.query("SET LOCAL lock_timeout = '3s'");
      await c.query("SET LOCAL statement_timeout = '4s'");
      await c.query('SELECT pg_advisory_xact_lock($1)', [GLOBAL_CAP_LOCK]);

      // 1. Global cap — before touching the email ladder, so a capped request costs nothing.
      if (enforceCap) {
        // Bound the scan to the last day (uses magic_tokens_created_idx) so this stays cheap
        // as history accumulates — it runs under the advisory lock on every send.
        const { rows } = await c.query(
          `SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour') AS h,
                  count(*) AS d
             FROM magic_tokens
            WHERE created_at > now() - interval '1 day'`,
        );
        const h = Number(rows[0].h);
        const d = Number(rows[0].d);
        if (h >= config.sendCapHour || d >= config.sendCapDay) {
          console.warn(`[throttle] global cap hit (hour=${h}/${config.sendCapHour}, day=${d}/${config.sendCapDay})`);
          return { sent: false, reason: 'global_cap' };
        }
      }

      // 2. Email recipient ladder — reserve only when we're about to actually send.
      if (reserveEmail) {
        const identifier = String(email || '').trim().toLowerCase();
        if (identifier) {
          const now = (await c.query('SELECT now() AS t')).rows[0].t;
          await c.query(`INSERT INTO auth_throttle (scope, identifier) VALUES ('email', $1) ON CONFLICT DO NOTHING`, [identifier]);
          const { rows } = await c.query(
            `SELECT scope, identifier, attempts, strikes, cooldown_until, banned
               FROM auth_throttle WHERE scope = 'email' AND identifier = $1 FOR UPDATE`,
            [identifier],
          );
          if (isBlocked(rows[0], now)) return { sent: false, reason: 'email_throttle' };
          await persist(c, { scope: 'email', identifier }, nextState(rows[0], now, { neverBan }));
        }
      }

      // 3. Mint the token (counts toward the global cap) — last, so it's only inserted on a real send.
      await insertToken((t, p) => c.query(t, p));
      return { sent: true };
    });
  } catch (e) {
    if (isContention(e)) console.warn('[throttle] reserveSend fail-closed (contention):', e.code);
    else console.error('[throttle] reserveSend:', e.message);
    return { sent: false, reason: 'error' }; // no token inserted ⇒ no send
  }
}
