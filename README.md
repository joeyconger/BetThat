# Bet That

A personal NFL/CFB sports betting picks model. The goal is **beating the
closing line (CLV)**, not predicting winners — every part of this project is
built to measure against the closing line, not the final score.

## Status at a glance

| Phase | Status |
|---|---|
| 1. Data layer — schema | ✅ Migration written (`src/db/migrations/0001_init.sql`) |
| 1. Data layer — CFBD (CFB teams/games/PPA stats) | ✅ Built, not yet run against a real DB |
| 1. Data layer — nflverse (NFL schedules/EPA stats) | ✅ Built, not yet run against a real DB |
| 1. Data layer — odds (current lines) | ✅ Built (The Odds API), not yet run |
| 1. Data layer — odds (historical, for backtesting) | ⚠️ Scaffolded only — see "Odds data" below, needs a real SBR file to finish |
| 1. Data layer — injuries | ⚠️ Built against ESPN's unofficial endpoint, **UNVERIFIED** — see "Injuries" below |
| 1. Data layer — weather | ✅ Built (Open-Meteo), NFL only — CFB stadiums not yet mapped |
| 2. Rating model | 🚫 Not started |
| 3. Backtest harness | 🚫 Not started |
| 4. Weekly picks output | 🚫 **Gated — do not build until Phase 3 backtest results are reviewed together** |

**This repo does not produce live picks.** There is no Phase 4 code yet, and
there won't be until the Phase 3 backtest shows real CLV signal and we've
looked at the results together. If you're reading this later and Phase 4
exists, check its own status notes before trusting anything it outputs.

## Stack

- Node.js 20+, TypeScript, `tsx` for running scripts directly (no build step
  needed in dev)
- PostgreSQL, plain `pg` client — no ORM
- Hand-rolled migration runner (`src/db/migrate.ts`): numbered `.sql` files
  in `src/db/migrations/`, tracked in a `schema_migrations` table, applied
  once each. No heavy migration framework.
- Env-based config (`src/config.ts`, `.env.example`) — same shape as the
  other Railway apps this follows
