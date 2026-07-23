// Centralised env/config with dev-friendly defaults and fail-fast production
// validation. Insecure defaults are available only through an explicit local
// development opt-in; everything else fails closed as a production runtime.
const DEV_SESSION_SECRET = 'dev-insecure-secret-change-me';

const required = (name, fallback = undefined) => {
  const v = process.env[name];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    return undefined;
  }
  return v;
};

export function isProductionEnvironment(env = process.env) {
  if (String(env.RAILWAY_PROJECT_ID || '').trim()) return true;
  if (env.NODE_ENV === 'production') return true;
  return !(env.NODE_ENV === 'development' && env.ALLOW_INSECURE_DEVELOPMENT === '1');
}

const isProd = isProductionEnvironment();

export const config = {
  port: Number(process.env.PORT) || 3999,
  databaseUrl: required('DATABASE_URL'),
  sessionSecret: required('SESSION_SECRET', isProd ? undefined : DEV_SESSION_SECRET),
  appUrl: (required('APP_URL', isProd ? undefined : 'http://localhost:3999') || '').replace(/\/+$/, ''),
  resendApiKey: required('RESEND_API_KEY'),
  emailFrom: required('EMAIL_FROM', isProd ? undefined : 'The Sweep <onboarding@resend.dev>'),
  adminEmails: (required('ADMIN_EMAILS', '') || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
  footballApiKey: required('FOOTBALL_API_KEY'),
  footballApiBase: (required('FOOTBALL_API_BASE', 'https://v3.football.api-sports.io') || '').replace(/\/+$/, ''),
  guardianApiKey: required('GUARDIAN_API_KEY', ''),
  guardianDailyBudget: Number(required('GUARDIAN_DAILY_BUDGET', '500')),
  guardianNewsReserve: Number(required('GUARDIAN_NEWS_RESERVE', '200')),
  // Global magic-link send caps — the backstop that bounds Resend burn even if an
  // attacker rotates IP/cookie/email. Counts links issued (magic_tokens) in a window.
  sendCapHour: Number(required('SEND_CAP_HOUR', '100')),
  sendCapDay: Number(required('SEND_CAP_DAY', '500')),
  minDrawPlayers: Number(process.env.MIN_DRAW_PLAYERS) || 2,
  pollerDisabled: required('POLLER_DISABLED', '') === '1',
  newsEnabled: required('NEWS_ENABLED', '') === '1',
  commentaryEnabled: required('COMMENTARY_ENABLED', '') === '1',
  isProd,
};

const present = (value) => typeof value === 'string' && value.trim().length > 0;
const validEmailAddress = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || ''));
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

function isHttpsUrl(value) {
  if (!present(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname;
  } catch {
    return false;
  }
}

export function productionConfigErrors(value = config) {
  const errors = [];
  if (!present(value.databaseUrl)) errors.push('DATABASE_URL is required');
  if (!present(value.sessionSecret) || value.sessionSecret.trim().length < 32 || value.sessionSecret === DEV_SESSION_SECRET) {
    errors.push('SESSION_SECRET must be at least 32 characters');
  }
  if (!isHttpsUrl(value.appUrl)) errors.push('APP_URL must be a valid https URL');
  if (!present(value.resendApiKey)) errors.push('RESEND_API_KEY is required');
  if (!present(value.emailFrom)) errors.push('EMAIL_FROM is required');
  if (
    !Array.isArray(value.adminEmails)
    || value.adminEmails.length === 0
    || value.adminEmails.some((email) => !validEmailAddress(email))
  ) {
    errors.push('ADMIN_EMAILS must contain only valid addresses and at least one address');
  }
  if (!positiveInteger(value.sendCapHour)) errors.push('SEND_CAP_HOUR must be a positive integer');
  if (!positiveInteger(value.sendCapDay)) errors.push('SEND_CAP_DAY must be a positive integer');
  if (!positiveInteger(value.minDrawPlayers)) errors.push('MIN_DRAW_PLAYERS must be a positive integer');
  if (!positiveInteger(value.guardianDailyBudget)) errors.push('GUARDIAN_DAILY_BUDGET must be a positive integer');
  if (
    !Number.isSafeInteger(value.guardianNewsReserve)
    || value.guardianNewsReserve < 0
    || value.guardianNewsReserve > value.guardianDailyBudget
  ) {
    errors.push('GUARDIAN_NEWS_RESERVE must be an integer between 0 and GUARDIAN_DAILY_BUDGET');
  }
  return errors;
}

export function assertProductionConfig(value = config) {
  if (!value.isProd) return;
  const errors = productionConfigErrors(value);
  if (errors.length) {
    throw new Error(`Invalid production configuration: ${errors.join('; ')}`);
  }
}

// Validate during module evaluation. In particular, this happens before index.js
// installs its process-level exception handlers, so a bad production deployment
// exits instead of lingering as an unhealthy process.
assertProductionConfig();

// Loud, non-fatal boot warnings are reserved for local development.
export function warnConfig() {
  if (config.isProd) return;
  const warn = (m) => console.warn(`[config] ⚠ ${m}`);
  if (!config.databaseUrl) warn('DATABASE_URL unset — DB features disabled (static server only).');
  if (config.sessionSecret === DEV_SESSION_SECRET) warn('SESSION_SECRET unset — using insecure dev secret.');
  if (!config.resendApiKey) warn('RESEND_API_KEY unset — magic-link emails will be logged to console instead of sent.');
  if (config.adminEmails.length === 0) warn('ADMIN_EMAILS unset — NO ONE will be admin; the draw/admin screens stay locked.');
  if (!config.footballApiKey) warn('FOOTBALL_API_KEY unset — football poller disabled; use admin manual override for scores.');
}
