-- Garbage-time-excluded EPA/success rate, alongside the existing all-plays
-- columns -- not a replacement. CFBD's /stats/game/advanced accepts an
-- excludeGarbageTime param on the exact same endpoint already in use (no
-- new data source), so this is a second, targeted ingestion pass per game
-- that fills in these columns via UPDATE, leaving the original off_epa_play
-- etc. untouched. Keeping both lets the rating engine (ratings/elo.ts,
-- RatingParams.excludeGarbageTime) A/B the two rather than blindly
-- switching and hoping -- same discipline as successRateWeight.
--
-- Nullable and independent of the row's existence: a game can have raw
-- stats ingested (source='cfbd') with these still null until the
-- garbage-time-excluded pass runs for it.
ALTER TABLE team_game_stats ADD COLUMN off_epa_play_no_garbage numeric;
ALTER TABLE team_game_stats ADD COLUMN def_epa_play_no_garbage numeric;
ALTER TABLE team_game_stats ADD COLUMN off_success_rate_no_garbage numeric;
ALTER TABLE team_game_stats ADD COLUMN def_success_rate_no_garbage numeric;