- Deploy target: Railway (Postgres plugin + this service, deployed straight
  from this repo's root — no monorepo subfolder). Nothing here runs as a
  long-lived server yet — Phase 1-3 are one-off/scheduled scripts, not a web
  app. `railway.json`'s start command just runs migrations on deploy for
  now; real scheduled jobs (ingestion, weekly picks) get wired up as
  Railway Cron Jobs once there's something worth scheduling.

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, CFBD_API_KEY, ODDS_API_KEY
npm run migrate
```

## Data sources — what and why

### CFB stats: CollegeFootballData (CFBD)

Free API key from https://collegefootballdata.com/key. Used for:

- `/teams` — team list, conference, classification
- `/games` — schedule, scores, neutral site flag
- `/stats/game/advanced` — per-game **PPA** (predicted points added — CFBD's
  name for their EPA-equivalent metric) split offense/defense and
  rush/pass, plus success rate. This is what fills `team_game_stats` for
  `source = 'cfbd'`.

Run order matters: `teams` → `games` → `stats` (each later step looks up
rows the earlier step created).

```bash
npm run ingest:cfbd:teams -- --year 2023
npm run ingest:cfbd:games -- --year 2023
npm run ingest:cfbd:stats -- --year 2023
```

### NFL stats: nflverse-data

No API, no key, no rate limit — [nflverse-data](https://github.com/nflverse/nflverse-data)
publishes nflfastR's play-by-play (EPA and success rate already computed)
and full schedules as flat files on GitHub Releases. This was chosen over a
paid API (SportsDataIO etc.) because nflfastR's EPA model is the
well-validated one bettors and analysts actually trust, and it's free.

Tradeoff: these are undocumented-but-stable release URLs, not a versioned
API contract (same category of risk as the ESPN endpoints below) — if
nflverse restructures asset names, `src/ingest/nflverse/client.ts` needs
updating.

The play-by-play file is the full nflfastR schema (hundreds of columns) —
`syncPbpStats.ts` streams it row-by-row (gunzip → CSV parse → aggregate)
rather than loading it into memory, so it doesn't need a small/lite
variant, but a season's stats sync is I/O-bound and takes a bit.

```bash
npm run ingest:nfl:schedules -- --season 2023
npm run ingest:nfl:stats -- --season 2023
```

### Odds data — the most important table in the project

`odds_snapshots` is deliberately built to hold every line pull for a game,
not just a final number: `snapshot_type` is `'opening'`, `'movement'`, or
`'closing'`, with a `captured_at` timestamp on every row.

Two different sources feed it, split by what they're good for:

- **Historical backtest data (Phase 3, 2-3 past seasons)**: free archives —
  [SportsbookReviewsOnline](https://www.sportsbookreviewsonline.com/)'s free
  season spreadsheets (NFL + CFB opening/closing spreads, totals,
  moneylines, years of history) plus CFBD's own free `/lines` endpoint for
  CFB. **Not yet finished** — `src/ingest/odds/sbrImport.ts` is a scaffold
  with the target interface documented, but throws until someone downloads
  a real season file and the column mapping is verified against it (SBR's
  layout has drifted across seasons in the past, so this deliberately isn't
  guessed blind).
- **Live/current lines (Phase 4 and later backtest windows)**: The Odds API
  (`src/ingest/odds/oddsApiClient.ts` + `syncCurrentOdds.ts`), fully working
  — polls current spreads/moneylines/totals and records them as `'movement'`
  snapshots. **The Odds API is deliberately not used for the historical
  backtest** — its historical snapshot endpoint is metered per-market/
  per-region/per-timestamp and pulling 2-3 seasons of NFL+CFB line history
  that way would run real money; free archives cover that instead.

```bash
npm run ingest:odds:current -- --sport nfl   # or --sport cfb
```

Game matching for the Odds API has no shared ID with CFBD/nflverse, so it's
done by team name (best-effort fuzzy match, `findTeamIdFuzzy` in
`src/db/repo.ts` — exact match first, falls back to substring match, and
**never guesses** if more than one team matches) + kickoff time proximity.

### Injuries: ESPN's unofficial endpoint — UNVERIFIED

`src/ingest/injuries/espnClient.ts` hits ESPN's undocumented public API
(`site.api.espn.com/apis/site/v2/sports/.../injuries`) — free, no key, but
a "hidden endpoint" whose response shape isn't guaranteed and could change
without notice. This sandbox has no network access to confirm the real
response against the assumed shape — parsing is defensive (skips anything
that doesn't match rather than crashing), but **run a real sync and check
the `raw` column in the `injuries` table before trusting this data.**

```bash
npm run ingest:injuries:current -- --sport nfl
```

### Weather: Open-Meteo

No key needed. `src/ingest/weather/nflStadiums.ts` has lat/lon + dome status
for all 32 NFL stadiums; dome games get a fixed neutral reading instead of a
real forecast call. **CFB stadiums aren't mapped yet** — CFBD's `/venues`
endpoint has lat/lon per venue and is the natural next source; flagged here
rather than silently skipped.

```bash
npm run ingest:weather
```

## Schema

Everything joins through `games`:

```
games ──┬─→ team_game_stats   (team form entering the game: EPA/success rate, offense+defense, rush/pass split)
        ├─→ odds_snapshots    (every line pull: opening / movement / closing, with timestamps)
        ├─→ injuries
        ├─→ weather
        ├─→ model_predictions (Phase 2: this model's line, anchored to the market line at run time)
        └─→ backtest_results  (Phase 3: model vs. opening vs. closing vs. actual, CLV)
```

`team_ratings` holds the weekly power ratings (Phase 2) that
`model_predictions` gets derived from. `backtest_runs` groups
`backtest_results` by method/season-range/params so different model
variants can be compared side by side without overwriting each other.

Full definitions with comments: `src/db/migrations/0001_init.sql`.

## Project layout

```
railway.json
.env.example
src/
  config.ts              # env loading
  db/
    pool.ts               # pg Pool
    migrate.ts              # migration runner
    migrations/               # numbered .sql files
    repo.ts                    # typed upsert/query helpers shared by every ingest module
  ingest/
    cliArgs.ts             # tiny --flag value parser shared by CLI entry points
    cfbd/                    # CFB teams/games/advanced-stats (PPA, success rate)
    nflverse/                 # NFL schedules + play-by-play EPA/success rate
    odds/                       # current lines (Odds API) + historical archive import (scaffold)
    injuries/                    # ESPN unofficial injuries (unverified)
    weather/                      # Open-Meteo, NFL stadiums
  ratings/                # Phase 2 — not started
  backtest/                # Phase 3 — not started
```

## What's next

1. Provision a Postgres instance (Railway or local), run `npm run migrate`,
   run the CFBD + nflverse ingestion for a couple of recent seasons to
   sanity-check real data lands correctly.
2. Finish `src/ingest/odds/sbrImport.ts` against a real downloaded
   SportsbookReviewsOnline file.
3. Phase 2: the rating model (Elo-like or ridge regression — TBD which fits
   better once real data is in hand), anchored to market lines, with a
   stronger SOS adjustment for CFB than NFL.
4. Phase 3: the backtest harness, run against 2-3 completed seasons, with
   CLV reporting by threshold and by sport/week. **Live picks (Phase 4) do
   not get built until this is done and reviewed.**
