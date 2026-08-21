-- Phase 3 of the component-model rebuild: special teams. Scoped to field
-- position and field goal make rate -- punt/return efficiency deliberately
-- deferred (not silently dropped): net punting and return-yardage
-- attribution aren't verified against a real CFBD response from this
-- sandbox, and "defense can't really control the opponent's own punt
-- distance" breaks the off/def paired architecture every other component
-- uses, unlike field position and FG rate which both have a genuine,
-- symmetric off/def interpretation.
--
-- off_field_position/def_field_position: avg distance (yards) from a
-- team's OWN goal line at the start of each drive (100 - start_yards_to_goal,
-- so HIGHER = better starting position, standard off/def sign convention)
-- -- off_* = this team's own offensive drives, def_* = the OPPONENT's
-- drives when facing this team's defense (so def_* measures kickoff/punt
-- coverage quality: a defense that pins opponents deep has a LOW def_*).
-- Sourced from CFBD's /drives (same endpoint as Phase 2's finishing
-- drives -- see ingest/cfbd/syncSpecialTeamsStats.ts).
--
-- off_fg_make_rate/def_fg_make_rate: made / (made+missed+blocked) --
-- off_* = this team's own kicker, def_* = the opponent's kicker when
-- facing this team's defense (defense affects this via pressure/blocks).
-- Sourced from CFBD's /plays.
--
-- All nullable, same degrade-to-baseline pattern as every other optional
-- column -- also legitimately NULL (not 0) for a team with zero FG
-- attempts (offense or allowed) in a game.
ALTER TABLE team_game_stats ADD COLUMN off_field_position numeric;
ALTER TABLE team_game_stats ADD COLUMN def_field_position numeric;
ALTER TABLE team_game_stats ADD COLUMN off_fg_make_rate numeric;
ALTER TABLE team_game_stats ADD COLUMN def_fg_make_rate numeric;
