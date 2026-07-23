// Admin-only routes: status flow, join-code, invites, manual score override,
// player removal, force-refresh. All guarded by requireAdmin + sameOrigin.
import crypto from 'node:crypto';
import { query, tx } from './db.js';
import { requireAdmin, sameOrigin, requestMagicLink, normEmail } from './auth.js';
import { logAudit } from './api.js';

const STATUS_FLOW = ['registration_open', 'drawn', 'in_progress', 'complete', 'archived'];
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const FINAL = new Set(['FT', 'AET', 'PEN']);

function randomCode(n = 6) {
  let s = '';
  for (let i = 0; i < n; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return s;
}

export function registerAdminRoutes(app) {
  // Advance the game status (forward-only; the draw itself sets 'drawn').
  app.post('/api/status', sameOrigin(), requireAdmin(), async (req, res) => {
    const target = String(req.body?.status || '');
    if (!STATUS_FLOW.includes(target)) return res.status(400).json({ error: 'bad_status' });
    const cur = (await query('SELECT status FROM game WHERE id=1')).rows[0]?.status;
    if (STATUS_FLOW.indexOf(target) < STATUS_FLOW.indexOf(cur)) return res.status(409).json({ error: 'no_going_back' });
    if (target !== 'registration_open') {
      const drawn = (await query('SELECT 1 FROM allocations LIMIT 1')).rows.length > 0;
      if (!drawn) return res.status(409).json({ error: 'draw_first' });
    }
    await query('UPDATE game SET status=$1 WHERE id=1', [target]);
    await logAudit('Status → ' + target.replace('_', ' '), { actorId: req.player.id });
    res.json({ ok: true });
  });

  // Rotate the join code.
  app.post('/api/regen-code', sameOrigin(), requireAdmin(), async (req, res) => {
    const code = randomCode();
    await query('UPDATE game SET join_code=$1 WHERE id=1', [code]);
    await logAudit('Join code regenerated → ' + code, { actorId: req.player.id });
    res.json({ ok: true, code });
  });

  // Admin invite — the ONLY way to add a new player. Creates a pending allowlist
  // row + sends an invitation link. Locked to registration_open: a post-draw
  // joiner would onboard but own zero teams (allocation already ran).
  app.post('/api/invite', sameOrigin(), requireAdmin(), async (req, res) => {
    const email = String(req.body?.email || '').trim();
    try {
      const status = (await query('SELECT status FROM game WHERE id=1')).rows[0]?.status;
      if (status !== 'registration_open') return res.status(409).json({ error: 'locked' });
      const r = await requestMagicLink(email, req.ip, { adminInvite: true });
      if (!r.ok) return res.status(400).json({ error: r.reason || 'invite_failed' });
      await logAudit('Invite sent · ' + email.trim().toLowerCase(), { actorId: req.player.id });
      res.json({ ok: true });
    } catch (e) {
      console.error('[api/invite]', e.message);
      res.status(500).json({ error: 'invite_error' });
    }
  });

  // ── Magic-link abuse throttle: inspect + clear (unban / reset cooldown) ──
  // Live view of who's currently cooling down or banned.
  app.get('/api/throttle', requireAdmin(), async (_req, res) => {
    try {
      const { rows } = await query(
        `SELECT scope, identifier, attempts, strikes, cooldown_until, banned, updated_at
           FROM auth_throttle
          WHERE banned OR cooldown_until > now()
          ORDER BY updated_at DESC
          LIMIT 200`,
      );
      res.json({ ok: true, rows });
    } catch (e) {
      console.error('[api/throttle]', e.message);
      res.status(500).json({ error: 'throttle_error' });
    }
  });

  // Clear one identity's throttle state (the unban / break-glass path).
  app.post('/api/throttle/clear', sameOrigin(), requireAdmin(), async (req, res) => {
    const scope = String(req.body?.scope || '');
    if (!['ip', 'cookie', 'email'].includes(scope)) return res.status(400).json({ error: 'bad_scope' });
    // Match how rows are stored: email identifiers are normalized (trim+lowercase).
    const identifier = scope === 'email'
      ? normEmail(req.body?.identifier)
      : String(req.body?.identifier || '').trim();
    if (!identifier) return res.status(400).json({ error: 'bad_identifier' });
    try {
      const r = await query('DELETE FROM auth_throttle WHERE scope=$1 AND identifier=$2', [scope, identifier]);
      // Keep the attacker-influenced value out of the free-text action — structured detail only.
      await logAudit('Throttle cleared', { actorId: req.player.id, detail: { scope, identifier } });
      res.json({ ok: true, cleared: r.rowCount });
    } catch (e) {
      console.error('[api/throttle/clear]', e.message);
      res.status(500).json({ error: 'throttle_error' });
    }
  });

  // Manual score override — authoritative (source='manual', poller won't clobber).
  app.post('/api/match/:id/override', sameOrigin(), requireAdmin(), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
    const hg = Math.max(0, Number(req.body?.home_goals) || 0);
    const ag = Math.max(0, Number(req.body?.away_goals) || 0);
    const status = String(req.body?.status || 'FT').toUpperCase();
    const fx = (await query('SELECT id, home_team_id, away_team_id, round_ord FROM fixtures WHERE id=$1', [id])).rows[0];
    if (!fx) return res.status(404).json({ error: 'no_fixture' });
    let winner = null;
    if (FINAL.has(status) && hg !== ag) winner = hg > ag ? fx.home_team_id : fx.away_team_id;
    await query(
      `UPDATE fixtures SET home_goals=$1, away_goals=$2, status=$3, winner_team_id=$4, source='manual', updated_at=now() WHERE id=$5`,
      [hg, ag, status, winner, id]);
    await logAudit('Match override · fixture ' + id + ' · ' + hg + '–' + ag + ' (' + status + ')', { actorId: req.player.id });
    res.json({ ok: true });
  });

  // Remove a player (pre-draw only — post-draw removal would orphan teams).
  app.post('/api/player/:id/remove', sameOrigin(), requireAdmin(), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'bad_id' });
    const status = (await query('SELECT status FROM game WHERE id=1')).rows[0]?.status;
    if (status !== 'registration_open') return res.status(409).json({ error: 'locked' });
    if (id === req.player.id) return res.status(409).json({ error: 'cannot_remove_self' });
    const p = await tx(async (c) => {
      const player = (await c.query(
        'SELECT display_name, email FROM players WHERE id=$1 FOR UPDATE',
        [id],
      )).rows[0];
      if (!player) return null;
      await c.query('UPDATE players SET removed=true WHERE id=$1', [id]);
      // A link issued before removal must not undo the removal. New invites are
      // issued after this transaction and remain the explicit reactivation path.
      await c.query(
        'UPDATE magic_tokens SET used_at=now() WHERE email=$1 AND used_at IS NULL',
        [player.email],
      );
      return player;
    });
    await logAudit('Removed player · ' + (p?.display_name || id), { actorId: req.player.id });
    res.json({ ok: true });
  });

  // Full wipe/reset for testing: clears the draw + every other player + audit
  // and reopens registration. The caller (admin) is kept so they stay signed in.
  app.post('/api/reset-game', sameOrigin(), requireAdmin(), async (req, res) => {
    try {
      await tx(async (c) => {
        await c.query('DELETE FROM allocations');
        await c.query('DELETE FROM audit_log');
        await c.query('DELETE FROM players WHERE id <> $1', [req.player.id]);
        await c.query("UPDATE game SET status='registration_open', drawn_at=NULL WHERE id=1");
        await c.query('DELETE FROM magic_tokens');
        await c.query('DELETE FROM auth_throttle');
        await c.query("INSERT INTO audit_log (actor_player_id, actor_label, action) VALUES ($1,'admin','Game wiped & reset')", [req.player.id]);
      });
      res.json({ ok: true });
    } catch (e) {
      console.error('[api/reset-game]', e.message);
      res.status(500).json({ error: 'reset_error' });
    }
  });

  // Force a feed refresh.
  app.post('/api/force-refresh', sameOrigin(), requireAdmin(), async (req, res) => {
    try {
      const { pollNow } = await import('./poller.js');
      await pollNow();
      await logAudit('Force refresh · feed sync', { actorId: req.player.id });
      res.json({ ok: true });
    } catch (e) {
      console.error('[api/force-refresh]', e.message);
      res.status(500).json({ error: 'refresh_error' });
    }
  });
}
