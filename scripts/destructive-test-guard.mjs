const CLEAR_TEST_DATABASE_NAME = /(?:^|[._-])(?:test|testing|disposable)(?:[._-]|$)/i;

function isLocalDatabaseHost(hostname) {
  const host = hostname.toLowerCase();
  return host === 'localhost'
    || host === '[::1]'
    || host === '::1'
    || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function refuse(label, message) {
  throw new Error(`[${label}] Refusing destructive database test: ${message}`);
}

export function armDestructiveTestDatabase(label = 'destructive-test') {
  if (process.env.ALLOW_DESTRUCTIVE_DB_TESTS !== '1') {
    refuse(label, 'set ALLOW_DESTRUCTIVE_DB_TESTS=1 to acknowledge destructive writes.');
  }

  const raw = process.env.TEST_DATABASE_URL?.trim();
  if (!raw) {
    refuse(label, 'TEST_DATABASE_URL is required; DATABASE_URL is deliberately ignored.');
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    refuse(label, 'TEST_DATABASE_URL is not a valid URL.');
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    refuse(label, 'TEST_DATABASE_URL must use the postgres or postgresql protocol.');
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  } catch {
    refuse(label, 'the database name in TEST_DATABASE_URL is malformed.');
  }
  if (!databaseName || !CLEAR_TEST_DATABASE_NAME.test(databaseName)) {
    refuse(
      label,
      'the database name must contain a distinct "test", "testing", or "disposable" segment (for example, football_test).',
    );
  }

  if (!isLocalDatabaseHost(url.hostname)
      && process.env.ALLOW_REMOTE_DESTRUCTIVE_DB_TESTS !== '1') {
    refuse(
      label,
      `host ${url.hostname} is not local; set ALLOW_REMOTE_DESTRUCTIVE_DB_TESTS=1 to acknowledge the remote target.`,
    );
  }

  // Application modules read DATABASE_URL at import time. Only expose the
  // separately named, validated test URL after every destructive-test check passes.
  process.env.DATABASE_URL = raw;
  console.log(`[${label}] destructive database test armed for ${url.hostname}/${databaseName}`);

  return { hostname: url.hostname, databaseName };
}
