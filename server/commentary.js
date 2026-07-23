// Live match commentary: Guardian liveblogs -> Postgres `match_commentary`.
// Same shape as the football/news pollers — the server polls Guardian, clients
// read the DB only. Guardian's per-match liveblog is discovered once (cached on
// the fixture), then polled for new blocks while the match is live. All Guardian
// traffic goes through guardianFetch, which shares the 500/day budget with news
// and reserves headroom so commentary never starves news.
import { config } from './config.js';
import { pool, query } from './db.js';
import { guardianFetch, budgetRemaining, clean } from './guardian.js';

const COMMENTARY_LIVE = 5 * 60 * 1000;   // poll every 5 min while a match is live
const COMMENTARY_IDLE = 15 * 60 * 1000;  // 15 min idle (near-kickoff discovery only)
const MAX_BLOGS_PER_TICK = 6;            // per-tick fetch cap (burst + budget bound)
const DISCOVERY_MAX_MISSES = 4;          // give up discovery after K matched-but-empty searches
const RESERVE = config.guardianNewsReserve;       // headroom reserved for news
const BLOCKS = 'body:latest:30,body:key-events';  // ONE request returns both arrays

// Normalise a name to comparable tokens (mirrors poller.js norm()).
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

// API-Football names don't always match the Guardian's common usage. Map the
// NORMALISED team name (norm() strips case, diacritics AND punctuation) to extra
// readable variants. Keying by norm() means the seeded "Côte d’Ivoire" (curly
// apostrophe) resolves the same as a straight one. These variants feed BOTH the
// Guardian search query AND the title match, so an alias-named liveblog is
// actually surfaced by the search before pickBlog filters on it.
const NAME_ALIASES = {
  korearepublic: ['South Korea', 'Korea'],
  iriran: ['Iran'],
  iran: ['IR Iran'],
  usa: ['United States'],
  cotedivoire: ['Ivory Coast'],
  caboverde: ['Cape Verde'],
  czechia: ['Czech Republic'],
  czechrepublic: ['Czechia'],
  bosniaandherzegovina: ['Bosnia'],
  northmacedonia: ['Macedonia'],
};
function nameVariants(name) {
  return [name, ...(NAME_ALIASES[norm(name)] || [])].filter(Boolean);
}
function nameTokens(name) {
  return [...new Set(nameVariants(name).map(norm).filter(Boolean))];
}
function titleHasTeam(normTitle, name) {
  return nameTokens(name).some((tok) => normTitle.includes(tok));
}
// Guardian boolean search term for one team: ("Name" OR "Alias" …). Exported for tests.
export function searchTerm(name) {
  return '(' + nameVariants(name).map((v) => `"${v}"`).join(' OR ') + ')';
}

// Pick the newest liveblog whose title mentions BOTH teams (search is already
// order-by=newest&type=liveblog). Returns the Guardian content id, or null.
// Exported for tests.
export function pickBlog(results, home, away) {
  for (const r of results || []) {
    if (r.type && r.type !== 'liveblog') continue;
    const t = norm(r.webTitle);
    if (titleHasTeam(t, home) && titleHasTeam(t, away)) return r.id;
  }
  return null;
}

