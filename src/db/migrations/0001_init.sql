-- Core schema for the CLV betting model.
--
-- Join path this is designed around, end to end:
--   games -> team_game_stats (team form entering the game)
--         -> odds_snapshots  (opening / movement / closing line)
--         -> model_predictions (this model's number, anchored to the market)
--         -> backtest_results (model vs. closing line vs. actual result)
--
-- `sport` is a plain text discriminator ('nfl' | 'cfb') on every sport-scoped
-- table rather than separate nfl_* / cfb_* table families, since almost every
-- query in this project (ratings, backtests, CLV reporting) wants to filter
-- or group by sport on tables that are otherwise identically shaped.

CREATE TABLE teams (
  id serial PRIMARY KEY,
  sport text NOT NULL CHECK (sport IN ('nfl', 'cfb')),
  source_id text NOT NULL,       -- CFBD school id, or NFL team abbreviation (nflverse)
  name text NOT NULL,
  conference text,
  division text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sport, source_id)
);

CREATE TABLE games (
  id serial PRIMARY KEY,
  sport text NOT NULL CHECK (sport IN ('nfl', 'cfb')),
  season int NOT NULL,
  week int NOT NULL,
  season_type text NOT NULL DEFAULT 'regular' CHECK (season_type IN ('regular', 'postseason')),
  game_date timestamptz,
  home_team_id int NOT NULL REFERENCES teams (id),
  away_team_id int NOT NULL REFERENCES teams (id),
  home_score int,
  away_score int,
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'final')),
  neutral_site boolean NOT NULL DEFAULT false,
  source_id text NOT NULL,       -- CFBD game id, or nflverse game_id
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sport, source_id)
);

CREATE INDEX games_season_week_idx ON games (sport, season, week);
CREATE INDEX games_date_idx ON games (game_date);

-- Team form at the time of a specific game: EPA/play split by rush/pass,
-- offense and defense, plus success rate. One row per team per game.
-- For "team stats entering week N", callers aggregate/roll up prior rows
-- for that team within the season rather than storing a rolling average
-- here — keeping this table as raw per-game facts keeps it replayable for
-- backtests at any as-of week.
CREATE TABLE team_game_stats (
  id serial PRIMARY KEY,
  game_id int NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  team_id int NOT NULL REFERENCES teams (id),
  is_home boolean NOT NULL,
  off_epa_play numeric,
  off_epa_pass numeric,
  off_epa_rush numeric,
  def_epa_play numeric,
  def_epa_pass numeric,
  def_epa_rush numeric,
  off_success_rate numeric,
  off_success_rate_pass numeric,
  off_success_rate_rush numeric,
  def_success_rate numeric,
  def_success_rate_pass numeric,
  def_success_rate_rush numeric,
  plays_offense int,
  plays_defense int,
  source text NOT NULL CHECK (source IN ('cfbd', 'nflverse')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, team_id)
);

-- Strength-of-schedule input, computed per team as of a given week (rolling,
-- recomputed as the season progresses so backtests can replay "SOS as it
-- was known at the time"). CFB gets a heavier SOS weight than NFL in the
-- rating model (Phase 2) — this table just stores the raw input either way.
CREATE TABLE team_season_sos (
  id serial PRIMARY KEY,
  team_id int NOT NULL REFERENCES teams (id),
  season int NOT NULL,
  through_week int NOT NULL,
  sos_rating numeric NOT NULL,   -- e.g. average opponent power rating
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, season, through_week)
);

-- The most important table in the project: every line pull for a game,
-- not just a final number. `snapshot_type` distinguishes the discrete
-- opening/closing values (e.g. from a historical archive import) from
-- continuous movement snapshots (e.g. polled from a live odds API).
CREATE TABLE odds_snapshots (
  id serial PRIMARY KEY,
  game_id int NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  book text NOT NULL,            -- 'consensus', 'draftkings', 'pinnacle', ...
  captured_at timestamptz NOT NULL,
  snapshot_type text NOT NULL CHECK (snapshot_type IN ('opening', 'movement', 'closing')),
  spread_home numeric,           -- negative = home favored
  spread_home_price int,         -- American odds
  spread_away_price int,
  moneyline_home int,
  moneyline_away int,
  total numeric,
  total_over_price int,
  total_under_price int,
  source text NOT NULL,          -- 'odds_api', 'sbr_archive', 'cfbd'
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, book, captured_at)
);

CREATE INDEX odds_snapshots_game_idx ON odds_snapshots (game_id, snapshot_type);

CREATE TABLE injuries (
  id serial PRIMARY KEY,
  team_id int NOT NULL REFERENCES teams (id),
  game_id int REFERENCES games (id) ON DELETE SET NULL,
  player_name text NOT NULL,
  position text,
  status text NOT NULL CHECK (status IN ('out', 'doubtful', 'questionable', 'probable', 'ir')),
  report_date date NOT NULL,
  source text NOT NULL,
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, player_name, report_date)
);

CREATE INDEX injuries_game_idx ON injuries (game_id);

CREATE TABLE weather (
  id serial PRIMARY KEY,
  game_id int NOT NULL UNIQUE REFERENCES games (id) ON DELETE CASCADE,
  forecast_at timestamptz NOT NULL,
  temp_f numeric,
  wind_mph numeric,
  precipitation_probability numeric,
  condition text,
  is_dome boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'open-meteo',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Phase 2: weekly power ratings, anchored to market lines rather than an
-- independent power ranking (see README) — `rating` is on a point scale
-- comparable to a spread, and `rating_error` is the model's own confidence
-- estimate for that team/week.
CREATE TABLE team_ratings (
  id serial PRIMARY KEY,
  team_id int NOT NULL REFERENCES teams (id),
  sport text NOT NULL CHECK (sport IN ('nfl', 'cfb')),
  season int NOT NULL,
  through_week int NOT NULL,
  rating numeric NOT NULL,
  rating_error numeric,
  method text NOT NULL CHECK (method IN ('elo', 'ridge')),
  computed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, season, through_week, method)
);

-- One row per (game, method, run) so a backtest can replay the model's
-- output as it would have looked at the time, without overwriting history.
CREATE TABLE model_predictions (
  id serial PRIMARY KEY,
  game_id int NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  method text NOT NULL,
  model_spread_home numeric NOT NULL,   -- negative = home favored
  model_total numeric,
  confidence numeric,                    -- model's own error estimate
  market_spread_home numeric,            -- market line the model was anchored to at run time
  predicted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, method, predicted_at)
);

CREATE TABLE backtest_runs (
  id serial PRIMARY KEY,
  name text NOT NULL,
  method text NOT NULL,
  season_start int NOT NULL,
  season_end int NOT NULL,
  params jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- CLV is signed in the direction that matters for betting: positive means
-- the model's line, had you bet it, would have beaten the closing line.
CREATE TABLE backtest_results (
  id serial PRIMARY KEY,
  backtest_run_id int NOT NULL REFERENCES backtest_runs (id) ON DELETE CASCADE,
  game_id int NOT NULL REFERENCES games (id),
  model_spread_home numeric NOT NULL,
  opening_spread_home numeric,
  closing_spread_home numeric,
  actual_margin_home numeric,            -- home_score - away_score
  clv numeric,                            -- model vs. closing, signed for the side the model favored
  covered boolean,
  beat_close boolean,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (backtest_run_id, game_id)
);

CREATE INDEX backtest_results_run_idx ON backtest_results (backtest_run_id);
