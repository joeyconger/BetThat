-- Adds two more external_ratings sources: 'own_epa_solve_off' and
-- 'own_epa_solve_def' -- our OWN season-final iterative opponent-
-- adjustment solve (opponentAdjust.ts, computed over garbage-time-weighted
-- EPA, see ratings/gamePerformance.ts's buildTeamPerformancesEpa), stored
-- so the NEXT season's solve can use it as a real preseason prior
-- (weighted pseudo-games, ratings/solveRatings.ts) without recomputing an
-- entire prior season's raw-play solve on every single prediction call.
--
-- Two rows per team (off, def) rather than one, since off/def is not a
-- single number the way cfbd_sp/cfbd_returning_production are -- same
-- reasoning as manual_sp_weekly's offSp/defSp/stSp fields being kept
-- separate, just actually used here (see syncManualSpWeekly.ts's doc for
-- why those specific fields aren't ingested yet). week always NULL
-- (season-final only, same convention as cfbd_sp).
ALTER TABLE external_ratings DROP CONSTRAINT external_ratings_source_check;
ALTER TABLE external_ratings ADD CONSTRAINT external_ratings_source_check
  CHECK (source IN ('cfbd_sp', 'cfbd_elo', 'manual_sp_weekly', 'cfbd_returning_production', 'own_epa_solve_off', 'own_epa_solve_def'));
