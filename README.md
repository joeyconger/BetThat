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
| 1. Data layer — weather | ⚠️ Live forecast built for NFL (Open-Meteo). Historical backfill added for both sports (CFB via CFBD's own `venue_id`, correctly handles neutral-site games), **UNVERIFIED**, not yet run — see "New scaffolds" below |
| 1. Data layer — public/sharp betting splits | 🚫 Schema-only — no verified free data source found (see "New scaffolds" below) |
| 2. Rating model | ✅ Built (EPA-driven Elo, market-anchored) — math sanity-checked. Fixed a real bug (unbounded SOS multiplier causing rating blowups, see "A real bug" below) |
| 2. Rating model — external ratings (CFB) | ⚠️ Built and calibrated via sweep (spPriorWeight=0, eloSignalPoints=1.5 — SP+ prior hurt, weekly Elo signal helped), ingested data still **UNVERIFIED** against a real response — see "External ratings" below |
| 3. Backtest harness | ✅ **Run for real** against 2023-2025, both sports, plus walk-forward validation and segment breakdowns. Three real bugs found and fixed (numeric-string coercion; unbounded SOS multiplier; computeInitialRating ignoring its own weight). **No cover-rate edge survived out-of-sample testing** — see "Backtest results" below. Avg CLV stayed positive in the true holdout; segment breakdowns are the current search for a narrower edge |
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

### A real bug: unbounded SOS multiplier

The SOS multiplier (`1 + sosWeight * opponentRating/ratingScaleRef`) had a
floor (`minSosMultiplier`) but no ceiling until this was found and fixed.
Without one, a team's rating update is amplified by however strong its
opponent already is, with no bound — and that amplified rating then
amplifies whoever plays *them* next, cascading through the schedule graph
as a season progresses. Confirmed in the real 2023-2025 CFB backtest: by
week 9, several `model_spread_home` values had exploded into the millions
(one reached ~1e26). Because pick side only depends on the *sign* of the
model's deviation from market, these degenerate predictions still counted
as real picks, contaminating both cover rate and CLV numbers. Fixed with a
`maxSosMultiplier` ceiling (1.8, symmetric with the existing 0.2 floor) —
verified with a synthetic worst-case (most aggressive sweep params, 13
weeks of adversarial one-sided blowouts) that ratings now stay bounded
(~48) instead of exploding. NFL's numbers turned out to be unaffected in
practice (lower `sosWeight`, shorter/less-connected schedule never pushed
the old unbounded formula into blowup range) — CFB numbers should be
treated as more trustworthy after the fix than before it.

### External ratings (CFB only)

Two CFBD rating sources beyond raw EPA, both because a homegrown Elo
starting from nothing is worse than borrowing an externally-computed,
informed number where one exists (`src/ingest/cfbd/syncExternalRatings.ts`,
`src/ratings/elo.ts`'s `computeInitialRating`/`zScore`):

- **SP+ as a season's rating prior**: CFBD's `/ratings/sp` has no `week`
  param — one value per team per year, not a time series. Real caveat:
  Connelly's SP+ methodology blends a genuine preseason projection
  (recruiting, returning production, coaching changes) into the in-season
  number and phases it out week by week, but this endpoint gives no way to
  tell which point in that blend a given year's value reflects (most likely
  the final, fully-informed number). Only safe use: season Y-1's value as
  season Y's rating prior (`spPriorWeight`, blended with the model's own
  carryover) — no lookahead risk either way, since Y-1 is complete before Y
  starts. **UNVERIFIED** — check ingested values land in a plausible range
  (roughly -30 to +30) before trusting.
- **CFBD's own weekly Elo as an in-season signal**: unlike SP+, `/ratings/elo`
  does take a `week` param — the one CFBD rating source that can give an
  as-of-a-specific-week snapshot. Its scale isn't documented, so rather than
  guess a conversion factor to points, each team's weekly Elo is converted
  to a z-score against that week's full FBS distribution (scale-invariant),
  then `eloSignalPoints` turns that z-score gap into a points adjustment on
  the model's own predicted margin. Skipped entirely when fewer than 20
  teams have Elo data for a given week (too small a population for a
  meaningful z-score) — early/preseason weeks may not have data at all.
  **UNVERIFIED** — exact max week and preseason-week availability haven't
  been confirmed against a real response; `syncCfbdEloRatings` loops a
  generous week range (0-20) and treats empty results as "not available,"
  not an error.

