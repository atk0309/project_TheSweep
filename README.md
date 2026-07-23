# The Sweep

The Sweep is an invite-only sweepstake for a 2026 international football
tournament. An organiser invites players by email, the app randomly distributes
48 teams, and live results drive a shared leaderboard.

> This is an unofficial, independent project. It is not affiliated with,
> endorsed by, or sponsored by any tournament organiser, football federation,
> broadcaster, news publisher, or data provider.

## Features

- Passwordless, single-use magic-link sign-in
- Invite-only registration and organiser controls
- Cryptographically shuffled, atomic team allocation
- Live fixtures, standings, events, scoring, and manual score overrides
- Persistent multi-identity rate limiting for email sends
- Optional news and live-commentary integrations
- Responsive single-page interface with no client-side database access

## Architecture

- `server/` — Node.js 22, Express, and raw PostgreSQL queries
- `public/` — the application shell plus vendored browser runtime assets
- `scripts/` — safe checks and explicitly guarded integration helpers
- `railway.json` — single-service Railway deployment configuration

The Node service serves the UI, owns all database access, exposes the API, and
runs the optional polling jobs. PostgreSQL is the only datastore.

## Quick start

Prerequisites: Node.js 22+, npm 10+, Docker, and Chromium for the browser smoke
test.

```bash
npm ci
docker run -d --name sweep-postgres \
  -e POSTGRES_USER=sweep \
  -e POSTGRES_PASSWORD=sweep \
  -e POSTGRES_DB=sweep \
  -p 5432:5432 \
  postgres:16
cp .env.example .env
npm start
```

Open `http://localhost:3999`.

In development only, an unset `RESEND_API_KEY` prints the one-time sign-in link
to the local server console. Production startup rejects missing security-critical
configuration.

## Configuration

| Variable | Required in production | Purpose |
|---|---:|---|
| `PORT` | No | HTTP port; defaults to `3999` |
| `NODE_ENV` | Yes | Set to `production` outside local development |
| `ALLOW_INSECURE_DEVELOPMENT` | Local only | Set `1` only in a private local environment; never deploy it |
| `DATABASE_URL` | Yes | PostgreSQL connection URL |
| `DATABASE_SSL_REJECT_UNAUTHORIZED` | No | Defaults to verified TLS; set `0` only for a deliberately self-signed remote database |
| `SESSION_SECRET` | Yes | JWT signing secret, at least 32 characters |
| `APP_URL` | Yes | Public HTTPS origin used in sign-in links |
| `RESEND_API_KEY` | Yes | Resend API key |
| `EMAIL_FROM` | Yes | Verified sender, such as `The Sweep <noreply@example.com>` |
| `ADMIN_EMAILS` | Yes | Comma-separated organiser addresses; this is the admin source of truth |
| `FOOTBALL_API_KEY` | No | API-Football key for fixtures and results |
| `FOOTBALL_API_BASE` | No | API-Football endpoint override |
| `POLLER_DISABLED` | No | Set `1` to disable football polling |
| `NEWS_ENABLED` | No | Set `1` to opt into Guardian/BBC Sport news fetching |
| `COMMENTARY_ENABLED` | No | Set `1` to opt into Guardian live commentary |
| `GUARDIAN_API_KEY` | For Guardian features | Guardian Open Platform developer key |
| `GUARDIAN_DAILY_BUDGET` | No | Daily Guardian request ceiling; default `500` |
| `GUARDIAN_NEWS_RESERVE` | No | Requests reserved for news; default `200` |
| `SEND_CAP_HOUR` | No | Global magic-link hourly ceiling; default `100` |
| `SEND_CAP_DAY` | No | Global magic-link daily ceiling; default `500` |
| `MIN_DRAW_PLAYERS` | No | Minimum players required to draw; default `2` |

See [.env.example](.env.example) for a local template.

## Checks

```bash
npm run check
```

This runs syntax checks plus the database-free throttle tests.

For the browser smoke test, start the local service first, install Chromium once,
then run:

```bash
npx playwright install chromium
npm run smoke -- http://localhost:3999
```

The poller, live-ingest, and full browser helpers alter application state. They
refuse to run unless pointed at a clearly named disposable test database with an
explicit opt-in:

```bash
ALLOW_DESTRUCTIVE_DB_TESTS=1 \
TEST_DATABASE_URL=postgres://sweep:sweep@localhost:5432/sweep_test \
npm run integration:poller
```

Never run integration helpers against production or a database containing data
you care about.

## Scoring

- Group win: +3
- Group draw: +1
- Goal by an owned team: +1, excluding shoot-outs
- Knockout win: +3
- Reach bonuses: round of 16 +4, quarter-final +8, semi-final +12, final +16
- Champion: +24

Reach bonuses stack.

## Data providers and branding

Provider integrations are opt-in and remain subject to their own terms.
Operators are responsible for obtaining any publication rights their use
requires. Guardian developer access is non-commercial and cached Guardian
content is limited to 24 hours. The interface identifies Guardian and BBC Sport
content at the point of display.

No official tournament logos are included. Names and competition references are
descriptive only; trademarks belong to their respective owners.

See [DEPLOY.md](DEPLOY.md), [PRIVACY.md](PRIVACY.md), and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) before operating a public
instance.

## Security and licence

Please report vulnerabilities through [GitHub private vulnerability
reporting](https://github.com/atk0309/project_TheSweep/security/advisories/new), not a
public issue. See [SECURITY.md](SECURITY.md).

Project-authored code and assets are available under the [MIT
License](LICENSE). Third-party components and provider content retain their own
licences and terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
