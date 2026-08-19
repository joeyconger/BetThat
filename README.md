# Bet That

A personal NFL/CFB sports betting picks model. The goal is **beating the
closing line (CLV)**, not predicting winners — every part of this project is
built to measure against the closing line, not the final score.

## Status at a glance

| Phase | Status |
|---|---|
| 1. Data layer — schema | ✅ Migration written (`src/db/migrations/0001_init.sql`) |
| 1. Data layer — CFBD (CFB teams/games/PPA stats) | ✅ **Verified live** — 2025 season synced to a real Railway Postgres instance, FBS-only after fixing an early bug that pulled every division |
| 1. Data layer — nflverse (NFL schedules/EPA stats) | ✅ **Verified live** — 2025 season synced (285 games, 570 team-game rows, exact expected counts) |
| 1. Data layer — odds (current lines) | ✅ **Verified live** — full 2026 NFL schedule (272/272 games) matched and synced from The Odds API, real sane spread/moneyline values confirmed |
| 1. Data layer — odds (historical, for backtesting) | ✅ **Verified live** — nflverse's games.csv carries closing lines back to 1999 (NFL, closing only); CFBD's `/lines` carries both opening and closing for CFB, spot-checked against real 2024 outcomes (see "Odds data" below). SBR's opening-line archive is still an unfinished scaffold, only relevant for real CLV rather than the cover-rate metric currently in use |
| 1. Data layer — injuries | ⚠️ Built against ESPN's unofficial endpoint, **UNVERIFIED** — see "Injuries" below |
| 1. Data layer — weather | ✅ Built (Open-Meteo), NFL only — CFB stadiums not yet mapped |
| 2. Rating model | ✅ Built (EPA-driven Elo, market-anchored) — math sanity-checked |
| 3. Backtest harness | ✅ **Run for real** against 2023-2025 NFL (855 games) — see "Backtest results" below. A real bug (numeric-string coercion) invalidated the first run; fixed, re-run pending review |
| 4. Weekly picks output | 🚫 **Gated — do not build until Phase 3 backtest results are reviewed together** |

**Debug dashboard**: `src/server.ts` — backtest reports, team ratings, and raw
model predictions vs. market, over HTTP (Basic-auth gated). Not the
Phase 4 picks app; see "Debug/report endpoint" below.

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
  from this repo's root — no monorepo subfolder). Real scheduled jobs
  (ingestion, weekly picks) get wired up as Railway Cron Jobs once there's
  something worth scheduling; for now the deploy runs migrations, then
  `src/server.ts`.

## Debug dashboard / report endpoint (`src/server.ts`)

