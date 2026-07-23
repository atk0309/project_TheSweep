// Core API: /api/state (per-user snapshot), onboard, the atomic draw, reset.
import crypto from 'node:crypto';
import { config } from './config.js';
import { query, tx } from './db.js';
import { requireAuth, requireAdmin, sameOrigin, optionalAuthResolve } from './auth.js';
import { computeLeaderboard, initialsOf, SCORING_RULES } from './scoring.js';

export const MONO_COLORS = ['#00e676', '#ff4d6d', '#3b8cff', '#ffb020', '#b46bff', '#19d3da', '#ff7a3b', '#a3e635'];

// Crypto Fisher-Yates (unbiased) in place.
function cryptoShuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function logAudit(action, { actorId = null, actorLabel = 'admin', detail = null, client = null } = {}) {
  const q = client || { query };
  await q.query(
    'INSERT INTO audit_log (actor_player_id, actor_label, action, detail) VALUES ($1,$2,$3,$4)',
    [actorId, actorLabel, action, detail ? JSON.stringify(detail) : null],
  );
}

// ── Build the per-user state payload ──────────────────────────────────────
export async function buildState(me) {
  if (!me) throw new Error('authenticated player required');
  const [gameR, playersR, teamsR, allocR, fixturesR, standingsR, eventsR, newsR] = await Promise.all([
    query('SELECT status, join_code, drawn_at FROM game WHERE id=1'),
    query('SELECT id, display_name, monogram_color, is_admin, removed FROM players ORDER BY id'),
    query('SELECT id, idx, code, name, group_letter, flag FROM teams ORDER BY idx'),
    query('SELECT team_id, player_id FROM allocations'),
    query(`SELECT id, stage, round_ord, group_letter, home_team_id, away_team_id, kickoff, elapsed, status,
                   home_goals, away_goals, home_pen, away_pen, winner_team_id, source
            FROM fixtures ORDER BY kickoff NULLS LAST, id`),
    query('SELECT team_id, group_letter, played, w, d, l, gf, ga, points, rank, alive FROM standings'),
    query(`SELECT e.fixture_id, e.minute, e.team_id, e.player, e.type, e.detail
             FROM match_events e ORDER BY e.fixture_id, e.minute`),
    query(`SELECT source, title, url, trail, image, published_at, is_live
             FROM news ORDER BY published_at DESC NULLS LAST LIMIT 24`),
  ]);

  const game = gameR.rows[0] || { status: 'registration_open', join_code: 'SWEEP1' };
  const players = playersR.rows;
  const teams = teamsR.rows;
  const allocations = allocR.rows;
  const fixtures = fixturesR.rows;
  const standings = standingsR.rows;

  const ownerByTeam = new Map(allocations.map((a) => [a.team_id, a.player_id]));
  const playerById = new Map(players.map((p) => [p.id, p]));
  const meId = me?.id ?? null;

  const teamPayload = teams.map((t) => {
    const ownerId = ownerByTeam.get(t.id) ?? null;
    const owner = ownerId ? playerById.get(ownerId) : null;
    return {
      id: t.id, idx: t.idx, code: t.code, name: t.name, group: t.group_letter, flag: t.flag,
      ownerId,
      owner: owner ? { id: owner.id, name: owner.display_name, color: owner.monogram_color, initials: initialsOf(owner.display_name), you: owner.id === meId } : null,
      mine: ownerId === meId,
    };
  });

  const myTeams = teamPayload.filter((t) => t.ownerId === meId);

  // Only onboarded rows are public — a pending invite (display_name NULL) must not
  // leak (not even as a count) to anyone polling /api/state. `me` is delivered
  // separately below, so a just-invited self still routes correctly to onboard.
  const playerPayload = players
    .filter((p) => p.display_name)
    .map((p) => ({
      id: p.id,
      name: p.display_name,
      color: p.monogram_color,
      initials: initialsOf(p.display_name),
      isAdmin: p.is_admin,
      removed: p.removed,
      onboarded: true,
      you: p.id === meId,
    }));
  const participants = playerPayload.filter((p) => !p.removed);

  const leaderboard = computeLeaderboard({ players, allocations, teams, fixtures, standings });

  const state = {
    status: game.status,
    joinCode: game.join_code,
    drawnAt: game.drawn_at,
    me: me
      ? { id: me.id, email: me.email, name: me.display_name, color: me.monogram_color, initials: initialsOf(me.display_name), isAdmin: me.is_admin, onboarded: !!me.display_name }
      : null,
    players: playerPayload,
    participants,
    playerCount: participants.length,
    monoColors: MONO_COLORS,
    teams: teamPayload,
    myTeams,
    leaderboard,
    fixtures: fixtures.map((f) => ({ ...f })),
    standings,
    events: eventsR.rows,
    news: newsR.rows,
    scoringRules: SCORING_RULES.map(([k, v]) => ({ k, v })),
  };

  if (me?.is_admin) {
    const auditR = await query('SELECT action, actor_label, created_at FROM audit_log ORDER BY created_at DESC LIMIT 8');
    state.audit = auditR.rows.map((a) => ({ action: a.action, who: a.actor_label, at: a.created_at }));
  }
  return state;
}

