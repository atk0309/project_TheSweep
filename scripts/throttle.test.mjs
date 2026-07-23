// Unit test for the magic-link abuse throttle.
//   • Primary: the pure state machine (no DB) — full escalation ladder.
//   • Optional: cross-identity invariants via gateRequest (requires an explicitly
//     armed TEST_DATABASE_URL).
import { armDestructiveTestDatabase } from './destructive-test-guard.mjs';

process.env.NODE_ENV = 'development';
process.env.ALLOW_INSECURE_DEVELOPMENT = '1';

const runDbTests = Boolean(
  process.env.TEST_DATABASE_URL?.trim()
  || process.env.ALLOW_DESTRUCTIVE_DB_TESTS
  || process.env.ALLOW_REMOTE_DESTRUCTIVE_DB_TESTS,
);

if (runDbTests) {
  armDestructiveTestDatabase('throttle.test');
} else {
  // Never let an ambient application DATABASE_URL opt the unit test into
  // destructive DB coverage. The DB branch only accepts TEST_DATABASE_URL.
  delete process.env.DATABASE_URL;
}

const {
  isBlocked,
  nextState,
  MAX_PER_BURST,
  canonicalIp,
  gateRequest,
  reserveSend,
} = await import('../server/throttle.js');

function eq(label, got, want) {
  const ok = got === want;
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${got}${ok ? '' : ' (expected ' + want + ')'}`);
  if (!ok) process.exitCode = 1;
}

// Faithful in-memory mirror of how gateRequest persists a row: cooldown_until is
// computed from cooldownMinutes / clearCooldown exactly like the SQL CASE.
function apply(row, now) {
  const ns = nextState(row, now);
  let cooldown_until = row.cooldown_until;
  if (ns.cooldownMinutes != null) cooldown_until = new Date(now.getTime() + ns.cooldownMinutes * 60_000);
  else if (ns.clearCooldown) cooldown_until = null;
  // sanity: a set cooldown is always a finite future time (guards the NaN-cooldown footgun)
  if (ns.cooldownMinutes != null && Number.isNaN(cooldown_until.getTime())) { eq('cooldown is a valid date', false, true); }
  return { attempts: ns.attempts, strikes: ns.strikes, banned: ns.banned, cooldown_until };
}

// Simulate one incoming request: block-check first (like gateRequest phase 1), then
// record on a miss (phase 2). Returns { row, allowed }.
function request(row, now) {
  if (isBlocked(row, now)) return { row, allowed: false };
  return { row: apply(row, now), allowed: true };
}

console.log('THROTTLE STATE MACHINE');
eq('MAX_PER_BURST', MAX_PER_BURST, 5);
eq('canonical IPv4', canonicalIp('203.0.113.7'), '203.0.113.7');
eq('canonical expanded IPv6', canonicalIp('2001:0db8:0:0:0:0:0:1'), '2001:db8::1');
eq('canonical IPv4-mapped IPv6', canonicalIp('::ffff:192.0.2.1'), '192.0.2.1');
eq('reject forwarded IP list', canonicalIp('198.51.100.1, 203.0.113.7'), '');
eq('reject oversized IP text', canonicalIp('1'.repeat(65)), '');

let row = { attempts: 0, strikes: 0, banned: false, cooldown_until: null };
const t0 = new Date('2026-06-24T12:00:00Z');
let allowedTotal = 0;

// ── Burst 1: 5 allowed, 6th blocked, 15-min cooldown ──────────────────────
for (let i = 1; i <= 5; i++) {
  const r = request(row, t0); row = r.row;
  eq(`burst1 attempt ${i} allowed`, r.allowed, true);
  if (r.allowed) allowedTotal++;
}
eq('after 5: strikes=1', row.strikes, 1);
eq('after 5: cooling', isBlocked(row, t0), true);
eq('burst1 6th blocked', request(row, t0).allowed, false);

// cooldown is ~15 minutes from the 5th attempt
eq('burst1 cooldown ≈15m', Math.round((row.cooldown_until - t0) / 60000), 15);

// ── Burst 2: after the 15-min cooldown, 5 allowed, then 1-hour cooldown ────
const t1 = new Date(t0.getTime() + 15 * 60_000 + 1_000);
eq('after cooldown: not blocked', isBlocked(row, t1), false);
for (let i = 1; i <= 5; i++) {
  const r = request(row, t1); row = r.row;
  eq(`burst2 attempt ${i} allowed`, r.allowed, true);
  if (r.allowed) allowedTotal++;
}
eq('after 10: strikes=2', row.strikes, 2);
eq('burst2 cooldown ≈60m', Math.round((row.cooldown_until - t1) / 60000), 60);
eq('burst2 next blocked', request(row, t1).allowed, false);

// ── Burst 3: after the 1-hour cooldown, 5 allowed, then PERMANENT ban ──────
const t2 = new Date(t1.getTime() + 60 * 60_000 + 1_000);
eq('after 1h: not blocked', isBlocked(row, t2), false);
for (let i = 1; i <= 5; i++) {
  const r = request(row, t2); row = r.row;
  eq(`burst3 attempt ${i} allowed`, r.allowed, true);
  if (r.allowed) allowedTotal++;
}
eq('after 15: strikes=3', row.strikes, 3);
eq('banned', row.banned, true);
eq('banned clears cooldown', row.cooldown_until, null);
eq('total real attempts before ban', allowedTotal, 15);

// ── A retained ban remains blocked even far in the future ─────────────────
const tFar = new Date(t2.getTime() + 1000 * 60 * 60_000);
eq('ban blocks immediately', request(row, t2).allowed, false);
eq('ban blocks far future', isBlocked(row, tFar), true);

// ── neverBan (admin recipient): cooldown-only, never permabans ─────────────
const atThreshold = { attempts: 4, strikes: 2, banned: false, cooldown_until: null };
const nb = nextState(atThreshold, t0, { neverBan: true });
eq('neverBan: not banned at the ban threshold', nb.banned, false);
eq('neverBan: caps at the 60m cooldown rung', nb.cooldownMinutes, 60);
eq('default (no neverBan): bans at the threshold', nextState(atThreshold, t0).banned, true);

// ── Optional DB-backed gate behaviour & cross-identity invariants ─────────
if (runDbTests) {
  console.log('\nGATE BEHAVIOUR (DB)');
  const { pool, query } = await import('../server/db.js');
  const { config } = await import('../server/config.js');
  if (!pool) throw new Error('TEST_DATABASE_URL did not create a database pool');
  const ip = '203.0.113.7';
  const cookie = 'a'.repeat(32);
  const freshCookie = 'b'.repeat(32);
  const email = 'gatetest@example.test';
  const freshEmail = 'fresh_gatetest@example.test';
  const adminEmail = 'adminreserve@example.test';
  const allIds = [ip, cookie, freshCookie, email, freshEmail, adminEmail];
  const wipe = () => query('DELETE FROM auth_throttle WHERE identifier = ANY($1)', [[...allIds]]);
  // expire every active cooldown so the next calls open a fresh burst
  const fastForward = () => query("UPDATE auth_throttle SET cooldown_until = now() - interval '1 second' WHERE cooldown_until IS NOT NULL AND identifier = ANY($1)", [[...allIds]]);
  // the magic_tokens row a real send writes (unique token_hash per call)
  const mkInsert = (tag) => (q) => q("INSERT INTO magic_tokens (email, token_hash, expires_at) VALUES ('rs@test.io',$1, now()+interval '15 min')", [tag]);
  await wipe();
  await query('DELETE FROM magic_tokens');

  // Burst 1: 5 allowed (ip + cookie counted together), 6th blocked by the cooldown.
  let blocked = [];
  for (let i = 0; i < 6; i++) blocked.push((await gateRequest({ ip, cookieId: cookie, email })).blocked);
  eq('gate burst1: first 5 allowed', blocked.slice(0, 5).every((b) => b === false), true);
  eq('gate burst1: 6th blocked', blocked[5], true);

  // M1: the gate must NOT create an email row (email is recorded only post-send).
  const emailRowAfterGate = (await query("SELECT 1 FROM auth_throttle WHERE scope='email' AND identifier=$1", [email])).rows;
  eq('gate does not create email rows', emailRowAfterGate.length, 0);

  // no-count-on-blocked: a blocked call (same cooling ip) with a brand-new cookie/email creates no rows.
  const b2 = (await gateRequest({ ip, cookieId: freshCookie, email: freshEmail })).blocked;
  eq('block-if-ANY (cooling ip blocks fresh cookie/email)', b2, true);
  const freshCookieRow = (await query("SELECT 1 FROM auth_throttle WHERE scope='cookie' AND identifier=$1", [freshCookie])).rows;
  eq('blocked request created no fresh-cookie row', freshCookieRow.length, 0);

  // Escalate to a retained ban via fast-forward (15m → 1h → ban).
  await fastForward();
  for (let i = 0; i < 5; i++) await gateRequest({ ip, cookieId: cookie, email }); // burst 2 → strike 2 (1h)
  await fastForward();
  for (let i = 0; i < 5; i++) await gateRequest({ ip, cookieId: cookie, email }); // burst 3 → ban
  const ipRow = (await query("SELECT strikes, banned FROM auth_throttle WHERE scope='ip' AND identifier=$1", [ip])).rows[0];
  eq('ip strikes=3', ipRow?.strikes, 3);
  eq('ip marked banned', ipRow?.banned, true);

  // block-if-ANY against a retained ban: fresh cookie/email + banned ip → still blocked.
  const b3 = (await gateRequest({ ip, cookieId: freshCookie, email: freshEmail })).blocked;
  eq('banned ip blocks fresh cookie/email', b3, true);

  console.log('\nEMAIL-SCOPE RESERVE (DB)');
  await query("DELETE FROM auth_throttle WHERE scope='email' AND identifier=$1", [email]);
  const emailSent = [];
  for (let i = 0; i < 7; i++) emailSent.push((await reserveSend({ email, reserveEmail: true, enforceCap: false, insertToken: mkInsert('es' + i) })).sent);
  eq('email reserve: first 5 sent', emailSent.slice(0, 5).every((s) => s === true), true);
  eq('email reserve: 6th blocked', emailSent[5], false);
  const er = (await query("SELECT attempts, strikes, cooldown_until FROM auth_throttle WHERE scope='email' AND identifier=$1", [email])).rows[0];
  eq('email strikes=1 after 5 reserves', er?.strikes, 1);
  eq('email cooling after 5 reserves', er?.cooldown_until !== null, true);

  // Concurrency: 12 parallel reserves for one recipient → exactly 5 actually sent.
  await query("DELETE FROM auth_throttle WHERE scope='email' AND identifier=$1", [freshEmail]);
  const concEmail = await Promise.all(Array.from({ length: 12 }, (_, i) =>
    reserveSend({ email: freshEmail, reserveEmail: true, enforceCap: false, insertToken: mkInsert('ce' + i) })));
  eq('parallel email reserves: exactly 5 sent', concEmail.filter((r) => r.sent).length, 5);

  console.log('\nGLOBAL CAP ATOMICITY (DB)');
  const cap = config.sendCapHour;
  await query('DELETE FROM magic_tokens');
  // preload cap-2 recent tokens, then fire 8 parallel reservations — exactly 2 must win.
  await query(
    "INSERT INTO magic_tokens (email, token_hash, expires_at) SELECT 'pre@test.io','pre'||g, now()+interval '15 min' FROM generate_series(1,$1) g",
    [cap - 2],
  );
  const capRes = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    reserveSend({ enforceCap: true, reserveEmail: false, insertToken: mkInsert('cap' + i) })));
  eq('parallel global reserves: exactly 2 succeed', capRes.filter((r) => r.sent).length, 2);
  const total = Number((await query("SELECT count(*) c FROM magic_tokens WHERE created_at > now() - interval '1 hour'")).rows[0].c);
  eq('no cap overshoot (total == cap)', total, cap);

  // Round-2 Fix A: with the cap full, a registered recipient is cap-blocked WITHOUT
  // consuming its email ladder (no row created / no increment).
  console.log('\nROUND-2 P2: capped request does not burn the email ladder');
  await query("DELETE FROM auth_throttle WHERE scope='email' AND identifier=$1", [email]);
  const capped = [];
  for (let i = 0; i < 3; i++) capped.push(await reserveSend({ email, reserveEmail: true, enforceCap: true, insertToken: mkInsert('x' + i) }));
  eq('capped requests not sent', capped.every((r) => !r.sent), true);
  eq('capped requests report global_cap', capped.every((r) => r.reason === 'global_cap'), true);
  const emailAfterCap = (await query("SELECT 1 FROM auth_throttle WHERE scope='email' AND identifier=$1", [email])).rows;
  eq('capped requests did NOT create/increment the email row', emailAfterCap.length, 0);
  await query('DELETE FROM magic_tokens');

  // Round-2 Fix B: an admin recipient escalates cooldown-only and is never permabanned.
  console.log('\nROUND-2 P1: admin recipient is cooldown-only (never permaban)');
  await query("DELETE FROM auth_throttle WHERE scope='email' AND identifier=$1", [adminEmail]);
  for (let burst = 0; burst < 4; burst++) {
    for (let i = 0; i < 5; i++) await reserveSend({ email: adminEmail, reserveEmail: true, neverBan: true, enforceCap: false, insertToken: mkInsert('ad' + burst + '_' + i) });
    await query("UPDATE auth_throttle SET cooldown_until = now() - interval '1 second' WHERE scope='email' AND identifier=$1 AND cooldown_until IS NOT NULL", [adminEmail]);
  }
  const adminRow = (await query("SELECT strikes, banned FROM auth_throttle WHERE scope='email' AND identifier=$1", [adminEmail])).rows[0];
  eq('admin email never banned (after 20 reserves)', adminRow?.banned, false);
  eq('admin email escalated (strikes >= 3)', adminRow?.strikes >= 3, true);
  await query('DELETE FROM magic_tokens');

  await wipe();
  await pool.end();
} else {
  console.log('\n(DB gate invariants skipped — TEST_DATABASE_URL not armed)');
}

console.log(process.exitCode ? '\nTHROTTLE TEST FAIL ❌' : '\nTHROTTLE TEST PASS ✅');
