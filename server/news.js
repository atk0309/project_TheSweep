// News poller: Guardian Content API + BBC Sport football RSS -> Postgres `news`.
// Clients read the DB only (same pattern as the football poller). Guardian is the
// general/live read; BBC Sport adds reports & analysis. Per-match relevance is done at
// read time by matching team names against title/trail (see the front-end).
import { config } from './config.js';
import { pool, query } from './db.js';
import { guardianFetch, fetchWithTimeout, clean } from './guardian.js';

async function guardianItems() {
  if (!config.guardianApiKey) return [];
  const url = 'https://content.guardianapis.com/search?section=football'
    + '&q=' + encodeURIComponent('world cup')
    + '&order-by=newest&page-size=15&show-fields=trailText,thumbnail&api-key=' + config.guardianApiKey;
  // News always wins the budget (reserve 0); commentary reserves headroom for it.
  const r = await guardianFetch(url, {}, { reserve: 0 });
  if (!r) return [];
  const j = await r.json();
  return (j.response?.results || []).map((r) => ({
    source: 'Guardian',
    title: clean(r.webTitle),
    url: r.webUrl,
    trail: clean(r.fields?.trailText || ''),
    image: r.fields?.thumbnail || null,
    published_at: r.webPublicationDate || null,
    is_live: /\/live\//.test(r.webUrl || '') || /[-–]\s*live$/i.test(r.webTitle || ''),
  }));
}

function parseRss(xml, source) {
  const pick = (b, t) => { const m = b.match(new RegExp('<' + t + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + t + '>')); return m ? clean(m[1]) : ''; };
  return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, b]) => {
    const pub = pick(b, 'pubDate');
    let iso = null; if (pub) { const d = new Date(pub); if (!isNaN(d)) iso = d.toISOString(); }
    return { source, title: pick(b, 'title'), url: pick(b, 'link'), trail: pick(b, 'description'), image: null, published_at: iso, is_live: false };
  }).filter((x) => x.title && x.url);
}

async function bbcItems() {
  const xml = await (await fetchWithTimeout('https://feeds.bbci.co.uk/sport/football/rss.xml')).text();
  return parseRss(xml, 'BBC Sport');
}

async function safe(label, fn) {
  try { return await fn(); } catch (e) { console.error(`[news] ${label} fetch failed:`, e.message); return []; }
}

async function enforceProviderRetention() {
  // Normalise rows written before the source label was made provider-accurate.
  await query("UPDATE news SET source='BBC Sport' WHERE source='BBC'");
  // Guardian content may be cached only while it is actively refreshed.
  const r = await query("DELETE FROM news WHERE source IN ('Guardian','The Guardian') AND fetched_at <= now() - interval '24 hours'");
  return r.rowCount;
}

export async function pollNews() {
  if (!pool) return 0;
  // Opt-in fetching is independent from mandatory provider cleanup.
  if (!config.newsEnabled) {
    await enforceProviderRetention();
    return 0;
  }
  const items = [...(await safe('Guardian', guardianItems)), ...(await safe('BBC Sport', bbcItems))];
  let n = 0;
  for (const it of items) {
    const r = await query(
      `INSERT INTO news (source, title, url, trail, image, published_at, is_live, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (dedupe_key) DO UPDATE SET source=excluded.source, title=excluded.title, trail=excluded.trail,
         is_live=excluded.is_live, published_at=excluded.published_at, fetched_at=now()`,
      [it.source, it.title, it.url, it.trail || null, it.image, it.published_at, !!it.is_live, it.url]);
    n += r.rowCount;
  }
  // This intentionally runs when the Guardian key is absent or a fetch fails.
  await enforceProviderRetention();
  // Keep the table bounded to the freshest 80.
  await query('DELETE FROM news WHERE id NOT IN (SELECT id FROM news ORDER BY published_at DESC NULLS LAST LIMIT 80)');
  console.log(`[news] sync ok · ${items.length} items`);
  return items.length;
}

async function anyLiveFixture() {
  try { return (await query("SELECT 1 FROM fixtures WHERE status IN ('1H','2H','HT','ET','BT','P','LIVE') LIMIT 1")).rows.length > 0; }
  catch (e) { return false; }
}

export function startNewsPoller() {
  if (!pool) { console.log('[news] no DB — skipping news poller.'); return; }
  console.log(config.newsEnabled
    ? `[news] starting (${config.guardianApiKey ? 'Guardian + BBC Sport' : 'BBC Sport only — no GUARDIAN_API_KEY'}); 8m while live, 30m idle.`
    : '[news] NEWS_ENABLED is not 1 — retention cleanup only.');
  // Adaptive: refresh news every 8 min while a match is live (reports & the
  // Guardian live blog move fast then), back off to 30 min when nothing's on.
  const LIVE = 8 * 60 * 1000, IDLE = 30 * 60 * 1000;
  const tick = async () => {
    try { await pollNews(); } catch (e) { console.error('[news] tick error:', e.message); }
    setTimeout(tick, (await anyLiveFixture()) ? LIVE : IDLE);
  };
  tick();
}
