// Football poller: API-Football (api-sports.io) -> Postgres. Clients read the DB,
// never the API. Crash-safe, rate-limit aware, never clobbers manual overrides.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config } from './config.js';
import { pool, query, tx } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COUNTRY_COLORS = JSON.parse(readFileSync(join(__dirname, 'country_colors.json'), 'utf8'));
const DESIGN = JSON.parse(readFileSync(join(__dirname, 'teams.seed.json'), 'utf8'));
const DESIGN_CODE = new Map(DESIGN.map((t) => [norm(t.name), t.code]));

const LEAGUE = 1; // Provider competition identifier for the 2026 tournament.
const SEASON = 2026;
const GROUPS = 'ABCDEFGHIJKL';

let lastRemaining = null;

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
}
function gf(c, d) {
  const a = d === 'v' ? '90deg' : '180deg';
  if (c.length === 3) return `linear-gradient(${a},${c[0]} 0 33.34%,${c[1]} 33.34% 66.67%,${c[2]} 66.67% 100%)`;
  return `linear-gradient(${a},${c[0]} 0 50%,${c[1]} 50% 100%)`;
}
function flagFor(name) {
  const col = COUNTRY_COLORS[norm(name)];
  return col ? gf(col.c, col.d) : 'linear-gradient(180deg,#3a3a3a,#222)';
}
function groupLetter(g) {
  // Standalone trailing A–L only: "Group A" → A, but NOT the "e" in "Group Stage".
  const m = String(g || '').match(/\b([A-L])\s*$/i);
  return m ? m[1].toUpperCase() : null;
}
export function roundInfo(round) {
  const r = String(round || '').toLowerCase();
  if (r.includes('group')) return { ord: 0, stage: 'Group Stage' };
  if (r.includes('round of 32') || r.includes('1/16')) return { ord: 1, stage: 'Round of 32' };
  if (r.includes('round of 16') || r.includes('1/8')) return { ord: 2, stage: 'Round of 16' };
  if (r.includes('quarter')) return { ord: 3, stage: 'Quarter-finals' };
  if (r.includes('3rd place') || r.includes('third place')) return { ord: 4, stage: '3rd Place' };
  if (r.includes('semi')) return { ord: 4, stage: 'Semi-finals' };
  if (r.includes('final')) return { ord: 5, stage: 'Final' };
  console.warn('[poller] unknown round label:', round);
  return { ord: 0, stage: round || 'Group Stage' };
}

async function apiGet(path) {
  const url = config.footballApiBase + path;
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { headers: { 'x-apisports-key': config.footballApiKey }, signal: ctrl.signal });
    const remain = r.headers.get('x-ratelimit-requests-remaining');
    if (remain != null) lastRemaining = Number(remain);
    if (!r.ok) throw new Error('API HTTP ' + r.status);
    const j = await r.json();
    // API-Football signals failure (rate limit, bad params, auth) via a non-empty
    // `errors` alongside an empty `response`. Treat that as fatal — NOT an
    // authoritative empty result — so callers (esp. event reconciliation) never
    // mistake a transient error for "the provider now reports zero events". A
    // clean empty response (no errors, e.g. no live fixtures) still returns [].
    const errs = j.errors;
    if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length)) throw new Error('API error: ' + JSON.stringify(errs));
    // A successful API-Football call always carries `response` as an array (often
    // empty). Anything else is a malformed/non-authoritative body — throw rather
    // than hand callers a fake-empty [] that event reconciliation would trust.
    if (!Array.isArray(j.response)) throw new Error('API malformed: response not an array');
    return j.response;
  } finally {
    clearTimeout(to);
  }
}

// ── Ingest (pure-ish; exported for tests). Each takes parsed API `response`. ──

async function teamIdMap() {
  const { rows } = await query('SELECT id, api_team_id FROM teams WHERE api_team_id IS NOT NULL');
  return new Map(rows.map((r) => [r.api_team_id, r.id]));
}
async function hasAllocations() {
  const { rows } = await query('SELECT 1 FROM allocations LIMIT 1');
  return rows.length > 0;
}

// Build the desired team list from a /standings response.
function teamsFromStandings(resp) {
  const groups = resp?.[0]?.league?.standings || [];
  const out = [];
  const usedCodes = new Set();
  groups.forEach((arr) => {
    const letter = groupLetter(arr[0]?.group);
    if (!letter) return; // skip API's "3rd-placed ranking" pseudo-group (no A–L)
    const sorted = [...arr].sort((a, b) => (a.rank || 99) - (b.rank || 99));
    sorted.forEach((row, pos) => {
      const name = row.team?.name || 'TBD';
      let code = DESIGN_CODE.get(norm(name)) || name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase() || 'T' + row.team?.id;
      while (usedCodes.has(code)) code = code.slice(0, 2) + ((+code.slice(2) || 0) + 1);
      usedCodes.add(code);
      out.push({
        api_team_id: row.team?.id,
        name,
        group_letter: letter,
        idx: GROUPS.indexOf(letter) * 4 + pos,
        flag: flagFor(name),
        code,
      });
    });
  });
  return out;
}

