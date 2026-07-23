# Security policy

## Supported version

Security fixes are applied to the current `main` branch.

## Report a vulnerability

Please use [GitHub private vulnerability
reporting](https://github.com/atk0309/project_TheSweep/security/advisories/new).
Do not disclose authentication bypasses, tokens, personal data, or exploitable
deployment details in a public issue.

Include:

- affected commit or deployment version;
- reproducible steps;
- impact and prerequisites;
- any suggested mitigation.

## Deployment baseline

A production deployment must provide:

- `NODE_ENV=production` and no `ALLOW_INSECURE_DEVELOPMENT` opt-in;
- a random `SESSION_SECRET` of at least 32 characters;
- a verified HTTPS `APP_URL`;
- PostgreSQL with certificate verification;
- a configured Resend sender and API key;
- an explicit `ADMIN_EMAILS` allowlist;
- provider integrations enabled only after their terms are reviewed.

Production configuration validation fails closed. One-time sign-in links are
never written to production logs. Anonymous callers receive no participant or
allocation data.

Integration helpers are destructive by design and must only run against a
disposable test database.
