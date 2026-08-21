-- Raw play-by-play storage, the foundation for the SP+-style rebuild: our
-- own success-rate/situational-split definitions and weighted garbage-time
-- all need individual play rows, not the pre-aggregated stats this project
-- has relied on CFBD's own /stats/game/advanced for up to this point.
--
-- One row per play, sourced from CFBD's /plays (see
-- ingest/cfbd/syncRawPlays.ts). CFB only for now -- no equivalent nflverse
-- play-by-play ingestion exists yet.
--
-- cfbd_play_id is CFBD's own play id (their `id` field, a string) --
-- unique per play, used for idempotent re-ingestion (ON CONFLICT DO
-- UPDATE, same pattern as every other CFBD-sourced table).
--
-- offense_team_id/defense_team_id are nullable: a play whose team names
-- don't resolve against our own teams table (e.g. an FCS opponent CFBD
-- covers but our teams table doesn't) still gets stored -- unlike the
-- team-game-level aggregation tables, a play is worth keeping even with
-- one side unresolved, since downstream per-team computations can filter
-- on whichever side they need. game_id IS required (not nullable) --
-- a play with no resolvable game can't be attributed to a week/season at
-- all, so those are skipped at ingestion time, same as every other
-- CFBD-sourced table in this project.
CREATE TABLE plays (
  id serial PRIMARY KEY,
  cfbd_play_id text NOT NULL UNIQUE,
  game_id int NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  offense_team_id int REFERENCES teams (id),
  defense_team_id int REFERENCES teams (id),
  drive_id bigint,
  drive_number int,
  play_number int,
  period int NOT NULL,
  clock_minutes int,
  clock_seconds int,
  offense_score int,
  defense_score int,
  yard_line int,
  yards_to_goal int,
  down int,
  distance int,
  yards_gained int,
  play_type text NOT NULL,
  scoring boolean NOT NULL DEFAULT false,
  ppa numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX plays_game_idx ON plays (game_id);
CREATE INDEX plays_offense_team_idx ON plays (offense_team_id);
CREATE INDEX plays_defense_team_idx ON plays (defense_team_id);