export async function ingestTeams(standingsResp) {
  const desired = teamsFromStandings(standingsResp);
  if (!desired.length) return { mode: 'noop', count: 0 };
  if (await hasAllocations()) {
    // Post-draw: never restructure; just attach api ids by name match.
    let attached = 0;
    for (const t of desired) {
      const r = await query('UPDATE teams SET api_team_id=$1 WHERE api_team_id IS NULL AND lower(name)=lower($2)', [t.api_team_id, t.name]);
      attached += r.rowCount;
    }
    return { mode: 'attach', count: attached };
  }
  // Pre-draw: API is the source of truth — replace the placeholder seed.
  await query('TRUNCATE teams RESTART IDENTITY CASCADE');
  for (const t of desired) {
    await query('INSERT INTO teams (idx, code, name, group_letter, flag, api_team_id) VALUES ($1,$2,$3,$4,$5,$6)',
      [t.idx, t.code, t.name, t.group_letter, t.flag, t.api_team_id]);
  }
  return { mode: 'replace', count: desired.length };
}

export async function ingestStandings(standingsResp, map) {
  const idMap = map || (await teamIdMap());
  const groups = standingsResp?.[0]?.league?.standings || [];
  let n = 0;
  for (const arr of groups) {
    if (!groupLetter(arr[0]?.group)) continue; // skip 3rd-placed ranking table
    for (const row of arr) {
      const teamId = idMap.get(row.team?.id);
      if (!teamId) continue;
      const all = row.all || {};
      const g = all.goals || {};
      await query(
        `INSERT INTO standings (team_id, group_letter, played, w, d, l, gf, ga, points, rank, alive, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
         ON CONFLICT (team_id) DO UPDATE SET group_letter=excluded.group_letter, played=excluded.played,
           w=excluded.w, d=excluded.d, l=excluded.l, gf=excluded.gf, ga=excluded.ga,
           points=excluded.points, rank=excluded.rank, alive=excluded.alive, updated_at=now()`,
        [teamId, groupLetter(row.group), all.played || 0, all.win || 0, all.draw || 0, all.lose || 0,
         g.for || 0, g.against || 0, row.points || 0, row.rank || null, (row.rank || 99) <= 2]);
      n++;
    }
  }
  return n;
}

function fixtureRow(f, idMap) {
  const ri = roundInfo(f.league?.round);
  const homeId = idMap.get(f.teams?.home?.id) || null;
  const awayId = idMap.get(f.teams?.away?.id) || null;
  let winner = null;
  if (f.teams?.home?.winner === true) winner = homeId;
  else if (f.teams?.away?.winner === true) winner = awayId;
  const pen = f.score?.penalty || {};
  return {
    id: f.fixture?.id,
    stage: ri.stage, round_ord: ri.ord,
    group_letter: groupLetter(f.league?.round),
    home_api_id: f.teams?.home?.id || null, away_api_id: f.teams?.away?.id || null,
    home_team_id: homeId, away_team_id: awayId,
    kickoff: f.fixture?.date || null,
    elapsed: f.fixture?.status?.elapsed ?? null,
    status: f.fixture?.status?.short || 'NS',
    home_goals: f.goals?.home ?? null, away_goals: f.goals?.away ?? null,
    home_pen: pen.home ?? null, away_pen: pen.away ?? null,
    winner_team_id: winner,
  };
}

export async function ingestFixtures(fixturesResp, map) {
  const idMap = map || (await teamIdMap());
  let n = 0;
  for (const f of fixturesResp) {
    const r = fixtureRow(f, idMap);
    if (r.id == null) continue;
    await query(
      `INSERT INTO fixtures (id, stage, round_ord, group_letter, home_api_id, away_api_id, home_team_id, away_team_id,
                             kickoff, elapsed, status, home_goals, away_goals, home_pen, away_pen, winner_team_id, source, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'api',now())
       ON CONFLICT (id) DO UPDATE SET
         stage=excluded.stage, round_ord=excluded.round_ord, group_letter=excluded.group_letter,
         home_api_id=excluded.home_api_id, away_api_id=excluded.away_api_id,
         home_team_id=excluded.home_team_id, away_team_id=excluded.away_team_id,
         kickoff=excluded.kickoff, elapsed=excluded.elapsed, status=excluded.status,
         home_goals=excluded.home_goals, away_goals=excluded.away_goals,
         home_pen=excluded.home_pen, away_pen=excluded.away_pen, winner_team_id=excluded.winner_team_id, updated_at=now()
       WHERE fixtures.source <> 'manual'`,
      [r.id, r.stage, r.round_ord, r.group_letter, r.home_api_id, r.away_api_id, r.home_team_id, r.away_team_id,
       r.kickoff, r.elapsed, r.status, r.home_goals, r.away_goals, r.home_pen, r.away_pen, r.winner_team_id]);
    n++;
  }
  return n;
}