**Not the live-picks app** (still gated — see Phase 4 status above) — a
minimal, read-only HTTP surface, Basic-auth gated (`DASHBOARD_USER`/
`DASHBOARD_PASSWORD`, same shape as this repo's other Railway app), for
reviewing backtest results without round-tripping through deploy logs:

- `GET /` — list of backtest runs
- `GET /backtest/:runId` — overall/threshold/season-breakdown report for one run
- `GET /ratings?sport=&season=&week=` — team power ratings as of a given week
- `GET /predictions?sport=&season=&week=` — raw model line vs. market line
  per game that week (diagnostic only — explicitly not styled or filtered
  as picks)
- `GET /health` — for Railway's healthcheck
- `POST /query` (separate auth: `Authorization: Bearer $ADMIN_TOKEN`) — runs
  a `SELECT`-only query (rejects anything else) and returns `{ rows,
  rowCount }`, for ad hoc verification beyond the fixed pages above. That
  bearer token is the only safety rail on this one; treat it as a real
  secret.
- `POST /admin/jobs/:name`, `GET /admin/jobs`, `GET /admin/jobs/:id` (same
  bearer auth) — background job triggers, see `src/adminJobs.ts` below.

```bash
curl -X POST https://<your-domain>/query \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"sql": "select * from backtest_runs order by id desc limit 5"}'
```

### Background jobs (`src/adminJobs.ts`) — and why they exist

`railway.json`'s `startCommand` used to chain ingestion + a backtest run
*before* `npm run server` — convenient for getting a fresh result on every
deploy, but a real mistake: Railway's healthcheck only waits ~1m40s for
`/health` to respond, and multi-season CFBD ingestion routinely takes
longer than that. Every deploy that chained it either got lucky and beat
the clock, or got killed as unhealthy mid-job — not a reliable way to run
anything real. `startCommand` is back to just `npm run migrate && npm run
server` (always fast, always passes healthcheck), and slow jobs run
*after* the server is already up, triggered on demand instead:

```bash
curl -X POST https://<your-domain>/admin/jobs/nfl-backtest-refresh -H "Authorization: Bearer $ADMIN_TOKEN"
curl -X POST https://<your-domain>/admin/jobs/cfb-pipeline -H "Authorization: Bearer $ADMIN_TOKEN"
# returns {"started": "<job-id>"} immediately; poll:
curl https://<your-domain>/admin/jobs/<job-id> -H "Authorization: Bearer $ADMIN_TOKEN"
```

Job state is in-memory only (resets on redeploy) — that's fine, since the
actual output (new `backtest_runs` rows) persists in Postgres regardless
and shows up in the dashboard once done. Verified locally against a real
Postgres instance, both the success path and the error path (killed local
Postgres mid-job, confirmed the job correctly reported `status: "error"`
with the real error message rather than hanging or crashing the server).

## Setup

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL, CFBD_API_KEY, ODDS_API_KEY, ADMIN_TOKEN, DASHBOARD_USER/PASSWORD
npm run migrate
npm run server          # dashboard + API at http://localhost:3000
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

Three sources feed it, split by what they're good for:

- **NFL historical (closing only)**: `src/ingest/nflverse/syncHistoricalOdds.ts`
  — the same `games.csv` already streamed for schedules turned out to
  carry a closing-line number back to 1999, confirmed against nflverse's
  real data dictionary. **Verified live** against 2023-2025. No opening
  line in this source, only closing — see "Phase 3" below for how the
  backtest handles that.
- **CFB historical (opening + closing)**: `src/ingest/cfbd/syncHistoricalOdds.ts`
  hits CFBD's `/lines` endpoint, which carries both a `spread` (closing) and
  `spreadOpen` (opening) per provider. **Verified live**: 2024 season data
  spot-checked against known real outcomes (Georgia Tech's upset of Florida
  State, Vanderbilt's upset of Virginia Tech, Georgia's blowout of Clemson,
  Minnesota/UNC crossing from home-favored to away-favored) — field names,
  spread sign convention (matches this project's schema directly, no
  negation needed, unlike nflverse), and values all checked out.
- **Live/current lines (Phase 4 and beyond)**: The Odds API
  (`src/ingest/odds/oddsApiClient.ts` + `syncCurrentOdds.ts`), **verified
  live** — polls current spreads/moneylines/totals, real sane values
  confirmed against the 2026 NFL schedule. Not used for the historical
  backtest — its historical snapshot endpoint is metered per-market/
  per-region/per-timestamp and would run real money for 2-3 seasons of
  history; the two sources above cover that for free instead.
  SportsbookReviewsOnline (originally the planned historical source) turned
  out to only archive back to 2021-22 — too stale to be useful here, hence
  the pivot to nflverse/CFBD; `src/ingest/odds/sbrImport.ts` is still an
  unfinished scaffold, kept in case a real opening-line source for NFL is
  ever needed (nflverse doesn't have one).

```bash
npm run ingest:nfl:historicalOdds -- --season 2024
npm run ingest:cfbd:historicalOdds -- --year 2024
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

## Phase 2: the rating model

An incremental, EPA-driven Elo-like system (`src/ratings/`), not a batch
regression — chosen because it updates naturally week to week, needs no
linear-algebra dependency, and it's the standard way sports-analytics Elo
variants already encode strength of schedule (see below), which the spec
asked for explicitly.

- **What updates the rating**: not final score, but each game's *net
  EPA/play differential* (own offense EPA/play minus own defense EPA/play
  allowed, home minus away), converted to a point-margin equivalent via a
  `pointsPerEpa` constant. Final score has already happened by the time you
  could bet on it; EPA-per-play form is closer to "how good was this team,"
  which is what a rating meant to anchor a probability estimate should
  track.
- **SOS, stronger for CFB**: every rating update is scaled by the
  opponent's own current rating (`sosWeight` in `src/ratings/config.ts`) —
  beating a good team moves your rating more than beating a bad one, the
  standard Elo-family mechanism for strength of schedule. CFB's `sosWeight`
  (0.4) is set noticeably higher than NFL's (0.15), since CFB schedules
  vary far more in difficulty than NFL's (division/conference-balanced)
  schedules do.
- **Anchored to market, not built from zero**: `predictSpread()` in
  `src/ratings/elo.ts` blends the model's own rating-implied spread with
  the current market line, weighted by how many games have been observed
  (`marketShrinkageK`) — at 0 games played the output *is* the market line
  (weight 0), and the model's own signal only earns more say as evidence
  accumulates. This is what "deviation from market, not an independent
  power ranking" means concretely: early and in small samples, the model
  can't out-argue the market yet.
- **Season carryover**: a team's rating at the start of a new season is
  its previous season's final rating regressed 40% toward league-average
  (`seasonCarryover = 0.6`) — enough memory to not restart blind, not so
  much that roster turnover gets ignored.
- **Confidence/error estimate**: `baseErrorPoints / sqrt(games played + 1)`
  — starts wide, narrows as the season goes on. A heuristic, not a fitted
  quantity yet.

**All of the constants above are defaults, not calibrated values** — there's
no real backtest result yet to fit them against. `src/ratings/config.ts`
says this explicitly; Phase 3 is where they actually get tuned (sweep each
one, keep whatever beats the closing line). The core math was sanity-checked
by hand (a team with consistently better EPA gains rating in the right
direction; the market-shrinkage weight hits exactly 0 at zero games and 0.5
at `marketShrinkageK` combined games played, as designed) — that's
correctness, not validation that the *values* are good ones.

```bash
npm run ratings:compute -- --sport nfl --season 2025 --week 10   # writes team_ratings
npm run ratings:predict -- --sport nfl --season 2025 --week 11   # writes model_predictions, using ratings through week 10
```

`generatePredictionsForWeek` always computes ratings through `week - 1`
before predicting `week`'s games — a prediction can never see the result of
the game it's predicting, which matters as much for the Phase 3 backtest as
it does for a real future week.

## Phase 3: the backtest harness

`src/backtest/run.ts` replays the rating model week by week across a season
range and scores every completed game against its real line(s) and actual
result. It's now run for real against 2023-2025 NFL (855 games) — see
"Backtest results" below for what came out of that and an important
correction to it.

- **Closing line is required, opening line is optional** — nflverse's
  historical odds (see "Odds data" above) only has closing lines, so a real
  opening line is the exception, not the rule, in the data this project has
  free access to:
  - Both exist: real CLV (`src/backtest/clv.ts`'s `computeClv`), pick side
    from deviation off the **opening** line.
  - Only closing exists (the common case): `clv` is left `null` — there's
    no bet price to compare against — and pick side instead comes from
    deviation off the **closing** line. `covered` (did that pick beat the
    closing number, using the real final score) is the primary
    signal-quality metric here, and needs no opening line at all.
  - Neither exists: game is skipped.
- **Anchoring is opening-line-only, deliberately separate from the live
  path**: `generateBacktestPredictionsForWeek` (in `src/ratings/service.ts`)
  calls `getOpeningLine`, never `getLatestMarketLine` — the function Phase
  4's live polling uses. Reusing "latest line" for a backtest would
  frequently return the closing line for a historical game, silently
  handing the model information it wouldn't have had before kickoff. Kept
  as two separate functions rather than one with a flag, so this can't
  regress by accident.
- **Reporting** (`src/backtest/report.ts`): overall CLV/beat-close-rate/
  cover-rate; the same broken out by a sweep of deviation thresholds
  (0 to 5 points, measured from opening where it exists, closing
  otherwise) so a sane betting threshold can actually be chosen from data
  instead of guessed; and broken out by sport and season, to check whether
  a result is stable year to year rather than driven by one of them.

```bash
npm run backtest:run -- --sport nfl --seasonStart 2023 --seasonEnd 2025 --name v1
npm run backtest:report -- --runId 1
# or just open /backtest/1 in the debug dashboard (src/server.ts)
```

### Calibration sweep (`src/backtest/sweep.ts`)

Manually editing `ratings/config.ts`, redeploying, and re-running doesn't
scale once there's a real grid of constants to search. `backtest:sweep`
tries a grid of `pointsPerEpa` × `baseK` values (the two constants most
directly implicated so far — unanchored predictions were running too hot,
i.e. `pointsPerEpa` too large) against the same season range, storing each
combo as its own `backtest_runs` row (`params.ratingParams` records exactly
which values produced it) and printing cover rate sorted best-first.
Deliberately a small 3×3 grid by default — coarse search, then narrow the
grid around whichever corner wins and run again, rather than one huge
sweep:

```bash
npm run backtest:sweep -- --sport nfl --seasonStart 2023 --seasonEnd 2025
```

Verified locally end to end (all 9 combos ran clean against a real local
Postgres instance, correct sequencing of `backtest_runs` ids, sorted
output) — not yet run against the real 2023-2025 data for an actual
calibrated result.

## Backtest results — and a real bug in the first run

The first real run (855 NFL games, 2023-2025) reported a **44.7% cover
rate** against the closing line — meaningfully *below* the ~50% no-edge
baseline, and stable across all three seasons individually (41-47% each).
That result was wrong: **`computeCovered` had a numeric-string bug that
made it return `false` for every single home pick and `true` for every
single away pick, regardless of the real outcome.**

`pg` (the Postgres client) returns `numeric`/`decimal` columns as JS
strings, not numbers, to avoid float precision loss — every spread column
in this schema is `numeric`. `computeCovered` did
`actualMarginHome + closingSpreadHome`, where `actualMarginHome` is a real
number (scores are `int`, parsed fine) but `closingSpreadHome` was a
string. JS's `+` concatenates when either side is a string (`7 + "-3.5"` →
`"7-3.5"`, not `3.5`), and every downstream comparison against that garbage
string evaluated to `false`. `-`, `*`, and `/` all coerce strings to
numbers correctly in JS, which is exactly what let this hide everywhere
else in the codebase (the Elo rating math and `computeClv` only ever use
those) — `+` was the one place a DB-sourced value got added to something,
and it was wrong 100% of the time, silently.

**Fixed** in `src/db/pool.ts` with a global type parser
(`types.setTypeParser(1700, parseFloat)`) rather than patching the one call
site — the safer fix, since it means every `numeric` column comes back as a
real number everywhere, not just wherever someone remembered to cast.
Verified against a real Postgres instance before and after (confirmed the
bug reproduces with a real DB-sourced string, confirmed the fix produces a
correct `computeCovered` result) — not just a read of the code.

**The real 44.7% number is meaningless** — it's mostly just measuring the
ratio of away-picks to home-picks in this run, not model skill. A corrected
backtest re-run is queued (see `railway.json`); check `/backtest/` in the
debug dashboard for the latest run once it's landed, and don't trust any
number from before this fix.

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
  server.ts               # HTTP entry point — dashboard + /health + /query (see "Debug dashboard" above)
  db/
    pool.ts               # pg Pool (incl. the numeric-column type-parser fix — see "Backtest results")
    migrate.ts              # migration runner
    migrations/               # numbered .sql files
    repo.ts                    # typed upsert/query helpers shared by every ingest module
  ingest/
    cliArgs.ts             # tiny --flag value parser shared by CLI entry points
    cfbd/                    # CFB teams/games/advanced-stats (PPA, success rate), historical odds (verified live)
    nflverse/                 # NFL schedules, play-by-play EPA/success rate, historical closing lines
    odds/                       # current lines (Odds API) + SBR historical archive import (unfinished scaffold)
    injuries/                    # ESPN unofficial injuries (unverified)
    weather/                      # Open-Meteo, NFL stadiums
  ratings/                # Phase 2 — EPA-driven Elo, market-anchored
    config.ts              # tunable params per sport, flagged as uncalibrated defaults
    elo.ts                   # pure rating math (no DB) — computeSeasonRatings, predictSpread
    service.ts                 # DB orchestration: computeAndStoreRatings, generatePredictionsForWeek(+Backtest)
  backtest/                # Phase 3 — run for real; see "Backtest results" above
    clv.ts                   # pure math (no DB) — computeClv, computeCovered, pickSideFromDeviation
    run.ts                     # replays predictions across a season range, scores against real lines
    report.ts                    # overall / threshold / confidence / sport-season aggregate reporting
  web/                    # src/server.ts's HTML dashboard
    layout.ts               # shared page shell, CSS tokens (incl. dataviz-validated status colors)
    charts.ts                 # inline-SVG cover-rate bar chart, no charting library
    pages/                     # one render function per route
```

## What's next

1. Review the corrected NFL backtest and the CFB backtest together —
   specifically whether the CFB run shows the same direction of result as
   NFL independently (a real structural pattern should show up in both; an
   NFL-only pattern is weaker evidence). Open question: CFB's avg CLV
   climbs with the deviation threshold while ATS cover rate stays flat —
   not yet explained.
2. Use `backtest:report`'s threshold and confidence sweeps to tune
   `src/ratings/config.ts`'s currently-guessed constants (pointsPerEpa
   especially — unanchored predictions were producing unrealistic -25
   point NFL spreads in early testing).
3. **Live picks (Phase 4) do not get built until this is done and reviewed
   together.**