Both `spPriorWeight` (0.5) and `eloSignalPoints` (1.5) are uncalibrated
defaults, same as everything else in `config.ts` — 0 for NFL, since neither
source covers it.

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

### Three metrics, and why they're different questions

The dashboard's "Overall" table shows three numbers that are easy to
conflate but answer different questions:

- **Cover rate (vs. close)**: would the pick have won against the
  *closing* line, using the real score. Every trustworthy run so far
  (NFL and CFB, across every parameter combo tried) has landed at
  **48-50%** — below the 52.4% breakeven line at standard -110 odds. No
  edge found here yet.
- **Avg CLV**: does the closing line move toward the picked side, relative
  to opening — a pure price-movement measure, independent of who wins.
  Real, statistically significant positive signal found in CFB (not
  computable for NFL — nflverse has no opening line, see "Odds data").
- **Cover rate (vs. open)** (`getOpeningCoverRate` in
  `src/backtest/report.ts`): would the pick have won money bet AT the
  *opening* line, using the real score — the metric that actually answers
  "would this have been profitable." This is different from CLV (which
  only measures price movement, not the game outcome) and from cover-vs-
  close (which grades against a different, moved number than what you'd
  have actually bet). Best result found: **52.78%** (CFB, calibrated
  params, n=2051) — the first result all session to clear breakeven, but
  the 95% CI (~[50.6%, 54.9%]) still spans both sides of 52.4%, so this is
  "probably better than a coin flip" (real, p≈0.01 vs. 50%), not yet
  "confirmed to clear the vig." Two real caveats beyond the stats: this
  hasn't been walk-forward validated (see below — the calibration that
  produced it was tuned on the same data being evaluated), and actually
  getting a bet down at the true opening number is a real execution
  problem separate from the model being right (books limit opener action;
  lines move within minutes of posting).

### A real bug: unbounded SOS multiplier, and the external-ratings sweep

Found while reviewing early CFB backtest data: several week-9
`model_spread_home` values had exploded into the millions (one reached
~1e26) — see "Rating model / A real bug" above for the root cause
(unbounded SOS multiplier) and fix (`maxSosMultiplier`). Every CFB number
from before that fix is unreliable.

Two CFBD-derived signals were added on top (`spPriorWeight` for prior-
season SP+, `eloSignalPoints` for weekly Elo — see "External ratings"
above), then swept: `spPriorWeight` **consistently hurt** cover rate once
weighted above ~0.3 (worst at `spPriorWeight=1`, 47.4%) — likely because of
the flagged uncertainty around whether CFBD's SP+ value is genuinely
preseason-informed or just last season's final number. `eloSignalPoints`
showed a **real, fairly clean positive effect**, peaking around 1.5-2.
`CFB_PARAMS`'s defaults were updated to match (`spPriorWeight: 0`,
`eloSignalPoints: 1.5`, `pointsPerEpa: 20`) — the first time this file's
constants reflect an actual sweep result rather than a guess.

