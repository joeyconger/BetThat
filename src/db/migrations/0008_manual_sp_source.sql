-- Adds a third external_ratings source: 'manual_sp_weekly' -- real week-by-
-- week SP+ (overall, offense, defense, special teams sub-ratings) from a
-- manually-provided archive spreadsheet, not a live API. CFBD's own
-- /ratings/sp confirmed (via their real Python client docs) to accept only
-- year+team, no week param -- it cannot give week-level history at all, so
-- this is the only source of real in-season SP+ movement this project has.
-- Same week-nullable shape as 'cfbd_elo' (week IS NOT NULL, one row per
-- team per week), reusing external_ratings' existing partial-index upsert
-- logic untouched -- see 0003_external_ratings.sql.
--
-- Postgres won't let you ALTER a CHECK constraint's condition directly;
-- drop and recreate it. external_ratings_source_check is the
-- auto-generated name for the original inline CHECK (source IN (...)).
ALTER TABLE external_ratings DROP CONSTRAINT external_ratings_source_check;
ALTER TABLE external_ratings ADD CONSTRAINT external_ratings_source_check
  CHECK (source IN ('cfbd_sp', 'cfbd_elo', 'manual_sp_weekly'));
