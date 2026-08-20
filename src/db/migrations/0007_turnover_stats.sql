-- Turnover-play PPA sums + play counts, split by side (offense = team lost
-- the ball, defense = team forced the turnover), alongside the existing
-- off_epa_play/def_epa_play aggregates -- not a replacement. Sourced from
-- CFBD's /plays endpoint (not /stats/game/advanced, which has no turnover
-- breakout), aggregated per team per game by ingest/cfbd/syncTurnoverStats.ts
-- using the confirmed turnover play_type set: "Fumble Recovery (Opponent)",
-- "Fumble Return Touchdown", "Interception", "Pass Interception Return",
-- "Interception Return Touchdown" -- explicitly excluding "Fumble Recovery
-- (Own)" (offense keeps the ball, not a turnover).
--
-- These feed a reweighted-average recompute in ratings/elo.ts
-- (RatingParams.turnoverLuckWeight), not a flat subtraction:
--   strippedEpa = (rawEpa * totalPlays - turnoverPpaSum) / (totalPlays - turnoverPlays)
-- `totalPlays` there is the existing plays_offense/plays_defense column
-- (itself sourced from /stats/game/advanced, a different CFBD endpoint than
-- /plays) -- this assumes the two endpoints' play universes line up closely
-- enough for the reweighting to be valid; not independently verified against
-- a live response yet, only reasoned about from taxonomy alone.
--
-- Nullable and independent of the row's existence, same as
-- 0006_garbage_time_stats.sql: a game can have raw stats ingested with these
-- still null until the turnover-stats ingestion pass runs for it.
ALTER TABLE team_game_stats ADD COLUMN off_turnover_ppa_sum numeric;
ALTER TABLE team_game_stats ADD COLUMN off_turnover_plays int;
ALTER TABLE team_game_stats ADD COLUMN def_turnover_ppa_sum numeric;
ALTER TABLE team_game_stats ADD COLUMN def_turnover_plays int;