A second, subtler bug was found in the same sweep: `computeInitialRating`
fell through to raw `priorSpRating` whenever a team had no carryover
rating available, **regardless of `spPriorWeight`** — meaning `weight=0`
still silently injected full-strength SP+ for the entire 2023 season (the
backtest's first season, with no prior-season ratings ever computed).
Fixed by blending against league-average (0) instead of skipping straight
to the raw SP+ value when carryover is missing. Every external-ratings
sweep result from before this fix should be disregarded.

### Walk-forward validation (`cfb-walkforward` job) — result: no edge survives

The 52.78% opening-line result above was found by sweeping
`spPriorWeight`/`eloSignalPoints` against 2023-2025 and then *evaluating*
the winning combo against that same 2023-2025 data — a real risk of fitting
noise rather than finding a real edge. `src/adminJobs.ts`'s
`startCfbWalkforwardJob` tests this properly: calibrates using only
2023-2024 (best combo found: `spPriorWeight=0, eloSignalPoints=1.5`, 51.2%
train cover), then tests that exact combo purely on 2025 — data the
calibration never saw.

**Run**: cover vs. close **47.1%** (worse than a coin flip), cover vs. open
**50.0%** (dead coin flip, not 52.78%), avg CLV **+0.76** (held up,
even higher than before). **Conclusion: no cover-rate edge survives honest
out-of-sample testing, on either metric.** The earlier promising numbers
were real in-sample but did not generalize — exactly the failure mode
walk-forward validation exists to catch. The one thing that *has* held up
across every test tonight, in-sample and out, is a small positive avg
CLV — real, but not by itself something to bet on (see "Three metrics"
above for why CLV alone isn't the same as a win-rate edge).

### Segment breakdowns (`cfb-segments` job)

Since no blanket edge survived, the next question is whether there's a
*narrower* one — a specific conference, matchup type, week range, or
spread size where the model does better than its ~48-50% average.
`src/adminJobs.ts`'s `startCfbSegmentsJob` runs a fresh CFB backtest with
today's validated defaults and breaks it down by: conference of the picked
team (`getConferenceReport`), in- vs. out-of-conference games
(`getInOutConferenceReport`), week-number buckets — the literal test of
"early season, thin data, should be worse" (`getWeekBucketReport`), and
home/road picks crossed with both the game's own spread size and the
model's deviation size (`getHomeRoadBySpreadSizeReport`/
`getHomeRoadByDeviationReport`). All five verified against real local
Postgres with a hand-checked synthetic fixture before trusting them.

**Same caveat as everything above, stated up front this time**: this runs
on the full 2023-2025 sample, not a train/holdout split — searching many
segments is exactly the kind of thing that can produce a standout-looking
cell by chance (the same failure mode the walk-forward job just caught).
Treat any single promising segment here as a hypothesis worth a dedicated
holdout test, not a confirmed edge, before acting on it.

**Two follow-ups from the segment results**, both landed:

- **Excluding week 14+** (rivalry week / conference championships — this
  project has never actually ingested real postseason/bowl games, CFBD's
  endpoints were only ever called with `seasonType: 'regular'`) improved
  cover rate in-sample (49.9%→50.6% close, 52.8%→53.4% open) *and*, more
  importantly, in a true 2025 holdout the calibration never saw
  (47.1%→48.5% close, 50.0%→51.5% open) — `cfb-walkforward-no-rivalry`.
  That's the first thing all session to improve in both the training data
  and an untouched holdout the same way — real evidence of generalizing,
  not overfitting, even though the holdout number still sits under the
  52.4% breakeven line (wide CI at this sample size, n=650).
- **Big-spread deviation**: pulling the top games by model-vs-market
  deviation size showed a clear, mechanistic pattern — whenever the market
  itself posted an extreme spread (20-40+ points), the model consistently
  predicted something noticeably smaller, and lost more often than not
  (real blowouts tended to be at least as extreme as market, not less) —
  this rating system's incremental, regression-heavy updates (season
  carryover, bounded SOS multiplier) genuinely can't accumulate enough
  separation within a season to match real elite-vs-bottom-tier CFB gaps.

  **First fix attempt was a real mistake, caught by its own sweep, not by
  review.** The first version shrank `predictSpread`'s market-blend weight
  (`modelWeight`) as `|marketSpreadHome|` grew, on the theory that
  deferring more to market on extreme spreads would fix the losing pattern.
  A 7-value sweep came back with bit-for-bit identical cover rate and avg
  CLV at every single value, from a no-op-strength reference (1000) down to
  an aggressive one (5) — which turned out to be mathematically guaranteed,
  not a bug: `computeCovered`/`computeClv` (`src/backtest/clv.ts`) only
  ever look at `pickSide`, a binary choice from the *sign* of
  (market − modelSpreadHome), never its magnitude. `modelSpreadHome` is a
  weighted average of the model's own number and market, and a weighted
  average can never cross past either endpoint — so shrinking modelWeight
  can only pull the number closer to market, never flip which side it's
  on. Cover rate and CLV were provably unable to move, no matter the
  parameter value, because the fix targeted the wrong lever entirely.

  **Real fix**: instead of changing which side gets picked (not possible
  without touching the rating system itself — a much bigger, riskier
  lever, and one that would reopen exactly the unbounded-blowup risk the
  SOS multiplier fix closed earlier), `bigSpreadShrinkRef` now widens
  `confidence` as `|marketSpreadHome|` grows, flagging these predictions as
  less trustworthy for a confidence-based filter to screen out — the same
  "recognize and exclude the untrustworthy segment" pattern that excluding
  rivalry week already validated. Because confidence doesn't touch
  `pickSide` either, the metric that can actually move is cover rate
  *filtered by confidence* (`getConfidenceReport`), not the overall rate —
  `cfb-bigspread-sweep` was updated to report that.

  **Second attempt, also inconclusive.** The re-run sweep showed no clean
  win: at the tightest, most-targeted confidence bucket (≤2), a mild
  widening (`ref=60`) bumped cover rate from 51.1% to 53.4%, but on a small
  sample (286 games, ~±6pp 95% CI, well overlapping the baseline) — and
  cover rate got *worse*, not better, as the widening got more aggressive
  (46.4% at `ref=10`), the opposite of the hypothesis. The broader buckets
  (≤6, ≤4, ≤3) were flat across every value tested. **Root-cause diagnosis
  (the model under-predicts real blowout magnitudes) still stands as a
  real, mechanistically sound finding** — but neither fix tried for it
  (blend-weight damping, confidence-widening) has shown clean empirical
  support. `bigSpreadShrinkRef` stays at 25 (not reverted to the no-op
  1000) since neither value clearly beat the other, but treat this as an
  open problem, not a resolved one, until a real fix is found or this gets
  properly walk-forward tested.