// Mark teams eliminated in a completed knockout match as not-alive (for the pot view).
export async function reconcileAlive() {
  await query(
    `UPDATE standings s SET alive=false
       FROM fixtures f
      WHERE f.round_ord >= 1 AND f.status IN ('FT','AET','PEN') AND f.winner_team_id IS NOT NULL
        AND ((f.home_team_id = s.team_id AND f.winner_team_id <> s.team_id)
          OR (f.away_team_id = s.team_id AND f.winner_team_id <> s.team_id))`);
}

// Group-stage fixtures: API's round is "Group Stage - N" (matchday), so derive
// the A–L group label from the home team.
export async function backfillFixtureGroups() {
  await query(`UPDATE fixtures f SET group_letter = t.group_letter
                 FROM teams t
                WHERE f.home_team_id = t.id AND f.round_ord = 0
                  AND (f.group_letter IS NULL OR f.group_letter = '')`);
}

// ── Match events (goal/card/subst timeline) ─────────────────────────────────
export async function ingestEvents(fixtureId, eventsResp, map) {
  // apiGet returns a TRUSTED array (it throws on API errors and malformed bodies),
  // so any array we get here — even empty — is the provider's authoritative current
  // timeline, and we reconcile to it: it shrinks when VAR chalks off a goal and
  // re-keys an event on a minute correction (dedupe_key includes elapsed), and an
  // empty list legitimately clears a lone now-retracted event. A non-array only
  // reaches here from a direct/test caller — treat it as untrusted and skip, so a
  // bad fetch never wipes a good timeline.
  if (!Array.isArray(eventsResp)) return 0;
  const idMap = map || (await teamIdMap());
  const events = eventsResp.map((ev) => {
    const elapsed = ev.time?.elapsed;
    const extra = ev.time?.extra;
    const minute = elapsed != null ? elapsed + (extra || 0) : null;
    const player = ev.player?.name || null;
    const type = ev.type || null;
    const detail = ev.detail || null;
    const dedupe = [fixtureId, elapsed ?? '', extra ?? '', ev.team?.id ?? '', type ?? '', detail ?? '', player ?? ''].join('|');
    return { minute, teamId: idMap.get(ev.team?.id) || null, player, type, detail, dedupe };
  });
  const keys = events.map((e) => e.dedupe);
  let n = 0;
  await tx(async (client) => {
    // Drop locally-stored events the provider no longer reports for this fixture
    // (retractions / minute corrections, or all of them when the list is now
    // empty); unchanged rows keep their id + created_at.
    if (keys.length) await client.query('DELETE FROM match_events WHERE fixture_id=$1 AND NOT (dedupe_key = ANY($2))', [fixtureId, keys]);
    else await client.query('DELETE FROM match_events WHERE fixture_id=$1', [fixtureId]);
    for (const e of events) {
      const r = await client.query(
        `INSERT INTO match_events (fixture_id, minute, team_id, player, type, detail, dedupe_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (dedupe_key) DO NOTHING`,
        [fixtureId, e.minute, e.teamId, e.player, e.type, e.detail, e.dedupe]);
      n += r.rowCount;
    }
  });
  return n;
}

// Fetch + ingest the event timeline for the given fixture ids (sequential,
// quota-guarded). Used for in-play fixtures — refetched every live tick.
async function pollEventsFor(ids, map) {
  if (!ids.length) return 0;
  const idMap = map || (await teamIdMap());
  let total = 0;
  for (const id of ids) {
    if (lastRemaining != null && lastRemaining < 25) { console.warn('[poller] quota low — pausing event fetch'); break; }
    const ev = await apiGet(`/fixtures/events?fixture=${id}`);
    total += await ingestEvents(id, ev, idMap);
  }
  return total;
}

