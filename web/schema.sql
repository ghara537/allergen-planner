-- Append-only. Two phones inserting different rows never conflict, which is
-- why the data model and the storage engine agree.
CREATE TABLE IF NOT EXISTS children (
  id                     TEXT PRIMARY KEY,
  family_id              TEXT NOT NULL,
  name                   TEXT NOT NULL,
  birth_date             TEXT NOT NULL,
  risk_tier              TEXT NOT NULL,
  jurisdiction           TEXT NOT NULL,
  readiness_confirmed_on TEXT,
  clinician_cleared      TEXT NOT NULL DEFAULT '[]',
  excluded               TEXT NOT NULL DEFAULT '[]',
  settings               TEXT NOT NULL DEFAULT '{}',
  updated_at             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_children_family ON children(family_id);

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  family_id  TEXT NOT NULL,
  child_id   TEXT NOT NULL,
  allergen   TEXT NOT NULL,
  day        TEXT NOT NULL,
  kind       TEXT NOT NULL,
  dose_json  TEXT,
  supersedes TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_family ON events(family_id, created_at);

-- How a food's amount changes over time. Immutable: an edit writes a new row
-- that supersedes the old one, so history explains itself.
CREATE TABLE IF NOT EXISTS dose_plans (
  id             TEXT PRIMARY KEY,
  family_id      TEXT NOT NULL,
  child_id       TEXT NOT NULL,
  allergen       TEXT NOT NULL,
  effective_from TEXT NOT NULL,
  start_amount   REAL NOT NULL,
  unit           TEXT NOT NULL DEFAULT '',
  increment      REAL NOT NULL DEFAULT 0,
  increment_mode TEXT NOT NULL DEFAULT 'add',
  every_days     INTEGER NOT NULL DEFAULT 7,
  feed_every_days INTEGER NOT NULL DEFAULT 1,
  reactive       INTEGER NOT NULL DEFAULT 0,
  source         TEXT NOT NULL DEFAULT '',
  supersedes     TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_family ON dose_plans(family_id, created_at);

-- What a particular day actually looked like, when it differed from the
-- default nap schedule. Append-only: an edit supersedes, so two phones
-- adjusting the same day converge instead of clobbering.
CREATE TABLE IF NOT EXISTS day_overrides (
  id         TEXT PRIMARY KEY,
  family_id  TEXT NOT NULL,
  child_id   TEXT NOT NULL,
  day        TEXT NOT NULL,
  naps_json  TEXT NOT NULL,
  supersedes TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ov_family ON day_overrides(family_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ov_day ON day_overrides(child_id, day);
