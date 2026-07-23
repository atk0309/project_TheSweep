// The Sweep — single always-on Node service: static front-end + API + poller.
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config, warnConfig } from './config.js';
import { initSchema, hasDb } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const app = express();
app.set('trust proxy', 1); // behind Cloudflare + Railway proxies
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data: https:",
      "connect-src 'self'",
    ].join('; '),
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
  });
  if (config.isProd) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use(compression());
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false })); // /auth/confirm interstitial form
app.use(cookieParser());

// ── Healthcheck: NO auth, registered before everything (Railway target) ──
let ready = false;
app.get('/healthz', (_req, res) => res.status(ready ? 200 : 503).json({ ok: ready }));

// ── Dynamic routes must never be cached by Cloudflare; preserve Set-Cookie ──
app.use(['/api', '/auth'], (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// ── API + auth routes are attached here as they are built ──
// (auth, /api/state, draw, admin, etc. — added in later steps)
import { registerRoutes } from './routes.js';
registerRoutes(app);

// ── Static front-end ──────────────────────────────────────────────────────
// Vendored runtime is content-addressed-ish and safe to cache hard.
app.use('/vendor', express.static(join(PUBLIC_DIR, 'vendor'), {
  immutable: true,
  maxAge: '7d',
}));
// The runtime + design HTML change during the build; keep them fresh.
app.get('/support.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(join(PUBLIC_DIR, 'support.js'));
});
app.get('/', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(join(PUBLIC_DIR, 'Sweepstake.dc.html'));
});
app.use(express.static(PUBLIC_DIR, { index: false }));

// SPA-ish fallback: anything else renders the app shell (client routes by state).
app.get('/{*splat}', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/auth')) return next();
  res.set('Cache-Control', 'no-cache');
  res.sendFile(join(PUBLIC_DIR, 'Sweepstake.dc.html'));
});

// ── Boot ──────────────────────────────────────────────────────────────────
async function boot() {
  warnConfig();
  if (hasDb) {
    try {
      await initSchema();
    } catch (e) {
      console.error('[boot] schema init failed:', e.message);
      if (config.isProd) throw e;
    }
  }
  // Poller is started here once built (guarded by config + DB).
  try {
    const { startPoller } = await import('./poller.js');
    startPoller();
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') console.error('[boot] poller error:', e.message);
  }
  try {
    const { startNewsPoller } = await import('./news.js');
    startNewsPoller();
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') console.error('[boot] news poller error:', e.message);
  }
  try {
    const { startCommentaryPoller } = await import('./commentary.js');
    startCommentaryPoller();
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') console.error('[boot] commentary poller error:', e.message);
  }

  ready = true;
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`[boot] The Sweep listening on :${config.port}  (APP_URL=${config.appUrl})`);
  });
}

// Exit on an unknown process-level failure; Railway's restart policy will recover
// with clean state instead of leaving a partially broken process serving traffic.
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e?.message || String(e));
  process.exit(1);
});
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e?.message || String(e));
  process.exit(1);
});

boot().catch((e) => {
  console.error('[boot] fatal:', e?.message || String(e));
  process.exitCode = 1;
});