// Match minute from a block's title/body. USED FOR ORDERING (the timeline sorts
// by minute — see /api/commentary), so accuracy matters. Three sources, in order:
//   1) a clock minute in the TITLE ("66 min:", "45+2'")  — play-by-play
//   2) for KEY events only, the minute in a goal/card title "(Gakpo, 47)"
//   3) a clock minute in the BODY (last resort)
// The goal-paren pattern is gated to key events and the title so incidental prose
// parentheticals (e.g. "(captain, 10)") in non-key blocks can't inject a bogus
// minute; the clock pattern runs first so "66 min: …(Veerman, 64)" stays 66.
// Nullable. Exported for tests.
export function parseMinute(title, body, isKey = false) {
  const t = String(title || '');
  const CLOCK = /\b(\d{1,3})(?:\s*\+\s*(\d{1,2}))?\s*(?:'|min\b)/i; // "66 min", "45+2'"
  const GOAL = /\([^()]*?(\d{1,3})(?:\s*\+\s*(\d{1,2}))?\s*\)/;     // minute before ")": "(Gakpo, 47)", "(Haaland 57)", "(Scorer, 90+2)"
  let m = t.match(CLOCK);
  if (!m && isKey) m = t.match(GOAL);
  if (!m) m = String(body || '').match(CLOCK);
  if (!m) return null;
  const base = +m[1];
  if (base > 130) return null; // reject 3-digit strays / years (applies to both patterns)
  return base + (m[2] ? +m[2] : 0);
}

async function safe(label, fn) {
  try { return await fn(); } catch (e) { console.error(`[commentary] ${label}:`, e.message); return null; }
}

// Guardian commentary is transient provider content: remove every block no
// later than 24 hours after it was first stored. Keep this independent of API
// access so removing GUARDIAN_API_KEY cannot strand previously cached blocks.
export async function cleanupExpiredCommentary() {
  if (!pool) return 0;
  const r = await query("DELETE FROM match_commentary WHERE created_at <= now() - interval '24 hours'");
  if (r.rowCount) console.log(`[commentary] retention cleanup · ${r.rowCount} expired blocks`);
  return r.rowCount;
}

// Find + cache a fixture's Guardian liveblog id. Transport/budget errors must
// NOT burn a discovery miss (let safe() catch them / null means budget refused);
// only a successful search that matched nothing increments the miss counter.
export async function discoverBlog(fx) {
  const t = new Date(fx.kickoff).getTime();
  const from = new Date(t - 86400000).toISOString().slice(0, 10); // KO date -1d (tz-safe window)
  const to = new Date(t + 86400000).toISOString().slice(0, 10);   // KO date +1d
  // Boolean q built from alias variants so a liveblog Guardian titled with an
  // alias name (e.g. "Ivory Coast") is still surfaced for pickBlog to match.
  const q = `${searchTerm(fx.home_name)} AND ${searchTerm(fx.away_name)}`;
  const url = 'https://content.guardianapis.com/search'
    + '?type=liveblog&section=football&order-by=newest&page-size=10'
    + '&q=' + encodeURIComponent(q)
    + `&from-date=${from}&to-date=${to}&api-key=${config.guardianApiKey}`;
  const r = await guardianFetch(url, {}, { reserve: RESERVE });
  if (!r) return null; // budget refused — leave state untouched, retry next tick
  const j = await r.json();
  const hit = pickBlog(j.response?.results || [], fx.home_name, fx.away_name);
  if (hit) {
    await query("UPDATE fixtures SET guardian_blog_id=$1, commentary_state='found', commentary_misses=0 WHERE id=$2", [hit, fx.id]);
    console.log(`[commentary] found blog for ${fx.home_name} v ${fx.away_name}: ${hit}`);
    return hit;
  }
  const misses = (fx.commentary_misses || 0) + 1;
  const state = misses >= DISCOVERY_MAX_MISSES ? 'missing' : 'unknown';
  await query('UPDATE fixtures SET commentary_misses=$1, commentary_state=$2 WHERE id=$3', [misses, state, fx.id]);
  if (state === 'missing') console.log(`[commentary] no blog for ${fx.home_name} v ${fx.away_name} after ${misses} tries — giving up`);
  return null;
}

// Fetch latest + key-event blocks for a blog and upsert them. Guardian edits
// blocks in place, so ON CONFLICT (block_id) DO UPDATE refreshes body/title.
export async function ingestBlocks(fixtureId, blogId) {
  const url = `https://content.guardianapis.com/${blogId}?show-blocks=${encodeURIComponent(BLOCKS)}&api-key=${config.guardianApiKey}`;
  const r = await guardianFetch(url, {}, { reserve: RESERVE });
  if (!r) return null; // budget refused — signal "no flush" so callers don't retire the fixture
  const req = (await r.json()).response?.content?.blocks?.requestedBodyBlocks || {};
  const latest = req['body:latest:30'] || [];
  const keyEv = req['body:key-events'] || [];
  const keyIds = new Set(keyEv.map((b) => b.id));
  const seen = new Set();
  let n = 0;
  for (const b of [...keyEv, ...latest]) {
    if (!b?.id || seen.has(b.id)) continue;
    seen.add(b.id);
    const title = clean(b.title || '');
    const body = clean(b.bodyTextSummary || b.bodyHtml || '');
    if (!title && !body) continue;
    const isKey = !!b.attributes?.keyEvent || keyIds.has(b.id);
    // Order the timeline by ORIGINAL publication time, not last-edited time.
    // Guardian revises blocks in place (e.g. adds a video clip to a goal block),
    // which bumps publishedDate to ~now and would yank that block to the top,
    // out of chronological order with the surrounding play-by-play.
    // firstPublishedDate is stable across those edits.
    const published = b.firstPublishedDate || b.publishedDate || b.createdDate || null;
    const res = await query(
      `INSERT INTO match_commentary (fixture_id, block_id, published_at, title, body, is_key_event, minute)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (block_id) DO UPDATE SET
         title=excluded.title, body=excluded.body, is_key_event=excluded.is_key_event,
         minute=excluded.minute,
         -- Never let a re-publish push a block later; keep its earliest timestamp.
         -- Also self-heals rows previously stored at an edited time. LEAST ignores NULLs.
         published_at=LEAST(match_commentary.published_at, excluded.published_at)`,
      [fixtureId, b.id, published, title || null, body || null, isKey, parseMinute(title, body, isKey)]);
    n += res.rowCount;
  }
  await query('UPDATE fixtures SET commentary_polled_at=now() WHERE id=$1', [fixtureId]);
  return n;
}

// Fixtures worth polling: in-play, just-before kickoff (discovery), or finished
// with a cached blog needing one final flush (then marked 'done').
const SELECT = `SELECT f.id, f.status, f.kickoff, f.guardian_blog_id, f.commentary_state, f.commentary_misses,
       ht.name AS home_name, at.name AS away_name
  FROM fixtures f
  JOIN teams ht ON ht.id = f.home_team_id
  JOIN teams at ON at.id = f.away_team_id`;
const ELIGIBLE = `f.commentary_state NOT IN ('missing','done') AND (
     f.status IN ('1H','2H','HT','ET','BT','P','LIVE','SUSP','INT')
  OR (f.status='NS' AND f.kickoff IS NOT NULL AND f.kickoff BETWEEN now() - interval '10 min' AND now() + interval '20 min')
  OR (f.status IN ('FT','AET','PEN') AND f.guardian_blog_id IS NOT NULL AND f.commentary_state='found')
)`;

async function runRows(rows) {
  let n = 0;
  for (const fx of rows) {
    if (budgetRemaining() <= RESERVE) { console.warn('[commentary] budget low — stopping tick'); break; }
    let blogId = fx.guardian_blog_id;
    if (!blogId) blogId = await safe('discover', () => discoverBlog(fx));
    if (!blogId) continue;
    const ingested = await safe('ingest', () => ingestBlocks(fx.id, blogId));
    n += ingested || 0;
    // Only retire a finished fixture once its final flush actually succeeded — a
    // transient Guardian failure or budget refusal (both -> null) leaves it
    // eligible so the closing blocks aren't lost to one bad tick.
    if (ingested != null && ['FT', 'AET', 'PEN'].includes(fx.status)) {
      await query("UPDATE fixtures SET commentary_state='done' WHERE id=$1", [fx.id]); // final flush done
    }
  }
  if (rows.length) console.log(`[commentary] tick · ${rows.length} fixtures · ${n} new blocks · budget left ${budgetRemaining()}`);
  return n;
}

export async function pollCommentary() {
  if (!pool) return 0;
  await cleanupExpiredCommentary();
  if (!config.commentaryEnabled || !config.guardianApiKey) return 0;
  if (budgetRemaining() <= RESERVE) { console.warn('[commentary] budget reserved for news — skipping tick'); return 0; }
  const { rows } = await query(`${SELECT} WHERE ${ELIGIBLE} ORDER BY f.commentary_polled_at NULLS FIRST LIMIT $1`, [MAX_BLOGS_PER_TICK]);
  return runRows(rows);
}

async function anyLiveFixture() {
  try { return (await query("SELECT 1 FROM fixtures WHERE status IN ('1H','2H','HT','ET','BT','P','LIVE') LIMIT 1")).rows.length > 0; }
  catch { return false; }
}

let _busy = false;
export function startCommentaryPoller() {
  if (!pool) { console.log('[commentary] no DB — skipping.'); return; }
  console.log(!config.commentaryEnabled
    ? '[commentary] COMMENTARY_ENABLED is not 1 — retention cleanup only.'
    : config.guardianApiKey
      ? '[commentary] starting; 5m while live, 15m idle.'
      : '[commentary] no GUARDIAN_API_KEY — retention cleanup only.');
  cleanupExpiredCommentary().catch((e) => console.error('[commentary] cleanup error:', e.message));
  const tick = async () => {
    if (!_busy) {
      _busy = true;
      try { await pollCommentary(); } catch (e) { console.error('[commentary] tick error:', e.message); }
      finally { _busy = false; }
    }
    setTimeout(tick, (await anyLiveFixture()) ? COMMENTARY_LIVE : COMMENTARY_IDLE);
  };
  setTimeout(tick, COMMENTARY_LIVE);
}
