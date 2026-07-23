# Deployment runbook

This runbook uses one Railway application service, one Railway PostgreSQL
service, an optional Cloudflare-managed domain, Resend, and optional content/data
providers.

Read [PRIVACY.md](PRIVACY.md) and the provider terms linked below before
accepting real users.

## 1. Create the services

1. Create a Railway project and deploy an authorised copy of this repository.
2. Add a PostgreSQL service to the same project.
3. Keep the application at one replica. Polling and provider request budgets are
   intentionally coordinated inside one process.
4. Railway uses `railway.json`, runs `npm start`, and checks `/healthz`.

The schema and initial 48-team placeholder set are installed on boot.

## 2. Configure production variables

Generate a secret:

```bash
openssl rand -hex 32
```

Set these variables on the application service:

```text
NODE_ENV=production
DATABASE_URL=${{Postgres.DATABASE_URL}}
SESSION_SECRET=<at least 32 random characters>
APP_URL=https://sweep.example.com
RESEND_API_KEY=<your Resend key>
EMAIL_FROM=The Sweep <noreply@example.com>
ADMIN_EMAILS=admin@example.com
FOOTBALL_API_KEY=<optional API-Football key>
NEWS_ENABLED=0
COMMENTARY_ENABLED=0
```

Never set `ALLOW_INSECURE_DEVELOPMENT` on an internet-facing deployment. If the
explicit local opt-in is absent, the app treats the runtime as production and
requires the secure configuration above.

`ADMIN_EMAILS` is the source of truth for organiser access. Removing an address
from it removes admin privileges on that person's next authenticated request.

Keep `DATABASE_SSL_REJECT_UNAUTHORIZED=1` for remote databases with a valid
certificate. Setting it to `0` disables certificate verification and should be a
deliberate exception for a trusted, self-signed endpoint only.

## 3. Optional providers

### Match data

Create an API-Football key at <https://dashboard.api-football.com> and validate
the status, fixture, and standings endpoints before running the draw. A service
subscription does not automatically grant every publication right; review the
[API-Football terms](https://www.api-football.com/terms) for your use.

### News and commentary

News and commentary are off by default.

- Set `NEWS_ENABLED=1` to fetch Guardian and BBC Sport headlines.
- Set `COMMENTARY_ENABLED=1` and `GUARDIAN_API_KEY` to fetch Guardian live
  commentary.
- Guardian developer access is non-commercial. Review the [access
  tiers](https://open-platform.theguardian.com/access/) and [Open Platform
  terms](https://www.theguardian.com/open-platform/terms-and-conditions).
- BBC Sport content remains subject to the [BBC's RSS
  guidance](https://www.bbc.co.uk/sport/articles/cqllxj2n4kyo).

The application expires Guardian content within 24 hours and renders provider
attribution. Operators remain responsible for ensuring their use is permitted.

## 4. Configure email

Verify a sending domain in Resend and set `EMAIL_FROM` to an address on that
domain. Test delivery to at least one non-owner mailbox before inviting players.

Production startup fails if Resend or another security-critical variable is
missing. One-time links are never written to production logs.

## 5. Add a custom domain

1. In Railway, add `sweep.example.com` as a custom domain.
2. Add the exact CNAME and ownership-verification TXT records Railway provides
   to Cloudflare.
3. Leave records DNS-only until Railway reports the domain and certificate as
   active.
4. If you proxy the record through Cloudflare, use SSL/TLS mode **Full**. Do not
   use Flexible.

DNS and certificate activation can take time. Follow Railway's [custom-domain
guidance](https://docs.railway.com/networking/domains/working-with-domains).

## 6. Release checks

Before inviting players:

```bash
curl --fail --show-error https://sweep.example.com/healthz
```

Then verify:

- [ ] The latest Railway deployment reached `SUCCESS`.
- [ ] `/healthz` returns HTTP 200 and `{"ok":true}`.
- [ ] Logs show `schema ready`.
- [ ] A configured admin can request and consume a magic link.
- [ ] Resend delivers to a non-owner mailbox.
- [ ] Real teams and fixtures loaded before the draw, or manual mode is
      intentional.
- [ ] The custom domain has a valid certificate.
- [ ] Provider usage, attribution, and publication rights were reviewed.
- [ ] Database backup/restore has been tested.

The app is invite-only. Invite players from the organiser interface while
registration is open, then run the draw once everyone has joined.

## Rollback and data safety

- Roll back the application from Railway's deployment history.
- Restore PostgreSQL from a tested backup when data rollback is required.
- Use **Admin → match override** if the data API is delayed; manual results are
  authoritative and are not overwritten by the poller.
- Never point `scripts/*test*.mjs` or integration helpers at production. They
  require an explicit disposable-test-database opt-in for a reason.
