// Standalone smoke test: load the app in headless chromium, confirm the
// dc-runtime self-mounts from /vendor (no unpkg, no parent), renders the
// landing screen, and logs zero console/page/network errors.
import { chromium } from 'playwright';

const TARGET_URL = process.argv[2] || 'http://localhost:3999/';
const SHOT = process.argv[3] || '/tmp/sweep_smoke.png';
const FALLBACK_URL = new URL('/smoke-fallback', TARGET_URL).href;
const UNKNOWN_API_URL = new URL('/api/nope', TARGET_URL).href;
const UNKNOWN_AUTH_URL = new URL('/auth/nope', TARGET_URL).href;

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
const serverErrors = [];
const requests = [];
let fallbackStatus = 0;
let apiStatus = 0;
let apiStayedInNamespace = false;
let authStatus = 0;
let authStayedInNamespace = false;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 480, height: 1000 }, deviceScaleFactor: 2 });

page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('requestfailed', (r) => failedRequests.push(`${r.url()} :: ${r.failure()?.errorText}`));
page.on('response', (r) => {
  const u = r.url();
  if (r.status() >= 500) serverErrors.push(`${r.status()} ${u}`);
  if (u.includes('/vendor/') || u.endsWith('/support.js')) requests.push(`${r.status()} ${u}`);
});

let ok = true;
try {
  await page.goto(TARGET_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  // Landing screen marker from the design template.
  await page.getByText('SEND MAGIC LINK', { exact: false }).first().waitFor({ timeout: 20_000 });
  await page.screenshot({ path: SHOT });

  // Client routes render the shell, while unknown API routes must remain 404s.
  const fallbackResponse = await page.goto(FALLBACK_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  fallbackStatus = fallbackResponse?.status() || 0;
  await page.getByText('SEND MAGIC LINK', { exact: false }).first().waitFor({ timeout: 20_000 });

  const apiResponse = await page.request.get(UNKNOWN_API_URL);
  apiStatus = apiResponse.status();
  const apiBody = await apiResponse.text();
  apiStayedInNamespace = apiStatus === 404 && !/SEND MAGIC LINK/i.test(apiBody);

  const authResponse = await page.request.get(UNKNOWN_AUTH_URL);
  authStatus = authResponse.status();
  const authBody = await authResponse.text();
  authStayedInNamespace = authStatus === 404 && !/SEND MAGIC LINK/i.test(authBody);
} catch (e) {
  ok = false;
  console.error('SMOKE FAIL during render:', e.message);
  try { await page.screenshot({ path: SHOT }); } catch {}
}

console.log('\n--- vendor/runtime requests ---');
requests.forEach((r) => console.log('  ', r));
console.log('\n--- console errors ---', consoleErrors.length);
consoleErrors.forEach((e) => console.log('  ', e));
console.log('--- page errors ---', pageErrors.length);
pageErrors.forEach((e) => console.log('  ', e));
console.log('--- failed requests ---', failedRequests.length);
failedRequests.forEach((e) => console.log('  ', e));
console.log('--- HTTP 5xx responses ---', serverErrors.length);
serverErrors.forEach((e) => console.log('  ', e));
console.log('--- fallback route status:', fallbackStatus, '---');
console.log('--- unknown API stayed 404:', apiStayedInNamespace, `(${apiStatus})`, '---');
console.log('--- unknown auth stayed 404:', authStayedInNamespace, `(${authStatus})`, '---');

const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
const sawLanding = /SWEEP|INVITE ONLY|MAGIC LINK/i.test(bodyText);
console.log('\n--- landing text present:', sawLanding, '---');

await browser.close();

const pass = ok
  && sawLanding
  && consoleErrors.length === 0
  && pageErrors.length === 0
  && failedRequests.length === 0
  && serverErrors.length === 0
  && fallbackStatus === 200
  && apiStayedInNamespace
  && authStayedInNamespace;
console.log(`\nSMOKE ${pass ? 'PASS ✅' : 'FAIL ❌'}  (screenshot: ${SHOT})`);
process.exit(pass ? 0 : 1);