## Market anchor removed, preseason prior tested and dropped

`predictSpread` (`src/ratings/elo.ts`) used to blend the model's own
rating-differential line toward the market's opening line by a games-played
shrinkage factor, widening confidence with the market spread's size. That
anchor is now gone entirely — `predictSpread` always returns the pure
rating-differential number; `marketSpreadHome` is still fetched and stored
(display + CLV scoring) but never enters a model-produced number.
`marketShrinkageK`/`bigSpreadShrinkRef` were removed from `RatingParams`.
Every backtest run before this change is not comparable to any run after
it. Honest post-removal baseline (`cfb-unanchored-rebaseline`, full
2023-2025): 2268 games, cover vs open 52.9%, avgClv 0.633.

That headline cover-rate improvement over the old anchored baseline did
NOT survive scrutiny: restricted to the ~75% of games where the anchored
and unanchored models picked the same side, cover was identical (50.1% vs
50.1%) — the aggregate shift came entirely from which side got picked on
the games where the two models disagreed, not from better forecasting
(`cfb-anchor-removal-breakdown` job). Paired significance tests on
identical game sets found neither CLV nor cover-rate differences
significant. Bucketed by combined games played, the removal did not show
the predicted "clearly worse early, comparable-or-better late" pattern —
suggesting the market anchor was never doing real early-season work in the
first place, weakening (not strengthening) the case for replacing it with
a fitted preseason prior.

Two attempts followed to test whether a *same-data* prior (no new
ingestion) helps anyway, before committing to a fuller CFBD-sourced
preseason-prior system (returning production, recruiting talent, transfer
portal, preseason polls — Part 2 of a larger plan, never built):

1. **Invalidated**: `priorShrinkK`, which re-blended the prior season's
   final rating into the effective rating *every week* at prediction time
   (weight fading by combined games played, but never reaching 0) — a
   permanent stale-data drag term, not a prior. Its clean monotonic
   decline as the weight increased was the expected artifact of that bug,
   not a finding about priors. Fully reverted.