// Pull final timelines for finished fixtures not yet synced, marking each done
// only after a successful fetch (so a quota pause never skips one permanently).
async function backfillFinishedEvents(limit, map) {
  const idMap = map || (await teamIdMap());
  const { rows } = await query(
    `SELECT id FROM fixtures WHERE status IN ('FT','AET','PEN') AND events_synced_at IS NULL
      ORDER BY kickoff DESC NULLS LAST LIMIT $1`, [limit]);
  let total = 0, done = 0;
  for (const { id } of rows) {
    if (lastRemaining != null && lastRemaining < 25) { console.warn('[poller] quota low — pausing event backfill'); break; }
    const ev = await apiGet(`/fixtures/events?fixture=${id}`);
    total += await ingestEvents(id, ev, idMap);
    await query('UPDATE fixtures SET events_synced_at=now() WHERE id=$1', [id]);
    done++;
  }
  if (done) console.log(`[poller] event backfill · ${total} events across ${done} fixtures · quota left ${lastRemaining}`);
  return total;
}

// ── Orchestration ──────────────────────────────────────────────────────────
let _busy = false;
export async function pollFull() {
  if (!config.footballApiKey || _busy) return;
  _busy = true;
  try {
    const standings = await apiGet(`/standings?league=${LEAGUE}&season=${SEASON}`);
    if (standings.length) {
      await ingestTeams(standings);
      const map = await teamIdMap();
      await ingestStandings(standings, map);
      const fixtures = await apiGet(`/fixtures?league=${LEAGUE}&season=${SEASON}`);
      await ingestFixtures(fixtures, map);
      await backfillFixtureGroups();
      await reconcileAlive();
      await backfillFinishedEvents(30, map);
      console.log(`[poller] full sync ok · ${fixtures.length} fixtures · quota left ${lastRemaining}`);
    }
  } catch (e) {
    console.error('[poller] pollFull failed:', e.message);
  } finally {
    _busy = false;
  }
}

export async function pollLive() {
  if (!config.footballApiKey || _busy) return 0;
  _busy = true;
  let n = 0;
  try {
    const live = await apiGet(`/fixtures?league=${LEAGUE}&season=${SEASON}&live=all`);
    n = live.length;
    const map = await teamIdMap();
    const liveIds = new Set(live.map((f) => f.fixture?.id).filter((x) => x != null));
    if (n) {
      await ingestFixtures(live, map);
      await backfillFixtureGroups();
      await reconcileAlive();
      const ev = await pollEventsFor([...liveIds], map);
      console.log(`[poller] live tick · ${n} in play · ${ev} new events · quota left ${lastRemaining}`);
    }
    // EVERY tick (not just when idle): a fixture that has finished still carries
    // an in-play status in our DB until a full poll, and it's no longer in
    // live=all. Refresh those — excluding the ones still live — so a match that
    // ends while others play still flips to FT and gets its final timeline,
    // instead of waiting up to the 3h full poll.
    const stuck = (await query("SELECT id FROM fixtures WHERE status IN ('1H','2H','HT','ET','BT','P','SUSP','INT','LIVE')")).rows
      .map((r) => r.id).filter((id) => !liveIds.has(id));
    if (stuck.length) {
      const refreshed = await apiGet(`/fixtures?ids=${stuck.slice(0, 20).join('-')}`);
      if (refreshed.length) { await ingestFixtures(refreshed, map); await backfillFixtureGroups(); await reconcileAlive(); }
    }
    await backfillFinishedEvents(8, map);
  } catch (e) {
    console.error('[poller] pollLive failed:', e.message);
  } finally {
    _busy = false;
  }
  return n;
}

// Admin "force refresh" entry point.
export async function pollNow() { await pollFull(); }

export function startPoller() {
  if (config.pollerDisabled) { console.log('[poller] disabled (POLLER_DISABLED=1).'); return; }
  if (!config.footballApiKey) { console.log('[poller] no FOOTBALL_API_KEY — running without live data (use admin manual override).'); return; }
  console.log('[poller] starting (league=1 season=2026).');
  pollFull().catch((e) => console.error('[poller] boot sync error:', e.message));
  // Adaptive live cadence: poll every 60s WHILE matches are in play (fresh
  // scores/events), back off to every 5 min when nothing is live (just to catch
  // kickoffs). Pro plan = 7500 req/day; a full match day at 60s is still ~10%.
  // Backs off automatically when the daily quota is nearly spent.
  const FAST = 60 * 1000, IDLE = 5 * 60 * 1000;
  const liveTick = async () => {
    let live = 0;
    if (lastRemaining != null && lastRemaining < 25) {
      console.warn('[poller] quota low (' + lastRemaining + ') — backing off live tick');
    } else {
      live = await pollLive().catch((e) => { console.error('[poller] live error:', e.message); return 0; });
    }
    setTimeout(liveTick, (live > 0 && (lastRemaining == null || lastRemaining >= 25)) ? FAST : IDLE);
  };
  setTimeout(liveTick, FAST);
  // Full refresh (fixtures + standings) every 3h.
  setInterval(() => { pollFull().catch((e) => console.error('[poller] periodic full error:', e.message)); }, 3 * 60 * 60 * 1000);
}