// ── Routes ─────────────────────────────────────────────────────────────────
export function registerApiRoutes(app) {
  const sendState = (req, res, state) => {
    const body = JSON.stringify(state);
    const etag = '"' + crypto.createHash('sha256').update(body).digest('base64url') + '"';
    res.set('ETag', etag);
    if (req.get('if-none-match') === etag) return res.status(304).end();
    return res.type('json').send(body);
  };

  // Keep the landing route enumeration-safe and cheap. The full participant,
  // allocation, fixture, and news snapshot is available only after login.
  app.get('/api/state', async (req, res) => {
    try {
      const me = await optionalAuthResolve(req);
      if (!me) return sendState(req, res, { me: null });
      const state = await buildState(me);
      return sendState(req, res, state);
    } catch (e) {
      console.error('[api/state]', e.message);
      res.status(500).json({ error: 'state_error' });
    }
  });

  // Per-match live commentary (Guardian liveblog blocks). Kept off /api/state so
  // its frequent churn during live matches doesn't bust the whole-state ETag for
  // every polling client — only an open match screen fetches this.
  app.get('/api/commentary/:fixtureId', requireAuth(), async (req, res) => {
    const id = String(req.params.fixtureId);
    if (!/^\d+$/.test(id)) return res.status(400).json({ error: 'bad_id' });
    try {
      // Latest 30 regular blocks PLUS every key event (goals/cards), so an early
      // highlight isn't dropped once 30+ later blocks pile on. Order by MATCH
      // MINUTE (newest-first): Guardian (re)generates key-event/goal blocks at
      // curation time, so their published_at is ~now, not the goal moment —
      // sorting by it scattered goals into the middle of the feed. Blocks with no
      // parsed minute (pre-match/HT/FT summaries) fall back to minutes-since-
      // kickoff, which is monotonic with their real time. published_at + block_id
      // remain tiebreakers (several play-by-play lines share one minute).
      const r = await query(
        `WITH ev AS (
           (SELECT block_id, published_at, title, body, is_key_event, minute
              FROM match_commentary WHERE fixture_id=$1 AND is_key_event=true)
           UNION
           (SELECT block_id, published_at, title, body, is_key_event, minute
              FROM match_commentary WHERE fixture_id=$1 AND is_key_event=false
             ORDER BY published_at DESC NULLS LAST, block_id DESC LIMIT 30)
         )
         SELECT ev.block_id, ev.published_at, ev.title, ev.body, ev.is_key_event, ev.minute
           FROM ev CROSS JOIN fixtures f
          WHERE f.id=$1
          ORDER BY COALESCE(ev.minute, EXTRACT(EPOCH FROM (ev.published_at - f.kickoff)) / 60.0) DESC NULLS LAST,
                   ev.published_at DESC NULLS LAST,
                   ev.block_id DESC`, [id]);
      const body = JSON.stringify({ fixtureId: id, commentary: r.rows });
      const etag = '"' + crypto.createHash('sha256').update(body).digest('base64url') + '"';
      res.set('ETag', etag);
      if (req.get('if-none-match') === etag) return res.status(304).end();
      res.type('json').send(body);
    } catch (e) {
      console.error('[api/commentary]', e.message);
      res.status(500).json({ error: 'commentary_error' });
    }
  });

  // Claim your spot (onboard) — set display name + monogram colour.
  app.post('/api/onboard', sameOrigin(), requireAuth(), async (req, res) => {
    const name = String(req.body?.display_name || '').trim().slice(0, 14);
    const color = String(req.body?.monogram_color || '');
    if (!name) return res.status(400).json({ error: 'name_required' });
    // First-time onboard is locked once the draw has run — a new participant then
    // would own zero teams. (Already-onboarded players may still update freely.)
    if (!req.player.display_name) {
      const status = (await query('SELECT status FROM game WHERE id=1')).rows[0]?.status;
      if (status !== 'registration_open') return res.status(409).json({ error: 'locked' });
    }
    if (!MONO_COLORS.includes(color)) return res.status(400).json({ error: 'bad_color' });
    await query('UPDATE players SET display_name=$1, monogram_color=$2 WHERE id=$3', [name, color, req.player.id]);
    res.json({ ok: true });
  });

  // Run the draw — admin only, atomic, exactly-once, dynamic player count.
  app.post('/api/draw', sameOrigin(), requireAdmin(), async (req, res) => {
    try {
      const result = await tx(async (c) => {
        const upd = await c.query("UPDATE game SET status='drawn', drawn_at=now() WHERE id=1 AND status='registration_open'");
        if (upd.rowCount !== 1) { const e = new Error('not_open'); e.code = 'NOT_OPEN'; throw e; }
        const prows = (await c.query('SELECT id FROM players WHERE display_name IS NOT NULL AND removed=false ORDER BY id FOR UPDATE')).rows;
        const playerIds = prows.map((r) => r.id);
        if (playerIds.length < config.minDrawPlayers) { const e = new Error('too_few'); e.code = 'TOO_FEW'; e.n = playerIds.length; throw e; }
        const teamIds = (await c.query('SELECT id FROM teams ORDER BY idx')).rows.map((r) => r.id);
        await c.query('DELETE FROM allocations'); // defensive; should be empty
        cryptoShuffle(teamIds);
        cryptoShuffle(playerIds);
        const values = [];
        const params = [];
        let i = 1;
        teamIds.forEach((tid, k) => {
          values.push(`($${i++},$${i++})`);
          params.push(tid, playerIds[k % playerIds.length]);
        });
        await c.query(`INSERT INTO allocations (team_id, player_id) VALUES ${values.join(',')}`, params);
        await logAudit('Draw committed · ' + teamIds.length + ' teams · ' + playerIds.length + ' players',
          { actorId: req.player.id, detail: { teams: teamIds.length, players: playerIds.length }, client: c });
        return { teams: teamIds.length, players: playerIds.length };
      });
      console.log(`[draw] committed · ${result.teams} teams · ${result.players} players`);
      res.json({ ok: true, ...result });
    } catch (e) {
      if (e.code === 'NOT_OPEN') return res.status(409).json({ error: 'already_drawn' });
      if (e.code === 'TOO_FEW') return res.status(409).json({ error: 'too_few_players', need: config.minDrawPlayers, have: e.n });
      console.error('[api/draw]', e.message);
      res.status(500).json({ error: 'draw_error' });
    }
  });

  // Admin escape hatch: undo the draw back to open registration.
  app.post('/api/reset-draw', sameOrigin(), requireAdmin(), async (req, res) => {
    try {
      await tx(async (c) => {
        await c.query('DELETE FROM allocations');
        await c.query("UPDATE game SET status='registration_open', drawn_at=NULL WHERE id=1");
        await logAudit('Draw reset → registration open', { actorId: req.player.id, client: c });
      });
      res.json({ ok: true });
    } catch (e) {
      console.error('[api/reset-draw]', e.message);
      res.status(500).json({ error: 'reset_error' });
    }
  });
}
