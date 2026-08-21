-- Explosiveness, down/distance (standard-downs vs passing-downs) success-
-- rate splits, and sack rate -- part of the component-model rebuild
-- replacing the removed SOS metric (see 0008 for the sosWeight=0 change
-- and RatingParams.pointsPerExplosiveness's doc for the full rationale).
--
-- off_explosiveness/def_explosiveness and the *_downs_success_rate columns
-- come from the SAME CFBD /stats/game/advanced response syncCfbdGameStats
-- already fetches (confirmed real fields via CFBD's own client library
-- docs -- see ingest/cfbd/client.ts's CfbdAdvancedSide) -- no new API call,
-- just more fields off an existing one. Re-running syncCfbdGameStats for
-- already-ingested seasons backfills these via the existing upsert.
--
-- off_sack_rate/def_sack_rate come from a genuinely separate source
-- (CFBD's /plays, aggregated per team per game -- see
-- ingest/cfbd/syncSackRateStats.ts), same "second, separate ingestion
-- pass with a targeted UPDATE" pattern as garbage-time and turnover stats.
--
-- All nullable, independent of the row's existence -- same degrade-to-
-- baseline pattern as every other optional stat column in this table.
ALTER TABLE team_game_stats ADD COLUMN off_explosiveness numeric;
ALTER TABLE team_game_stats ADD COLUMN def_explosiveness numeric;
ALTER TABLE team_game_stats ADD COLUMN off_standard_downs_success_rate numeric;
ALTER TABLE team_game_stats ADD COLUMN off_passing_downs_success_rate numeric;
ALTER TABLE team_game_stats ADD COLUMN def_standard_downs_success_rate numeric;
ALTER TABLE team_game_stats ADD COLUMN def_passing_downs_success_rate numeric;
ALTER TABLE team_game_stats ADD COLUMN off_sack_rate numeric;
ALTER TABLE team_game_stats ADD COLUMN def_sack_rate numeric;
