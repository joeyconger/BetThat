-- External power ratings, distinct from our own model's team_ratings.
-- Two sources with different granularity:
--   'cfbd_sp'   — season-final only (CFBD's /ratings/sp has no week param), week is NULL.
--   'cfbd_elo'  — CFBD's own weekly-updated Elo (/ratings/elo takes a week param), week is set.
CREATE TABLE external_ratings (
  id serial PRIMARY KEY,
  team_id int NOT NULL REFERENCES teams (id),
  season int NOT NULL,
  week int,
  source text NOT NULL CHECK (source IN ('cfbd_sp', 'cfbd_elo')),
  rating numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Two partial unique indexes instead of one plain UNIQUE: Postgres treats
-- NULL as distinct from NULL for uniqueness, so a single (team_id, season,
-- week, source) constraint would silently let 'cfbd_sp' rows (week always
-- NULL) duplicate on every re-sync instead of upserting.
CREATE UNIQUE INDEX external_ratings_season_final_idx ON external_ratings (team_id, season, source) WHERE week IS NULL;
CREATE UNIQUE INDEX external_ratings_weekly_idx ON external_ratings (team_id, season, week, source) WHERE week IS NOT NULL;

CREATE INDEX external_ratings_lookup_idx ON external_ratings (source, team_id, season, week);
