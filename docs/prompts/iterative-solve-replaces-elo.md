# Replace incremental Elo with the iterative opponent-adjustment solve

## Why (Step 1 findings, all real-data-verified, not assumed)

Original diagnosis: incremental Elo bakes in credit permanently (beating a bad
team in week 3 earns rating at the time; when that opponent's rating falls
later, nothing revises the earlier credit). An iterative solve re-derives all
teams' ratings simultaneously from the current data each snapshot, so opponent
quality is priced at today's values across the whole season, not the value the
model happened to hold at the time.

Verified across 8 checkpoints (CFB 2025 weeks 4/6/8/10/12/14 + 2023/2024 season
finals), correlation against real SP+ (manual weekly archive for 2025,
CFBD final SP+ for prior seasons):

1. **Iterative solve beats incremental Elo** once given a fair chance -- not
   just the original week-14-2025 snapshot (which was a near-tie, 0.909 vs
   0.912, inside noise), but a genuine pattern once the solve's real
   weaknesses were fixed (see below).
2. **EPA beats success rate as the solve's raw metric**, uniformly across all
   6 in-season weeks (no early-season concentration -- ruled out via explicit
   test), not just a noise-reduction trick.
3. **The solve has less information early in the season than Elo** (which
   carries a real prior via seasonCarryover) -- weeks 4 and 6 lost to Elo even
   on EPA, and week 4 didn't even converge without a prior.
4. **Seeding the solve's starting point does NOT fix this** -- proven false
   experimentally (seeded and unseeded results were bit-identical) and
   explained mathematically: this system has a genuine "gauge freedom" (every
   equation only ever involves a team's OFF or DEF paired against an
   OPPONENT's DEF or OFF, never a team's own OFF and DEF together or either
   alone), so shifting every team's OFF up by c and DEF down by c leaves every
   equation satisfied identically for any graph however well-connected. The
   fixed point a damped iteration converges to doesn't depend on where it
   started, except along that one direction -- and that direction is a
   uniform shift that doesn't even affect the OFF-DEF composite's ranking or
   correlation with anything else.
5. **A real prior, entered as WEIGHTED PSEUDO-GAMES in the fixed-point
   equations themselves**, works: `computeOpponentAdjustedRatings` now takes
   `options.priors: Map<teamId, {off, def, weight}>` -- a team's target each
   iteration blends its real games with `weight` pseudo-games worth of prior,
   so the prior's influence shrinks proportionally as real games accumulate
   instead of either doing nothing (seeding) or dominating forever.
6. **Calibrated: weight=2**, prior sourced from the team's own prior-season
   final EPA solve (not shrunk toward 0 first -- the weight itself is the
   shrinkage knob). Beats Elo at all 8 checkpoints tested, with the biggest
   gains exactly where they're needed (weeks 4/6) and only a small, still-
   positive giveback late in the season. weight=5 starts the same "too much
   prior overwhelms real data" pattern seen in `errorCapPoints`/
   `varianceShrinkK` -- it loses to Elo at week 14 (barely). weight=2 is the
   adopted value, not weight=5.

All of this lives in `src/ratings/opponentAdjust.ts` (the solve),
`src/ratings/gamePerformance.ts` (`buildTeamPerformancesEpa`, the EPA-based
performance builder), and the diagnostic admin jobs in `src/adminJobs.ts`:
`cfb-solve-vs-elo-vs-sp-diagnostic`, `-widened-diagnostic`,
`cfb-solve-coldstart-test`, `cfb-solve-epa-hypothesis-test`,
`cfb-solve-prior-weight-test`, `cfb-solve-prior-weight-full-checkpoint-test`.

## Step 0 report findings (repo state before this work), for reference

- `computeOpponentAdjustedRatings` already ran as-of-week in production
  (`syncOpponentAdjustedStats.ts`) -- no lookahead risk in reusing it as the
  primary engine.
- The backtest harness (`backtest/run.ts`) and `service.ts`'s
  `predictAndStoreWeek` already treat "ratings as of week N" as a stateless,
  full recompute on every call (never incremental persisted state) -- the new
  solve-based engine is a drop-in at that layer, no harness changes needed.
- `team_ratings` (migration 0001) has one scalar `rating` column, no room for
  a separate OFF/DEF/ST decomposition -- decision: **persist OFF/DEF/ST
  separately** (user's explicit call: "the matchup tool needs the
  decomposition, and collapsing early means recomputing later").
- Config params: `baseK`, `sosWeight`, `ratingScaleRef`, `min/maxSosMultiplier`,
  `opponentAdjustWeight`, `opponentAdjShrinkageK`, `errorCapPoints`,
  `pointsPerOpponentAdj`, `successRateWeight`, `pointsPerSuccessRate` are dead
  (pure incremental-Elo-loop plumbing, no successor). `pointsPerFinishingDrives`
  /`pointsPerFieldPosition`/`pointsPerFgMakeRate` are dead as additive terms
  but their raw data becomes input to the new special-teams solve.
  `pointsPerExplosiveness`/standard-downs/passing-downs/sack-rate: **set
  inert, keep the code, document why -- re-test under the solve architecture
  rather than assuming the old (Elo-vs-these-components) redundancy finding
  transfers** (user's explicit call: that finding was against Elo's implicit
  handling specifically, and the question genuinely reopens under a solve).
  `seasonCarryover`/`spPriorWeight`/`varianceShrinkK`: superseded by the
  pseudo-game prior mechanism above, not simply deleted -- their SHAPE
  (shrink-toward-a-prior, regression-residual dispersion) carries over to the
  new architecture's own attachment points.
- Never delete a dead param -- set inert and document why, same treatment
  `opponentAdjustWeight` already got.

## Step 2 scope (this work) vs. later steps

**Step 2 (this work)**: ratings come from the iterative solve (EPA off/def +
weight=2 prior from prior-season's own solve), converted to a points scale,
OFF/DEF/ST persisted separately, wired in as the primary rating engine behind
`service.ts`'s existing interface (`computeRatings`/`computeAndStoreRatings`/
`predictHypotheticalMatchup`/`generateBacktestPredictionsForWeek` keep their
signatures so `backtest/run.ts`, `adminJobs.ts`, and `server.ts` don't need to
change). Special-teams solve included if the underlying data coverage
supports it (finishing-drives coverage was flagged as a possible gap in the
Step 0 report and needs a real check, not an assumed number, before building
on it). Dead params get marked inert with doc comments, not deleted.

**Step 3 (per-team variance)**, **Step 4 (RMSE evaluation metric replacing
CLV as the primary tuning target)**, and **Step 5 (odds simulation UI)** are
separate, later work -- not attempted in this pass. The excess-dispersion
mechanism already built for Elo (`varianceShrinkK`) will need to be re-pointed
at solve residuals for Step 3, per the user's earlier explicit instruction
(fit it, expose it, don't use it to shrink ratings until Step 4's forecast
metric says it helps).

## Verification plan for this step

Typecheck + full test suite before every commit (established practice all
session). Once the new engine is wired into `service.ts`, run a real CFB
backtest (`runBacktest`, or the existing sweep infra) to confirm the plumbing
produces sane, non-degenerate predictions end to end -- not a formal
CLV/RMSE judgment call yet (that's Step 4), just a smoke test that the new
path works in the real prediction pipeline, matching Step 1's own discipline
applied to the integration itself.
