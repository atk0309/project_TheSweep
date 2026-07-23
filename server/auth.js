// Hand-rolled passwordless magic-link auth. The server is the only DB client.
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from './config.js';
import { query } from './db.js';
import { sendMagicLink } from './mailer.js';
import { canonicalIp, gateRequest, reserveSend } from './throttle.js';

const COOKIE = 'sweep_session';
const AID_COOKIE = 'sweep_aid'; // dedicated anti-abuse id (the session cookie doesn't exist pre-login)
const TOKEN_TTL_MIN = 15;
const SESSION_DAYS = 30;
const TOKEN_PURPOSE = {
  LOGIN: 'login',
  INVITE: 'invite',
};
const TOKEN_PREFIX = {
  [TOKEN_PURPOSE.LOGIN]: 'l_',
  [TOKEN_PURPOSE.INVITE]: 'i_',
};
const TOKEN_RANDOM_RE = /^[A-Za-z0-9_-]{43}$/; // randomBytes(32).toString('base64url')

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
export const isConfiguredAdmin = (email, adminEmails = config.adminEmails) => adminEmails.includes(normEmail(email));

// Purpose is part of the bearer value that is hashed into token_hash. Changing
// "l_" to "i_" therefore invalidates the token; no schema column is needed. The
// exact new-token length keeps legacy unprefixed tokens classified as logins,
// while the base64url-safe format remains compatible with local E2E log parsing.
export function magicTokenPurpose(rawToken) {
  const token = String(rawToken || '');
  const randomPart = token.slice(TOKEN_PREFIX[TOKEN_PURPOSE.INVITE].length);
  return token.startsWith(TOKEN_PREFIX[TOKEN_PURPOSE.INVITE]) && TOKEN_RANDOM_RE.test(randomPart)
    ? TOKEN_PURPOSE.INVITE
    : TOKEN_PURPOSE.LOGIN;
}

export function canPlayerSelfRequest(player, configuredAdmin = false) {
  return !!configuredAdmin || (!!player && !player.removed);
}

export function canReactivatePlayer(player, { configuredAdmin = false, purpose = TOKEN_PURPOSE.LOGIN } = {}) {
  return !!player && (!player.removed || configuredAdmin || purpose === TOKEN_PURPOSE.INVITE);
}

// ── Sessions (stateless HS256 JWT in an httpOnly cookie) ──────────────────
function setSession(res, playerId) {
  const token = jwt.sign({ sub: playerId }, config.sessionSecret, { algorithm: 'HS256', expiresIn: `${SESSION_DAYS}d` });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 24 * 3600 * 1000,
  });
}
function clearSession(res) {
  res.clearCookie(COOKIE, { path: '/' });
}

