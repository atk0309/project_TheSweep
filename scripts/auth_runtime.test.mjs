import assert from 'node:assert/strict';
import test from 'node:test';

process.env.NODE_ENV = 'development';
process.env.ALLOW_INSECURE_DEVELOPMENT = '1';

const {
  assertProductionConfig,
  isProductionEnvironment,
  productionConfigErrors,
} = await import('../server/config.js');
const { createMagicLinkSender } = await import('../server/mailer.js');
const {
  canPlayerSelfRequest,
  canReactivatePlayer,
  clientIp,
  isConfiguredAdmin,
  magicTokenPurpose,
} = await import('../server/auth.js');

const validProductionConfig = () => ({
  isProd: true,
  databaseUrl: 'postgres://example.test/app',
  sessionSecret: 's'.repeat(32),
  appUrl: 'https://example.test',
  resendApiKey: 're_test_value',
  emailFrom: 'The Sweep <noreply@example.test>',
  adminEmails: ['admin@example.test'],
  sendCapHour: 100,
  sendCapDay: 500,
  minDrawPlayers: 2,
  guardianDailyBudget: 500,
  guardianNewsReserve: 200,
});

test('Railway project marker enables production behavior without NODE_ENV', () => {
  assert.equal(isProductionEnvironment({ RAILWAY_PROJECT_ID: 'project-id' }), true);
  assert.equal(isProductionEnvironment({ NODE_ENV: 'production' }), true);
  assert.equal(isProductionEnvironment({}), true);
  assert.equal(isProductionEnvironment({ NODE_ENV: 'development' }), true);
  assert.equal(isProductionEnvironment({
    NODE_ENV: 'development',
    ALLOW_INSECURE_DEVELOPMENT: '1',
  }), false);
});

test('production config accepts the complete secure shape', () => {
  assert.deepEqual(productionConfigErrors(validProductionConfig()), []);
  assert.doesNotThrow(() => assertProductionConfig(validProductionConfig()));
});

test('production config reports every required runtime invariant', () => {
  const invalid = {
    isProd: true,
    databaseUrl: '',
    sessionSecret: 'short',
    appUrl: 'http://example.test',
    resendApiKey: '',
    emailFrom: '',
    adminEmails: [],
    sendCapHour: Number.NaN,
    sendCapDay: -1,
    minDrawPlayers: 1.5,
    guardianDailyBudget: Number.NaN,
    guardianNewsReserve: -1,
  };
  const errors = productionConfigErrors(invalid);
  assert.equal(errors.length, 11);
  assert.ok(errors.some((e) => e.startsWith('DATABASE_URL')));
  assert.ok(errors.some((e) => e.startsWith('SESSION_SECRET')));
  assert.ok(errors.some((e) => e.startsWith('APP_URL')));
  assert.ok(errors.some((e) => e.startsWith('RESEND_API_KEY')));
  assert.ok(errors.some((e) => e.startsWith('EMAIL_FROM')));
  assert.ok(errors.some((e) => e.startsWith('ADMIN_EMAILS')));
  assert.ok(errors.some((e) => e.startsWith('SEND_CAP_HOUR')));
  assert.ok(errors.some((e) => e.startsWith('SEND_CAP_DAY')));
  assert.ok(errors.some((e) => e.startsWith('MIN_DRAW_PLAYERS')));
  assert.ok(errors.some((e) => e.startsWith('GUARDIAN_DAILY_BUDGET')));
  assert.ok(errors.some((e) => e.startsWith('GUARDIAN_NEWS_RESERVE')));
  assert.throws(() => assertProductionConfig(invalid), /Invalid production configuration/);
});

test('production config rejects an unusable admin address', () => {
  const invalid = { ...validProductionConfig(), adminEmails: ['not-an-email'] };
  assert.deepEqual(productionConfigErrors(invalid), [
    'ADMIN_EMAILS must contain only valid addresses and at least one address',
  ]);
});

