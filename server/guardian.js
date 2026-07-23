// Shared Guardian HTTP client + global daily-budget guard. The Guardian
// Developer key is capped at 500 requests/day (and ~1 req/sec), shared between
// the news poller and the live-commentary poller. Both route Guardian traffic
// through guardianFetch so they share ONE in-memory daily counter and one rate
// spacer — commentary reserves headroom so it can never starve news.
import { config } from './config.js';

const DAILY_CAP = config.guardianDailyBudget; // default 500

let usedToday = 0;
let dayKey = utcDay();
let nextSlotAt = 0; // process-wide reserved send-time for the next Guardian request

function utcDay() { return new Date().toISOString().slice(0, 10); }
function rollover() { const d = utcDay(); if (d !== dayKey) { dayKey = d; usedToday = 0; } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function budgetRemaining() { rollover(); return DAILY_CAP - usedToday; }

// Generic fetch with a 15s abort — for non-Guardian callers (e.g. BBC RSS) that
// must NOT count against the Guardian budget. Throws on timeout/non-2xx.
export async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r;
  } finally {
    clearTimeout(to);
  }
}

// Budgeted Guardian fetch. `reserve` = headroom this caller must leave behind:
// news passes 0 (may spend to the cap → never starved); commentary passes
// config.guardianNewsReserve so it backs off early. Returns the Response, or
// null when the budget guard refuses (caller should skip). Throws like
// fetchWithTimeout on transport/non-2xx errors so callers' safe() wrappers fire.
export async function guardianFetch(url, opts = {}, { reserve = 0 } = {}) {
  rollover();
  if (DAILY_CAP - usedToday <= reserve) return null; // budget guard
  // Reserve this call's budget slot AND its send-time synchronously (there is no
  // await in this block), so concurrent callers — e.g. a news tick overlapping a
  // commentary tick — can't both read the same instant and fire together. Each
  // call claims the next slot, keeping the process-wide ~1 req/sec spacer intact.
  usedToday++;
  const now = Date.now();
  const slot = Math.max(now, nextSlotAt);
  nextSlotAt = slot + 1100;
  const wait = slot - now;
  if (wait > 0) await sleep(wait);
  return fetchWithTimeout(url, opts);
}

// Strip CDATA/tags and decode the handful of entities RSS/JSON actually emit.
export function clean(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .trim();
}
