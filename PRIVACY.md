# Data and privacy

The Sweep is intended for a small, invite-only group. The person operating a
deployment is responsible for telling participants how their data is used and
for meeting any applicable legal obligations.

## Data stored

- Email address, display name, colour choice, and organiser status
- Team allocations, scores, and game activity
- Hashed one-time tokens, request IP addresses, and signed anti-abuse identifiers
- Short administrative audit entries
- Optional provider content cached for display

The session cookie is HTTP-only, same-site, and secure in production. The
browser never receives a participant's email address except for the signed-in
person's own address.

## Visibility

- Anonymous callers receive only the unauthenticated landing state.
- Signed-in participants can see the other participants' display names, team
  allocations, standings, and match data.
- Organisers can see additional audit and abuse-control information.

Do not use a sensitive real-world identity as a display name.

## Retention

- One-time token records: up to 7 days
- Non-banned abuse-control records: up to 30 days
- Banned abuse-control records: up to 365 days
- Administrative audit entries: up to 90 days
- Guardian content: no more than 24 hours without refresh
- Player accounts and game records: until the operator removes or resets them

Cleanup runs on startup and daily while the service is running.

Application logs avoid one-time links and raw throttle identifiers. Hosting,
email, database, and content providers may maintain their own logs under their
respective policies.

## Deletion

The organiser can remove players before the draw and reset a game from the
admin interface. Complete account or backup deletion may require the operator
to remove the corresponding database records and retained backups.

## Third-party services

Depending on configuration, a deployment may send data to Railway, PostgreSQL,
Resend, API-Football, Guardian Open Platform, BBC Sport, Cloudflare, and Google
Fonts. Review those providers before enabling them.