// Resolve the player from the cookie on every request (live revocation).
async function playerFromReq(req) {
  const raw = req.cookies?.[COOKIE];
  if (!raw) return null;
  let payload;
  try {
    payload = jwt.verify(raw, config.sessionSecret, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
  const { rows } = await query(
    'SELECT id, email, display_name, monogram_color, is_admin, removed FROM players WHERE id=$1',
    [payload.sub],
  );
  let p = rows[0];
  if (!p || p.removed) return null; // removed/deleted ⇒ session invalid
  // ADMIN_EMAILS is the source of truth, not a one-way promotion list. This
  // demotes an existing session on its very next authenticated request.
  const shouldBeAdmin = isConfiguredAdmin(p.email);
  if (p.is_admin !== shouldBeAdmin) {
    await query('UPDATE players SET is_admin=$1 WHERE id=$2', [shouldBeAdmin, p.id]);
    p = { ...p, is_admin: shouldBeAdmin };
  }
  return p;
}

// Resolve the player (or null) without 401 — used by /api/state.
export async function optionalAuthResolve(req) {
  try { return await playerFromReq(req); } catch { return null; }
}

// Middleware ----------------------------------------------------------------
export function optionalAuth() {
  return async (req, _res, next) => {
    try { req.player = await playerFromReq(req); } catch { req.player = null; }
    next();
  };
}
export function requireAuth() {
  return async (req, res, next) => {
    try {
      req.player = await playerFromReq(req);
    } catch (e) {
      return res.status(500).json({ error: 'auth_error' });
    }
    if (!req.player) return res.status(401).json({ error: 'unauthorized' });
    next();
  };
}
export function requireAdmin() {
  return async (req, res, next) => {
    try {
      req.player = await playerFromReq(req);
    } catch {
      return res.status(500).json({ error: 'auth_error' });
    }
    if (!req.player) return res.status(401).json({ error: 'unauthorized' });
    if (!req.player.is_admin) return res.status(403).json({ error: 'forbidden' });
    next();
  };
}

// Reject cross-site POSTs (cookie auto-sent). Lax cookie + this = CSRF-safe.
export function sameOrigin() {
  return (req, res, next) => {
    const origin = req.get('origin') || req.get('referer') || '';
    if (!origin) return next(); // same-origin form posts may omit Origin
    try {
      const host = new URL(origin).host;
      const appHost = new URL(config.appUrl).host;
      const reqHost = req.get('host');
      if (host === appHost || host === reqHost) return next();
    } catch { /* fall through */ }
    return res.status(403).json({ error: 'bad_origin' });
  };
}

// ── Request identity (for the abuse throttle) ──────────────────────────────
// Railway's proxy-derived req.ip is the trusted input configured by Express.
// Never prefer CF-Connecting-IP: the Railway origin is directly reachable, so a
// direct caller can forge that raw header. Canonicalization also bounds DB keys.
export function clientIp(req) {
  return canonicalIp(req?.ip);
}

const signAid = (id) => crypto.createHmac('sha256', config.sessionSecret).update(id).digest('hex');

// Read the anti-abuse cookie. Only a validly-signed value counts as the cookie
// identity — so a cookie-less / forged-cookie script can't mint unbounded rows
// (it's bounded by IP + email + the global cap instead). Absent/forged ⇒ mint a
// fresh signed cookie for honest browsers and return null (not counted this hit).
function readSignedCookie(req, res) {
  const raw = req.cookies?.[AID_COOKIE];
  if (raw && raw.includes('.')) {
    const [id, sig] = raw.split('.');
    if (/^[a-f0-9]{32}$/.test(id) && sig) {
      const expect = signAid(id);
      if (sig.length === expect.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {
        return id;
      }
    }
  }
  const id = crypto.randomBytes(16).toString('hex');
  res.cookie(AID_COOKIE, `${id}.${signAid(id)}`, {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    path: '/',
    maxAge: 365 * 24 * 3600 * 1000, // 1 year
  });
  return null;
}

async function playerForEmail(email) {
  const { rows } = await query('SELECT id, removed FROM players WHERE email=$1', [email]);
  return rows[0] || null;
}

// reserveEmail ⇒ bound the recipient (email) ladder; neverBan ⇒ cooldown-only (admin
// addresses can't be banned); enforceCap=false ⇒ exempt from the global
// cap BLOCK (admin break-glass + trusted admin invites). The cap check, email reservation,
// and token insert all happen atomically in reserveSend so the email slot is consumed only
// when a link is actually issued.
async function issueMagicLink(email, ip, { invite = false, reserveEmail = false, neverBan = false, enforceCap = true } = {}) {
  const purpose = invite ? TOKEN_PURPOSE.INVITE : TOKEN_PURPOSE.LOGIN;
  const rawToken = `${TOKEN_PREFIX[purpose]}${crypto.randomBytes(32).toString('base64url')}`;
  const expires = new Date(Date.now() + TOKEN_TTL_MIN * 60 * 1000);
  const requestIp = canonicalIp(ip);
  const insertToken = (q) => q(
    'INSERT INTO magic_tokens (email, token_hash, expires_at, request_ip) VALUES ($1,$2,$3,$4)',
    [email, sha256(rawToken), expires, requestIp || null],
  );
  const r = await reserveSend({ email, reserveEmail, neverBan, enforceCap, insertToken });
  if (!r.sent) {
    if (r.reason === 'global_cap') console.warn('[throttle] global send cap hit — skipping delivery');
    return { sent: false, reason: r.reason };
  }
  const url = `${config.appUrl}/auth/verify?token=${encodeURIComponent(rawToken)}`;
  const delivery = await sendMagicLink(email, url, { invite });
  if (!delivery.ok) return { sent: false, reason: delivery.error || 'delivery_failed' };
  return { sent: true };
}

// Invite-only gate. Two callers:
//   • admin /api/invite (adminInvite:true) — the ONLY way to create a new player.
//   • public /auth/request — re-login for already-invited people (+ admin bootstrap).
// An un-invited self-request is a silent no-op (no enumeration leak).
export async function requestMagicLink(email, ip, { adminInvite = false } = {}) {
  const e = normEmail(email);
  if (!validEmail(e)) return { ok: false, reason: 'invalid_email' };
  const isAdminEmail = isConfiguredAdmin(e);

  if (adminInvite) {
    // Create the allowlist row up-front (display_name stays NULL ⇒ pending:
    // invisible in the lobby and excluded from the draw until they onboard).
    // Keep the configured admin role authoritative, but never silently un-remove
    // a removed player; reactivation happens only when this invite is confirmed.
    await query(
      `INSERT INTO players (email, is_admin) VALUES ($1,$2)
       ON CONFLICT (email) DO UPDATE SET is_admin=excluded.is_admin`,
      [e, isAdminEmail],
    );
    // Admin-initiated invites are trusted: not cap-blocked, recipient not throttled. Surface
    // a failed send (e.g. reserveSend fails closed) as ok:false so /api/invite reports the
    // failure instead of logging a phantom "Invite sent" for a link that never went out.
    const r = await issueMagicLink(e, ip, { invite: true, reserveEmail: false, enforceCap: false });
    return r.sent ? { ok: true, sent: true } : { ok: false, reason: r.reason || 'send_failed' };
  }

  const player = isAdminEmail ? null : await playerForEmail(e);
  return issueSelfMagicLink(e, ip, player, isAdminEmail);
}

async function issueSelfMagicLink(email, ip, player, isAdminEmail) {
  // Self-request: only active players (re-login) or configured admins
  // (self-bootstrap/reactivation) get a link. A removed non-admin needs a new,
  // purpose-bound admin invite and cannot undo removal through this public route.
  if (!canPlayerSelfRequest(player, isAdminEmail)) return { ok: true, sent: false }; // silent
  // Admin addresses are throttled cooldown-only and exempt from the cap block (never locked
  // out); known non-admin recipients get the full email ladder + global cap.
  const r = isAdminEmail
    ? await issueMagicLink(email, ip, { reserveEmail: true, neverBan: true, enforceCap: false })
    : await issueMagicLink(email, ip, { reserveEmail: true });
  return { ok: true, sent: r.sent };
}

// ── Routes ─────────────────────────────────────────────────────────────────
export function registerAuthRoutes(app) {
  // Request a magic link.
  app.post('/auth/request', async (req, res) => {
    const email = normEmail(req.body?.email);
    const ip = clientIp(req);
    if (!validEmail(email)) return res.status(400).json({ error: 'invalid_email' });

    // Admin addresses skip the IP/cookie gate so the owner can NEVER be locked out by a
    // banned/cooling requestor identity (block-if-ANY) — otherwise they couldn't reach
    // /api/throttle/clear to recover. They stay bounded downstream instead: the admin
    // recipient ladder is cooldown-only (reserveSend neverBan), capping admin@ at ~5 per
    // cooldown window rather than leaving it an unlimited relay.
    //
    // ACCEPTED TRADE-OFF: a public, fixed-address email endpoint can't be both
    // abuse-bounded AND always-available to the owner. Someone who knows an admin address
    // can spend its burst and park it in a ≤1h cooldown. Recovery is out-of-band — the SQL
    // escape `DELETE FROM auth_throttle WHERE scope='email' AND identifier='<admin>'`
    // (Railway DB console), or /api/throttle/clear with an existing session. We deliberately
    // do NOT fully exempt admin@ from throttling, since that would make it an unbounded relay.
    const isAdminEmail = isConfiguredAdmin(email);
    let player = null;
    if (!isAdminEmail) {
      const aid = readSignedCookie(req, res); // null if absent/forged (minted on res)
      try {
        player = await playerForEmail(email);
      } catch (e) {
        console.error('[auth/request eligibility]', e.message);
        return res.json({ ok: true, message: 'Check your email.' });
      }
      // Unknown and removed recipients cannot cause persistent IP/cookie rows.
      // They receive the same response (and anti-abuse cookie) as active players.
      if (!canPlayerSelfRequest(player, false)) {
        return res.json({ ok: true, message: 'Check your email.' });
      }
      const gate = await gateRequest({ ip, cookieId: aid, email })
        .catch((e) => { console.error('[throttle] gate', e.message); return { blocked: false }; });
      if (gate.blocked) {
        return res.json({ ok: true, message: 'Check your email.' }); // silent — no limit/enumeration leak
      }
    }

    try {
      if (isAdminEmail) await requestMagicLink(email, ip);
      else await issueSelfMagicLink(email, ip, player, false);
    } catch (e) {
      console.error('[auth/request]', e.message);
    }
    return res.json({ ok: true, message: 'Check your email.' });
  });

  // Verify: render an interstitial — does NOT consume the token (beats scanners).
  app.get('/auth/verify', (req, res) => {
    const token = String(req.query.token || '');
    res.set('Cache-Control', 'no-store');
    res.type('html').send(interstitialHtml(token));
  });

  // Confirm: the interstitial button POSTs here — consume + session.
  app.post('/auth/confirm', async (req, res) => {
    const token = String(req.body?.token || '');
    if (!token) return res.status(400).type('html').send(resultHtml('Invalid link', 'That link is missing its token.'));
    const purpose = magicTokenPurpose(token);
    try {
      const { rows } = await query(
        `UPDATE magic_tokens SET used_at=now()
         WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()
         RETURNING email`,
        [sha256(token)],
      );
      if (rows.length === 0) {
        return res.status(400).type('html').send(resultHtml('Link expired', 'This link was already used or has expired. Request a fresh one.'));
      }
      const email = rows[0].email;
      const isAdminEmail = isConfiguredAdmin(email);

      const existing = await query('SELECT id, is_admin, removed FROM players WHERE email=$1', [email]);
      let playerId;
      if (existing.rows.length) {
        const p = existing.rows[0];
        if (!canReactivatePlayer(p, { configuredAdmin: isAdminEmail, purpose })) {
          return res.status(403).type('html').send(resultHtml('Invite required', 'This account was removed. Ask the organiser to send a new invitation.'));
        }
        playerId = p.id;
        // ADMIN_EMAILS is authoritative in both directions. Reactivation is
        // allowed only by a configured admin login or a purpose-bound invite.
        if (p.is_admin !== isAdminEmail || p.removed) {
          await query('UPDATE players SET is_admin=$2, removed=false WHERE id=$1', [playerId, isAdminEmail]);
        }
      } else if (isAdminEmail) {
        // Admin self-bootstrap (e.g. fresh/wiped DB) — admins never need an invite.
        const ins = await query(
          'INSERT INTO players (email, is_admin) VALUES ($1,true) RETURNING id',
          [email],
        );
        playerId = ins.rows[0].id;
      } else {
        // Invite-only: no player row ⇒ they were never invited.
        return res.status(403).type('html').send(resultHtml('Invite required', 'The Sweep is invite-only. Ask the organiser to send you an invitation — then use the link in that email.'));
      }
      setSession(res, playerId);
      return res.redirect(302, config.appUrl + '/');
    } catch (e) {
      console.error('[auth/confirm]', e.message);
      return res.status(500).type('html').send(resultHtml('Something broke', 'Try requesting a new link.'));
    }
  });

  app.post('/auth/logout', (_req, res) => {
    clearSession(res);
    res.redirect(302, config.appUrl + '/');
  });
}

// ── Tiny on-brand HTML for the auth interstitial / result pages ───────────
function shell(inner) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>The Sweep</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:radial-gradient(120% 80% at 50% 0%,#0a2014,#05100a 55%,#030a06);font-family:system-ui,Arial,sans-serif;color:#eafff0;">
<div style="max-width:360px;padding:32px;text-align:center;">${inner}</div></body></html>`;
}
function interstitialHtml(token) {
  const safe = String(token).replace(/"/g, '&quot;');
  return shell(`
    <div style="font-size:12px;letter-spacing:4px;color:#7fbf98;">WORLD FOOTBALL 2026</div>
    <div style="font-size:40px;font-weight:800;line-height:.9;margin:4px 0 22px;">THE SWEEP<span style="color:#16ff7a;">.</span></div>
    <p style="color:#bfe9cd;font-size:15px;line-height:1.4;margin-bottom:22px;">You're one tap from the lobby.</p>
    <form method="POST" action="/auth/confirm">
      <input type="hidden" name="token" value="${safe}">
      <button type="submit" style="width:100%;height:54px;border:none;border-radius:14px;background:#16ff7a;color:#022a14;font-weight:800;font-size:19px;cursor:pointer;">Sign in →</button>
    </form>
    <p style="color:#5f7768;font-size:12px;margin-top:16px;">This link works once and expires in 15 minutes.</p>`);
}
function resultHtml(title, msg) {
  return shell(`
    <div style="font-size:34px;font-weight:800;margin-bottom:10px;">${title}</div>
    <p style="color:#bfe9cd;font-size:15px;line-height:1.4;">${msg}</p>
    <a href="${config.appUrl}/" style="display:inline-block;margin-top:20px;color:#16ff7a;font-weight:700;text-decoration:none;">← Back to The Sweep</a>`);
}
