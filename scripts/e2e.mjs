// Full browser E2E against a live server: landing → magic-link → onboard →
// lobby → run-draw → home. Screenshots each step. Reads the dev magic-link
// token from the server log file.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const failClosed = (message) => {
  console.error(`[e2e] Refusing to run: ${message}`);
  process.exit(2);
};

if (process.env.ALLOW_E2E !== '1') {
  failClosed('set ALLOW_E2E=1 to acknowledge that this flow mutates application state.');
}

const EMAIL = process.env.E2E_EMAIL?.trim();
if (!EMAIL || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(EMAIL)) {
  failClosed('set E2E_EMAIL to a valid test account email address.');
}

const rawBase = process.argv[2] || 'http://localhost:3999';
let baseUrl;
try {
  baseUrl = new URL(rawBase);
} catch {
  failClosed(`BASE is not a valid URL: ${rawBase}`);
}
if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
  failClosed('BASE must use http or https.');
}

const baseHost = baseUrl.hostname.toLowerCase();
const isLocalBase = baseHost === 'localhost'
  || baseHost === '[::1]'
  || baseHost === '::1'
  || /^127(?:\.\d{1,3}){3}$/.test(baseHost);
if (!isLocalBase && process.env.ALLOW_REMOTE_E2E !== '1') {
  failClosed(`BASE host ${baseUrl.hostname} is not local; set ALLOW_REMOTE_E2E=1 to acknowledge the remote target.`);
}

const BASE = baseUrl.href.replace(/\/+$/, '');
const LOG = process.argv[3] || '/tmp/sweep_e2e.log';
const SHOT = '/tmp/e2e';

const errors = [];
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 440, height: 950 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // 1) landing
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.getByText('SEND MAGIC LINK', { exact: false }).first().waitFor({ timeout: 15000 });
  await page.screenshot({ path: `${SHOT}-01-landing.png` });
  log('✓ landing');

  // 2) request magic link
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.getByText('SEND MAGIC LINK', { exact: false }).first().click();
  await sleep(700);
  const token = (readFileSync(LOG, 'utf8').match(/token=([A-Za-z0-9_-]+)/g) || []).pop()?.split('=')[1];
  if (!token) throw new Error('no magic-link token found in log');
  log('✓ magic link requested, token captured');

  // 3) verify interstitial → confirm → redirected into app
  await page.goto(`${BASE}/auth/verify?token=${token}`, { waitUntil: 'networkidle' });
  await page.getByText('Sign in', { exact: false }).first().click();
  await page.waitForURL(BASE + '/', { timeout: 15000 });
  await page.getByText('CLAIM YOUR', { exact: false }).first().waitFor({ timeout: 15000 });
  await page.screenshot({ path: `${SHOT}-02-onboard.png` });
  log('✓ authed → onboard');

  // 4) onboard
  await page.locator('input[placeholder="e.g. Leo"]').fill('Test Player');
  await sleep(200);
  await page.getByText('JOIN THE LOBBY', { exact: false }).first().click();
  await page.getByText('RUN THE DRAW', { exact: false }).first().waitFor({ timeout: 15000 });
  await sleep(1200); // let the staggered pop-in animation settle before the shot
  const lobbyNames = await page.evaluate(() => ['Test Player', 'Leo', 'Maya', 'Theo', 'Ava'].filter((n) => document.body.innerText.includes(n)));
  log('  lobby tiles visible for:', lobbyNames.join(', '), `(${lobbyNames.length}/5)`);
  if (lobbyNames.length !== 5) errors.push('LOBBY: expected 5 player tiles, saw ' + lobbyNames.length);
  await page.screenshot({ path: `${SHOT}-03-lobby.png` });
  log('✓ onboard → lobby (admin sees RUN THE DRAW)');

  // 5) run the draw
  await page.getByText('RUN THE DRAW', { exact: false }).first().click();
  await page.getByText('TAP TO OPEN', { exact: false }).first().waitFor({ timeout: 15000 });
  await page.screenshot({ path: `${SHOT}-04-draw-pack.png` });
  await page.getByText('TAP TO OPEN', { exact: false }).first().click();
  await page.getByText('ENTER THE TOURNAMENT', { exact: false }).first().waitFor({ timeout: 25000 });
  await page.screenshot({ path: `${SHOT}-05-draw-reveal.png` });
  log('✓ draw ran + revealed');

  // 6) home
  await page.getByText('ENTER THE TOURNAMENT', { exact: false }).first().click();
  await page.getByText('YOUR SCORE', { exact: false }).first().waitFor({ timeout: 15000 });
  await page.screenshot({ path: `${SHOT}-06-home.png` });
  log('✓ home dashboard');

  // squad sanity
  const squadCount = await page.evaluate(() => {
    // count "Your squad" team cards by looking for the squad header then cards
    return document.body.innerText.includes('Your squad');
  });
  log('home has "Your squad":', squadCount);
} catch (e) {
  errors.push('FLOW: ' + e.message);
  try { await page.screenshot({ path: `${SHOT}-FAIL.png` }); } catch {}
}

await browser.close();
console.log('\n--- errors (' + errors.length + ') ---');
errors.forEach((e) => console.log('  ', e));
const pass = errors.length === 0;
console.log(`\nE2E ${pass ? 'PASS ✅' : 'FAIL ❌'}`);
process.exit(pass ? 0 : 1);