test('token purpose is bound by its hashed bearer prefix', () => {
  assert.equal(magicTokenPurpose(`i_${'a'.repeat(43)}`), 'invite');
  assert.equal(magicTokenPurpose(`l_${'a'.repeat(43)}`), 'login');
  assert.equal(magicTokenPurpose('legacy-token-without-prefix'), 'login');
  assert.equal(magicTokenPurpose('i_too-short'), 'login');
});

test('removed non-admins cannot self-request or self-reactivate', () => {
  const removed = { removed: true };
  assert.equal(canPlayerSelfRequest(null, false), false);
  assert.equal(canPlayerSelfRequest(removed, false), false);
  assert.equal(canReactivatePlayer(removed), false);
});

test('client identity ignores a forged Cloudflare header and canonicalizes req.ip', () => {
  const req = {
    ip: '2001:0db8:0:0:0:0:0:1',
    get: (name) => name.toLowerCase() === 'cf-connecting-ip' ? '198.51.100.250' : '',
  };
  assert.equal(clientIp(req), '2001:db8::1');
  assert.equal(clientIp({ ip: 'not-an-ip' }), '');
});

test('an admin invite or configured admin can reactivate a removed player', () => {
  const removed = { removed: true };
  assert.equal(canReactivatePlayer(removed, { purpose: 'invite' }), true);
  assert.equal(canPlayerSelfRequest(removed, true), true);
  assert.equal(canReactivatePlayer(removed, { configuredAdmin: true }), true);
});

test('configured admin membership is authoritative in both directions', () => {
  assert.equal(isConfiguredAdmin('ADMIN@example.test', ['admin@example.test']), true);
  assert.equal(isConfiguredAdmin('admin@example.test', []), false);
});

test('local development explicitly logs a usable console link', async () => {
  const lines = [];
  const sender = createMagicLinkSender({
    mailClient: null,
    runtimeConfig: { isProd: false, emailFrom: 'unused@example.test' },
    logger: {
      log: (...args) => lines.push(args.join(' ')),
      error: (...args) => lines.push(args.join(' ')),
    },
  });
  const result = await sender('player@example.test', 'http://localhost/auth/verify?token=local-token');
  assert.deepEqual(result, { ok: true, dev: true });
  assert.match(lines.join('\n'), /player@example\.test/);
  assert.match(lines.join('\n'), /local-token/);
});

test('production delivery failures propagate without logging recipient or token', async () => {
  const lines = [];
  const sender = createMagicLinkSender({
    mailClient: {
      emails: {
        send: async ({ to, text }) => ({ error: { message: `failed for ${to}: ${text}` } }),
      },
    },
    runtimeConfig: { isProd: true, emailFrom: 'sender@example.test' },
    logger: {
      log: (...args) => lines.push(args.join(' ')),
      error: (...args) => lines.push(args.join(' ')),
    },
  });
  const result = await sender('private@example.test', 'https://app.example.test/auth/verify?token=secret-token');
  assert.deepEqual(result, { ok: false, error: 'delivery_failed' });
  const output = lines.join('\n');
  assert.doesNotMatch(output, /private@example\.test/);
  assert.doesNotMatch(output, /secret-token/);
  assert.match(output, /delivery failed/);
});

test('successful production delivery passes the expected provider payload', async () => {
  const sent = [];
  const sender = createMagicLinkSender({
    mailClient: {
      emails: {
        send: async (payload) => {
          sent.push(payload);
          return { data: { id: 'email-id' }, error: null };
        },
      },
    },
    runtimeConfig: {
      isProd: true,
      emailFrom: 'The Sweep <sender@example.test>',
    },
  });
  const result = await sender(
    'player@example.test',
    'https://app.example.test/auth/verify?token=provider-contract',
    { invite: true },
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].from, 'The Sweep <sender@example.test>');
  assert.equal(sent[0].to, 'player@example.test');
  assert.match(sent[0].subject, /claim your spot/i);
  assert.match(sent[0].html, /provider-contract/);
  assert.match(sent[0].text, /provider-contract/);
});
