-- The Sweep — schema. Idempotent (CREATE TABLE IF NOT EXISTS); run every boot.

-- ── Single-row game state (the draw lock target) ──────────────────────────
CREATE TABLE IF NOT EXISTS game (
  id          int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  status      text NOT NULL DEFAULT 'registration_open'
              CHECK (status IN ('registration_open','drawn','in_progress','complete','archived')),
  join_code   text NOT NULL DEFAULT 'SWEEP1',
  drawn_at    timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO game (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── Players ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS players (
  id              serial PRIMARY KEY,
  email           text NOT NULL UNIQUE,           -- always stored lower-cased
  display_name    text,                            -- NULL until onboard
  monogram_color  text NOT NULL DEFAULT '#00e676',
  is_admin        boolean NOT NULL DEFAULT false,
  removed         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ── Magic-link tokens (only the SHA-256 hash is stored) ───────────────────
CREATE TABLE IF NOT EXISTS magic_tokens (
  id          serial PRIMARY KEY,
  email       text NOT NULL,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  request_ip  text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS magic_tokens_email_idx ON magic_tokens (email);
-- Recency index for the global send-rate cap (counts links issued in a window).
CREATE INDEX IF NOT EXISTS magic_tokens_created_idx ON magic_tokens (created_at);

-- ── Magic-link abuse throttle: escalating, per-identity ───────────────────
-- One row per (scope, identifier). scope ∈ {'ip','cookie','email'}.
-- 5 attempts → 15-min cooldown → 5 → 1-hour cooldown → 5 → long-lived ban.
-- Monotonic: strikes only reset via the admin clear route (/api/throttle/clear).
CREATE TABLE IF NOT EXISTS auth_throttle (
  scope          text NOT NULL,                 -- 'ip' | 'cookie' | 'email'
  identifier     text NOT NULL,                 -- IP / signed-cookie id / normalized email
  attempts       int  NOT NULL DEFAULT 0,       -- attempts used in the CURRENT burst
  strikes        int  NOT NULL DEFAULT 0,       -- completed bursts (1→15m, 2→1h, 3→ban)
  cooldown_until timestamptz,                   -- NULL = not cooling down
  banned         boolean NOT NULL DEFAULT false,
  first_seen     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, identifier)
);
CREATE INDEX IF NOT EXISTS auth_throttle_active_idx ON auth_throttle (cooldown_until)
  WHERE banned OR cooldown_until IS NOT NULL;

-- ── Teams (48, seeded from server/teams.seed.json on boot) ────────────────
CREATE TABLE IF NOT EXISTS teams (
  id            serial PRIMARY KEY,
  idx           int NOT NULL UNIQUE,              -- 0..47 design order
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  group_letter  char(1) NOT NULL,
  flag          text NOT NULL,                    -- verbatim CSS gradient
  api_team_id   int                               -- filled by the poller (name match)
);
CREATE INDEX IF NOT EXISTS teams_api_idx ON teams (api_team_id);

-- ── Draw result: one owner per team (team_id PK = DB invariant) ───────────
CREATE TABLE IF NOT EXISTS allocations (
  team_id     int PRIMARY KEY REFERENCES teams(id),
  player_id   int NOT NULL REFERENCES players(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS allocations_player_idx ON allocations (player_id);

-- ── Fixtures (schedule + score + source). API id is the PK. ───────────────
CREATE TABLE IF NOT EXISTS fixtures (
  id              bigint PRIMARY KEY,              -- API-Football fixture id
  stage           text NOT NULL DEFAULT 'Group Stage',
  round_ord       int  NOT NULL DEFAULT 0,         -- 0=group,1=R32,2=R16,3=QF,4=SF,5=Final
  group_letter    char(1),
  home_api_id     int,
  away_api_id     int,
  home_team_id    int REFERENCES teams(id),        -- resolved; NULL if unmatched/TBD
  away_team_id    int REFERENCES teams(id),
  kickoff         timestamptz,
  elapsed         int,                             -- live minute
  status          text NOT NULL DEFAULT 'NS',      -- NS|1H|HT|2H|ET|P|FT|AET|PEN|PST|CANC
  home_goals      int,
  away_goals      int,
  home_pen        int,
  away_pen        int,
  winner_team_id  int REFERENCES teams(id),        -- for KO wins / champion (handles ET/pens)
  source          text NOT NULL DEFAULT 'api',     -- 'api' | 'manual' (manual is authoritative)
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS fixtures_kickoff_idx ON fixtures (kickoff);
CREATE INDEX IF NOT EXISTS fixtures_status_idx ON fixtures (status);
-- self-healing column adds (no migration tool; safe on every boot)
ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS elapsed int;
-- Set once a finished fixture's event timeline has been pulled (avoids refetch).
ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS events_synced_at timestamptz;
-- Live-commentary (Guardian liveblog) discovery/poll state — 1:1 with a fixture.
ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS guardian_blog_id     text;
ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS commentary_state     text NOT NULL DEFAULT 'unknown';
  -- 'unknown' (not yet found) | 'found' (blog id cached) | 'missing' (gave up) | 'done' (final flush complete)
ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS commentary_misses    int  NOT NULL DEFAULT 0;
ALTER TABLE fixtures ADD COLUMN IF NOT EXISTS commentary_polled_at timestamptz;

-- ── Match events (goal/card/subst) — drives the news ticker (deferred) ────
CREATE TABLE IF NOT EXISTS match_events (
  id          serial PRIMARY KEY,
  fixture_id  bigint NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  minute      int,
  team_id     int REFERENCES teams(id),
  player      text,
  type        text,
  detail      text,
  dedupe_key  text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── Live match commentary (Guardian liveblog blocks) ─────────────────────
-- Block ids are globally unique, so a plain UNIQUE(block_id) is enough. Unlike
-- match_events (DO NOTHING), this is upserted (DO UPDATE): Guardian editors
-- revise liveblog blocks in place, so re-ingest should refresh body/title.
CREATE TABLE IF NOT EXISTS match_commentary (
  id            serial PRIMARY KEY,
  fixture_id    bigint NOT NULL REFERENCES fixtures(id) ON DELETE CASCADE,
  block_id      text NOT NULL UNIQUE,           -- Guardian block id
  published_at  timestamptz,
  title         text,
  body          text,                           -- cleaned bodyTextSummary (plain text)
  is_key_event  boolean NOT NULL DEFAULT false,
  minute        int,                            -- best-effort parse; NULL ok (the timeline orders by this, publish-time as fallback)
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS match_commentary_fix_pub_idx
  ON match_commentary (fixture_id, published_at DESC, block_id DESC);

-- ── News (Guardian + BBC Sport) — general feed + per-match headlines ─────
CREATE TABLE IF NOT EXISTS news (
  id           serial PRIMARY KEY,
  source       text NOT NULL,                 -- 'Guardian' | 'BBC Sport'
  title        text NOT NULL,
  url          text NOT NULL,
  trail        text,
  image        text,
  published_at timestamptz,
  is_live      boolean NOT NULL DEFAULT false, -- Guardian live blog
  dedupe_key   text NOT NULL UNIQUE,           -- = url
  fetched_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS news_published_idx ON news (published_at DESC);

-- ── Group standings (from the API; qualification is read, never computed) ─
CREATE TABLE IF NOT EXISTS standings (
  team_id       int PRIMARY KEY REFERENCES teams(id),
  group_letter  char(1),
  played        int NOT NULL DEFAULT 0,
  w             int NOT NULL DEFAULT 0,
  d             int NOT NULL DEFAULT 0,
  l             int NOT NULL DEFAULT 0,
  gf            int NOT NULL DEFAULT 0,
  ga            int NOT NULL DEFAULT 0,
  points        int NOT NULL DEFAULT 0,
  rank          int,
  alive         boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ── Admin audit log ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id               serial PRIMARY KEY,
  actor_player_id  int REFERENCES players(id),
  actor_label      text,
  action           text NOT NULL,
  detail           jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_created_idx ON audit_log (created_at DESC);
