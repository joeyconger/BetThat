-- "Finishing drives" (points per scoring opportunity) -- Phase 2 of the
-- component-model rebuild (see 0009 for Phase 1: explosiveness/splits/
-- sack rate). Sourced from CFBD's /drives endpoint (a genuinely different
-- endpoint than /stats/game/advanced, which has no such field), aggregated
-- per team per game by ingest/cfbd/syncFinishingDrivesStats.ts.
--
-- off_finishing_drives_ppo = avg points scored per drive this team's
-- offense started inside the opponent's 40 (a "scoring opportunity"),
-- higher = better, same off/def sign convention as every component
-- EXCEPT sack rate. def_finishing_drives_ppo = avg points ALLOWED per
-- opportunity this team's defense faced, higher = worse.
--
-- Nullable, same degrade-to-baseline pattern as every other optional
-- column here -- also legitimately NULL (not 0) for a team with zero
-- qualifying drives in a game, a meaningfully different fact from "scored
-- nothing on every opportunity" (see syncFinishingDrivesStats.ts's doc).
ALTER TABLE team_game_stats ADD COLUMN off_finishing_drives_ppo numeric;
ALTER TABLE team_game_stats ADD COLUMN def_finishing_drives_ppo numeric;