2. **Valid**: `cfb-seed-strategy-sweep` swept `seasonCarryover` — the
   existing one-time week-0 seed mechanism (`computeInitialRating`/
   `carryoverRating` in `elo.ts`, applied once before any in-season game
   and never referenced again by `computeSeasonRatings`' update loop,
   confirmed by code trace) — holding `spPriorWeight=0` and everything
   else at current defaults. Result: 0/0.2/0.4/0.6 (today's default) are
   statistically indistinguishable on paired CLV (p=0.54/0.27/0.11 vs
   0.6); 0.8 and 1.0 (the raw, unregressed prior-season rating) are
   *significantly worse* (p=0.0096, p=0.0077). The 22+-games-played bucket
   came back bit-for-bit identical across all six independent runs — the
   seed genuinely washes out late, a real non-artifact signal this
   mechanism has that the invalidated one never did.

**Conclusion**: even a correctly-implemented, seed-only preseason prior
found no benefit to leaning on prior-season information, and a real cost
to over-weighting it. `seasonCarryover` stays at its current default
(0.6) — see `src/ratings/config.ts`'s comment on that field for the exact
numbers. Part 2 (the fuller CFBD ingestion) is dropped. The model now
stands as the pure rating-differential number with no market input and no
preseason prior beyond the existing lightly-regressed carryover seed.

## New scaffolds: key numbers, weather, public/sharp splits

Three new investigation angles, in different states of readiness:

- **Key numbers** (`getKeyNumberReport`, `src/backtest/report.ts`) — fully
  built and ready to run, no new data needed (uses odds already ingested).
  Buckets by *distance* from the nearest key number (3, 4, 6, 7, 10, 13,
  14, 17, 20, 21 — where NFL/CFB final margins cluster), not exact-integer
  match: an exact-match version was tried first and caught its own bug via
  a synthetic test — books routinely shade lines to X.5 right next to a key
  number specifically to avoid a push, and naive rounding sends -3.5 *away*
  from 3, misclassifying the single most common real-world case. Included
  in the `cfb-more-segments` job.
- **Weather** — historical backfill added for both sports
  (`src/ingest/weather/syncWeather.ts`'s `syncNflHistoricalWeather`,
  `src/ingest/cfbd/syncHistoricalWeather.ts`). CFB joins via CFBD's own
  `venue_id` per game (`/venues` has lat/lon + dome status) rather than a
  team-to-home-stadium map, so it correctly handles neutral-site games —
  the NFL version still uses a stadium map and doesn't. Both call
  Open-Meteo's historical archive API (`archive-api.open-meteo.com`,
  separate product/domain from the live forecast endpoint already used),
  **UNVERIFIED** — this sandbox can't reach open-meteo.com to check a real
  response, same posture as CFBD's other endpoints before they were
  verified. Reports actual precipitation, not a probability (that's a
  forecast-only concept — new `precipitation_actual` column, migration
  0004). Run `weather-backfill` before `cfb-more-segments`'s wind/
  precipitation breakdowns will show anything — the weather table starts
  empty for historical games (the existing live sync only ever covered
  upcoming games via a 16-day forecast window).
- **Public vs. sharp betting data** — schema-only
  (`public_betting_splits`, migration 0005). Researched but **no verified
  free API found**: Action Network, ScoresAndOdds, SportsBettingDime, and
  CLEATZ all display bet%/handle% splits on their own websites, not via a
  documented free API. "SharpAPI" claims a free-tier NFL odds API but its
  actual coverage of these specific fields is unverified. The table exists
  so the shape is ready whenever a real source is confirmed — do not build
  ingestion against any of the above without verifying their actual terms
  and field coverage first.

No new CLI scripts — trigger via the admin jobs below.

New background jobs (`src/adminJobs.ts`): `weather-backfill` (both sports,
2023-2025), `cfb-more-segments` (key number + wind + precipitation
breakdowns against a fresh baseline backtest).

## Schema

Everything joins through `games`:

