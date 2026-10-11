CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The display name this session presents on the leaderboard (GLOSSARY.md).
-- Optional: a session that has never chosen one still plays, and shows up
-- unnamed. Not an identity — nothing here is verified. The bound is the same one
-- src/tag.ts applies, said again here so the invariant holds however the row was
-- written; the two must be changed together.
--
-- An ALTER rather than a column in the CREATE above, because CREATE TABLE IF NOT
-- EXISTS is a no-op against a table that already exists, and this has to reach
-- the databases that were made before the tag did.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS tag TEXT
  CHECK (tag IS NULL OR length(tag) BETWEEN 1 AND 16);

-- A session plays more than one round: finishing one offers a new one. What is
-- unique is the round in progress, and it is the database rather than the
-- application that says so, for the same reason the old UNIQUE (session_id) did:
-- two requests arriving together for a session with no live round must produce
-- one round rather than a race between two.
CREATE TABLE IF NOT EXISTS rounds (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  elapsed_ms  INTEGER
);

ALTER TABLE rounds DROP CONSTRAINT IF EXISTS rounds_session_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS rounds_one_live_per_session
  ON rounds (session_id) WHERE finished_at IS NULL;

-- The table is called `targets` because that is the name the spec fixed, but a
-- row here is a Character; x/y/w/h are its Target box. See GLOSSARY.md.
--
-- DOUBLE PRECISION, not REAL: a target box is a fraction of the picture, not a
-- pixel count, so 32-bit floats buy nothing and cost accuracy. As REAL, the
-- check constraints below reject a character flush with the picture's edge,
-- because 0.999 + 0.001 rounds to 1.0000000149.
CREATE TABLE IF NOT EXISTS targets (
  id     SERIAL PRIMARY KEY,
  name   TEXT NOT NULL UNIQUE,
  x      DOUBLE PRECISION NOT NULL CHECK (x >= 0 AND x < 1),
  y      DOUBLE PRECISION NOT NULL CHECK (y >= 0 AND y < 1),
  w      DOUBLE PRECISION NOT NULL CHECK (w > 0 AND x + w <= 1),
  h      DOUBLE PRECISION NOT NULL CHECK (h > 0 AND y + h <= 1)
);

CREATE TABLE IF NOT EXISTS finds (
  round_id UUID NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  PRIMARY KEY (round_id, target_id)
);

CREATE INDEX IF NOT EXISTS rounds_elapsed_idx ON rounds (elapsed_ms) WHERE elapsed_ms IS NOT NULL;