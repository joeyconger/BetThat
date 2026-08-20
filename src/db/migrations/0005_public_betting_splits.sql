-- Schema-only scaffold — NO verified free data source found for this
-- (public bet% vs money% / "handle" splits, the classic public-vs-sharp
-- signal). Researched but not confirmed: Action Network, ScoresAndOdds,
-- SportsBettingDime, CLEATZ all display this on their own websites, not
-- via a documented free API; "SharpAPI" claims a free-tier NFL odds API
-- but its actual field coverage for bet%/handle% splits is unverified.
-- See README "Public vs. sharp betting data" before building ingestion
-- against any of these — this table exists so the shape is ready
-- whenever a real source is confirmed, not because one is wired up yet.
CREATE TABLE public_betting_splits (
  id serial PRIMARY KEY,
  game_id int NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  book text NOT NULL,
  captured_at timestamptz NOT NULL,
  bet_pct_home numeric,    -- % of TICKETS (bet count) on the home side
  bet_pct_away numeric,
  money_pct_home numeric,  -- % of total dollars (handle) on the home side -- the sharper signal
  money_pct_away numeric,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (game_id, book, captured_at)
);

CREATE INDEX public_betting_splits_game_idx ON public_betting_splits (game_id);