```
games ──┬─→ team_game_stats   (team form entering the game: EPA/success rate, offense+defense, rush/pass split)
        ├─→ odds_snapshots    (every line pull: opening / movement / closing, with timestamps)
        ├─→ injuries
        ├─→ weather
        ├─→ model_predictions (Phase 2: this model's own rating-differential line -- no market input, see "Market anchor removed" below)
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
    cfbd/                    # CFB teams/games/advanced-stats (PPA, success rate), historical odds (verified live), external ratings (SP+/Elo, unverified)
    nflverse/                 # NFL schedules, play-by-play EPA/success rate, historical closing lines
    odds/                       # current lines (Odds API) + SBR historical archive import (unfinished scaffold)
    injuries/                    # ESPN unofficial injuries (unverified)
    weather/                      # Open-Meteo, NFL stadiums
  ratings/                # Phase 2 — EPA-driven Elo, no market input (see "Market anchor removed" below)
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

1. **Walk-forward validation is done — result: no cover-rate edge
   survives out-of-sample.** See "Backtest results" above. Avg CLV is the
   one number that held up in the true 2025 holdout.
2. **Run `cfb-segments`** — the current search for a narrower edge
   (conference, in/out-conference, week bucket, home/road x spread size,
   home/road x deviation size) now that a blanket edge hasn't held up.
   Remember the caveat: this runs on the full sample, not train/holdout —
   any standout segment needs a dedicated holdout test before it's trusted,
   same lesson `cfb-walkforward` already taught once tonight.
3. Other directions discussed but not yet started: calibration
   (Brier/log-loss on implied win probability, a different question than
   ATS cover), totals instead of spreads (weather data is already
   scaffolded and unused), line-shopping across books as a model-free
   source of edge.
4. **Live picks (Phase 4) do not get built until a real edge is found and
   validated out-of-sample.**
5. *(Later, once the model's edge — if any — is validated)*: a
   hypothetical-matchup tool — pick any two teams/weeks, not just ones on
   the real schedule, and see the model's implied line. `predictSpread`
   already supports this structurally (it only needs two ratings, not a
   real scheduled game); the one real gap is confirming it degrades
   sensibly with no market line to anchor to, since a hypothetical matchup
   has no real market price.
6. **Returning production as a week-0 seed adjustment** — not started.
   Part 2 (the full preseason-prior ingestion: returning production,
   transfer portal, recruiting talent, polls) was dropped as a bundle (see
   "Market anchor removed, preseason prior tested and dropped" above), but
   returning production and transfer portal are each being tested
   individually, narrowest first, before recruiting talent or polls are
   considered at all.

   **Returning production — done.** `returningProductionPoints` (one-time
   week-0 seed adjustment, centered against that season's FBS league
   average percentPPA — see `computeInitialRating`'s doc) was built,
   calibrated, and found a clean null: every paired significance test came
   back non-significant across a 0-50 weight grid, pooled and
   2024-2025-only alike (`cfb-returning-production-sweep`). Stays at its
   default of 0. The Step 4 eyeball test (`cfb-returning-production-
   week1-table`, illustrative weight only) surfaced a real, concrete miss
   though: Miami's percentPPA was one of the lowest in FBS, which would
   have badly under-rated a team that actually went 13-3 and reached the
   CFP National Championship game — they rebuilt almost entirely through
   the transfer portal, which returning production is structurally blind
   to. That finding is what motivated the portal work below. Full history
   in `docs/prompts/returning-production-seed-adjustment.md`.

   Also closed: the week-1 CLV anomaly (0-1 games-played bucket's avgClv
   sitting well below every other bucket) is confirmed NOT a stale/
   mis-timestamped-opening-line bug — `syncCfbdHistoricalOdds.ts`'s
   `captured_at` is a cosmetic placeholder only (exactly one 'opening' row
   per game, so the timestamp can't affect which value a lookup returns);
   the real explanation is structural, not a defect: week-1 lines open
   months before kickoff, a genuinely longer open-to-close window than any
   other week, which is simply a noisier reference point for CLV.

   **Transfer portal — scoped, not started.** CFBD's `/player/portal` has
   no production/performance stat at all (talent/pedigree only: `rating`,
   `stars`, `origin`, `destination`) — the design weights each incoming
   transfer's rating by the STRENGTH OF THE ORIGIN PROGRAM (reusing this
   project's own prior-season ratings, no new ingestion needed for that
   part) rather than treating transfers as flat-value or counting volume,
   per the Carson-Beck-from-Georgia vs. Colorado's-broader-portal-haul
   distinction that motivated it. Incoming-only, deliberately, to avoid
   double-counting with returning production's implicit "who left" signal.
   Three real open questions (sum vs. average per team, whether `rating`
   is recruiting-pedigree or performance-evaluated, the transfer-date
   season cutoff) are flagged for resolution before implementation, not
   defaulted. Full spec saved at
   `docs/prompts/portal-incoming-seed-adjustment.md`.
