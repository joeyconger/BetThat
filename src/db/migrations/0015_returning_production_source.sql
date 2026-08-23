-- Adds a fourth external_ratings source: 'cfbd_returning_production' --
-- CFBD's /player/returning, season-final only (week always NULL, same
-- shape as 'cfbd_sp'), storing percentPPA (the combined returning-
-- production fraction -- see client.ts's getReturningProduction doc for
-- why NOT the passing/receiving/rushing sub-splits, which is the whole
-- available breakdown; this endpoint has no offense/defense split).
-- Reuses external_ratings' existing partial-index upsert logic untouched
-- -- see 0003_external_ratings.sql and 0008_manual_sp_source.sql for the
-- same drop-and-recreate pattern this follows.
ALTER TABLE external_ratings DROP CONSTRAINT external_ratings_source_check;
ALTER TABLE external_ratings ADD CONSTRAINT external_ratings_source_check
  CHECK (source IN ('cfbd_sp', 'cfbd_elo', 'manual_sp_weekly', 'cfbd_returning_production'));
