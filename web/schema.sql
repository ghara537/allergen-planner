-- Append-only event log. Two phones inserting different rows never conflict,
-- which is why the data model and the storage engine agree.
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

CREATE TABLE IF NOT EXISTS prescriptions (
  id          TEXT PRIMARY KEY,
  family_id   TEXT NOT NULL,
  child_id    TEXT NOT NULL,
  allergen    TEXT NOT NULL,
  entered_on  TEXT NOT NULL,
  attribution TEXT NOT NULL,
  steps_json  TEXT NOT NULL,
  supersedes  TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rx_family ON prescriptions(family_id, created_at);
