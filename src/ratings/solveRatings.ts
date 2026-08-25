/**
 * The primary CFB rating engine: wraps opponentAdjust.ts's iterative
 * opponent-adjustment solve (run on garbage-time-weighted EPA, see
 * gamePerformance.ts's buildTeamPerformancesEpa) with a points-scale
 * conversion and the preseason-prior construction. Replaces elo.ts's
 * incremental-update computeSeasonRatings for CFB -- NFL has no raw-play/
 * PPA ingestion (see ingest/cfbd/client.ts's getPlays doc history) and
 * stays on the Elo path, which is why this lives in its own module rather
 * than folding into elo.ts.
 *
 * Every design choice here is backed by a real-data diagnostic, not
 * assumed -- see docs/prompts/iterative-solve-replaces-elo.md for the full
 * writeup (Step 1's 8-checkpoint correlation-vs-SP+ comparison, the
 * cold-start-via-seeding falsification, the EPA-vs-success-rate test, and
 * the prior-weight sweep that found weight=2). Re-derive nothing from this
 * file alone without reading that doc first.
 */

import { computeOpponentAdjustedRatings, type TeamPerformance } from "./opponentAdjust.js";
import { computeFieldPositionSolve, computeFgEfficiency, residualizeFieldPosition, type RawPlayForSpecialTeams } from "./specialTeams.js";

export interface SolveRatingParams {
  /**
   * Converts the solve's raw OFF-DEF composite (garbage-time-weighted
   * EPA-per-play units, typically roughly -0.3..+0.3 for real CFB teams)
   * into a points-vs-average-FBS-team scale, the same role
   * RatingParams.pointsPerEpa played for the old incremental Elo loop.
   *
   * Calibrated value: 60. Real-data grid sweep (walk-forward next-week
   * margin RMSE, 12 checkpoints across 2024/2025 weeks 8-14) found a flat-
   * bottomed basin: 50 gave avg RMSE=15.69, 75 gave 15.74 -- both far
   * better than the original placeholder of 100 (17.23, ~9% worse) and
   * the curve rises steeply and monotonically past 100 (125->19.84,
   * 300->48.94). 60 is deliberately the MIDDLE of that basin, not either
   * tested edge -- 50 was the grid minimum, but it also sat at the edge of
   * the explored range (only 25, far outside the basin, tested to its
   * left), so picking 50 itself would mean one side of the chosen value
   * was never actually measured. 60 sits inside the range bounded by
   * worse values on BOTH sides (25 and 100), which 50 does not.
   *
   * This scale was previously an untested placeholder that every live CFB
   * prediction ran on -- the 100->60 correction alone measurably
   * de-overconfidences every predicted margin the site produces,
   * independent of anything about special teams. Do not casually move
   * this without re-running that sweep (cfb-epa-scale-calibration in
   * adminJobs.ts) with ST weights held at 0, since ST weights are
   * calibrated RELATIVE to this scale, not independently of it.
   */
  pointsPerEpaSolve: number;
  /**
   * Weighted pseudo-games for the preseason prior (the team's own prior-
   * season final solve, see opponentAdjust.ts's options.priors doc for
   * the mechanism -- entered into the fixed-point equations, NOT a
   * starting-point seed, which was proven not to work for this system).
   * Calibrated value: 2. Real-data sweep (docs/prompts/
   * iterative-solve-replaces-elo.md) found weight=2 beats Elo at all 8
   * checkpoints tested (2025 weeks 4-14 + 2023/2024 finals), with the
   * biggest gains exactly where they're needed (early weeks) and only a
   * small, still-positive giveback late in the season. weight=5 already
   * starts the "too much prior overwhelms real data" pattern (loses to
   * Elo at week 14) -- do not casually increase this without re-running
   * that sweep. 0 disables the prior entirely (cold start, no seeding).
   */
  priorWeight: number;
  /**
   * Points-scale weight for the field-position special-teams component
   * (ratings/specialTeams.ts's off/def solve, RESIDUALIZED against the
   * EPA off/def solve -- see residualizeFieldPosition's doc -- raw units
   * are "field position score" ~= 100-yardsToGoal).
   *
   * Calibrated value: 0.5. Real-data grid sweep (walk-forward next-week
   * margin RMSE, same 12 checkpoints as pointsPerEpaSolve's calibration,
   * run AFTER that calibration and the residualization were both in
   * place) found a smooth, unimodal curve: 0->15.53, 0.1->15.48,
   * 0.25->15.43, 0.5->15.41 (minimum), 1.0->15.58 (worse than the 0
   * baseline) -- 0.5 is genuinely bracketed by worse tested values on
   * both sides, not sitting at an unexplored grid edge. Notably, an
   * earlier evaluation pass (before the base-scale fix and
   * residualization) found a similar-sized weight made RMSE WORSE --
   * the sign flip has a clear mechanical explanation (double-counting
   * with DEF EPA masking the real signal, an uncalibrated base scale
   * distorting the comparison), not just "a different number came out."
   * Effect size is modest (~0.8% RMSE improvement); this was one
   * exploratory grid, not a held-out confirmation.
   */
  pointsPerFieldPositionYard?: number;
  /**
   * Points-scale weight for the FG-efficiency special-teams component
   * (specialTeams.ts's shrunkExcessMakeRate).
   *
   * Calibrated value: 0 -- a documented NULL result, not an unfinished
   * placeholder. The same grid sweep found fg=0 was the best choice at
   * EVERY field-position weight tested, with RMSE degrading monotonically
   * as the FG weight increased at every level -- no local minimum away
   * from 0 anywhere on the grid. Per the build spec's own instruction,
   * this is a legitimate outcome to document, not push past by trying
   * larger weights or a different shrinkage constant without a new reason
   * to think either would help.
   */
  pointsPerFgAboveExpected?: number;
  /**
   * Shrinkage constant for FG efficiency (specialTeams.ts's
   * computeFgEfficiency) -- NOT a weight, so it does NOT default to 0 (a
   * shrinkage of 0 would mean no regression at all on a ~17-18-attempt/
   * season sample, defeating the point). 20 was NOT swept independently
   * (the build spec calls for sweeping the WEIGHTS; shrinkage is a
   * different kind of parameter -- how much a per-team estimate is
   * trusted, not how much it matters to the final rating) -- still an
   * untested starting order of magnitude. Moot at pointsPerFgAboveExpected=0
   * today, but revisit if FG is ever reconsidered.
   */
  fgShrinkK?: number;
}

/** See each field's own doc for why these specific values, not a placeholder pair. */
export const DEFAULT_SOLVE_RATING_PARAMS: SolveRatingParams = {
  pointsPerEpaSolve: 60,
  priorWeight: 2,
  pointsPerFieldPositionYard: 0.5,
  pointsPerFgAboveExpected: 0,
  fgShrinkK: 20,
};

export interface SolveTeamRating {
  /** offPoints - defPoints + (stFieldPositionOffPoints - stFieldPositionDefPoints) + stFgPoints -- the single scalar ratings/elo.ts's predictSpread needs (rating differential + home field advantage). Identical to offPoints - defPoints whenever the ST weight params are 0 (the default). */
  rating: number;
  offPoints: number;
  defPoints: number;
  /** Real games played (NOT opponentAdjust.ts's teamDiagnostics.gamesPlayed, which double-counts offense+defense appearances for the same team -- this is that divided by 2, matching what every other consumer of a "gamesPlayed" field in this codebase expects). */
  gamesPlayed: number;
  /**
   * Special-teams decomposition (ratings/specialTeams.ts), always computed
   * so it's visible for evaluation even while its weight is 0 -- see
   * elo.ts's TeamRatingState doc for why these stay separate from
   * offPoints/defPoints rather than folded in.
   */
  stFieldPositionOffPoints: number;
  stFieldPositionDefPoints: number;
  stFgPoints: number;
}

/**
 * Computes every team's rating from a set of (already as-of-week-filtered
 * -- see opponentAdjust.ts's header doc, this function is just as
 * lookahead-unsafe as the solve itself if the caller passes future games)
 * performances, optionally blending in a preseason prior via weighted
 * pseudo-games. priorSolve is typically the prior season's own final
 * solve output (db/repo.ts's getPriorSeasonEpaSolve) -- passing a
 * different, inconsistently-anchored prior risks the gauge-freedom issue
 * documented in opponentAdjust.ts's initialOff/initialDef doc (though
 * that risk applies to arbitrary priors generally, not specifically to
 * this pseudo-game mechanism, which was built and tested precisely
 * because seeding doesn't have this problem the same way -- see the
 * mechanism's own doc for the distinction).
 *
 * returningProduction (optional, CFBD's percentPPA -- db/repo.ts's
 * getReturningProductionDistribution) scales EACH TEAM'S OWN prior weight
 * by how much of last year's production is actually coming back, instead
 * of trusting every team's carryover equally: a team that gutted its
 * roster gets a much weaker (or near-zero) pull toward its prior-season
 * number, while a team that returns nearly everyone keeps close to
 * params.priorWeight's full trust. This is the fix for the gap flagged
 * directly: with the 2026 season not yet started, every team's rating was
 * PURE prior-season carryover with zero adjustment for transfers/draft
 * losses -- e.g. a team that lost most of its production would still be
 * rated as if it returned the same team. A team missing from
 * returningProduction (data not ingested/resolved) falls back to the flat
 * params.priorWeight, not zero -- missing data isn't evidence of turnover.
 * CFBD's percentPPA is OFFENSE-ONLY (passing/receiving/rushing PPA) --
 * applied here to both off and def prior weight for the same team as a
 * proxy for overall roster continuity, since no defensive equivalent
 * exists in this data source. Clamped to [0, 1.5] defensively against a
 * data outlier; not itself derived from a real-data fit (fraction directly
 * scales the already-calibrated priorWeight=2, not a fresh coefficient).
 */
export function computeSolveRatings(
  performances: TeamPerformance[],
  priorSolve: Map<number, { off: number; def: number }> | undefined,
  params: SolveRatingParams,
  stPlays: RawPlayForSpecialTeams[] = [],
  returningProduction?: Map<number, number>,
): Map<number, SolveTeamRating> {
  const priors =
    priorSolve && params.priorWeight > 0
      ? new Map(
          [...priorSolve]
            .map(([teamId, p]) => {
              const fraction = returningProduction?.get(teamId);
              const teamWeight = fraction === undefined ? params.priorWeight : params.priorWeight * Math.min(1.5, Math.max(0, fraction));
              return [teamId, { off: p.off, def: p.def, weight: teamWeight }] as const;
            })
            .filter(([, p]) => p.weight > 0),
        )
      : undefined;

  const solve = computeOpponentAdjustedRatings(performances, { priors });

  // Always computed, regardless of weight -- see SolveRatingParams' doc on
  // why the raw ST components stay visible even while inert. A team absent
  // from either map (no qualifying field-position drives or FG attempts)
  // gets 0, not an imputed value, per the build spec's missing-data guard.
  //
  // Field position is RESIDUALIZED against the EPA off/def solve before
  // use, not used raw -- Step 2's evaluation found a real (~0.43) but not
  // extreme correlation between raw field-position DEF and the existing
  // EPA DEF rating (a genuinely good defense forces more punts and short
  // fields for reasons unrelated to kicking-game coverage specifically).
  // Regressing it out here means the ST contribution is, by construction,
  // the part of field position OFF/DEF doesn't already explain -- same
  // "regress on rating, keep the residual" technique elo.ts's
  // excessDispersion already uses. See specialTeams.ts's
  // residualizeFieldPosition doc for the full reasoning.
  const fieldPositionSolve = computeFieldPositionSolve(stPlays);
  const fieldPositionResidual = residualizeFieldPosition(fieldPositionSolve.off, fieldPositionSolve.def, solve.off, solve.def);
  const fgEfficiency = computeFgEfficiency(stPlays, params.fgShrinkK ?? 20);
  const fpWeight = params.pointsPerFieldPositionYard ?? 0;
  const fgWeight = params.pointsPerFgAboveExpected ?? 0;

  const ratings = new Map<number, SolveTeamRating>();
  for (const teamId of solve.off.keys()) {
    const off = solve.off.get(teamId)!;
    const def = solve.def.get(teamId)!;
    const offPoints = params.pointsPerEpaSolve * off;
    const defPoints = params.pointsPerEpaSolve * def;
    const gamesPlayed = (solve.teamDiagnostics.get(teamId)?.gamesPlayed ?? 0) / 2;

    const stFieldPositionOffPoints = fpWeight * (fieldPositionResidual.off.get(teamId) ?? 0);
    const stFieldPositionDefPoints = fpWeight * (fieldPositionResidual.def.get(teamId) ?? 0);
    const stFgPoints = fgWeight * (fgEfficiency.get(teamId)?.shrunkExcessMakeRate ?? 0);

    const rating = offPoints - defPoints + (stFieldPositionOffPoints - stFieldPositionDefPoints) + stFgPoints;
    ratings.set(teamId, {
      rating,
      offPoints,
      defPoints,
      gamesPlayed,
      stFieldPositionOffPoints,
      stFieldPositionDefPoints,
      stFgPoints,
    });
  }
  return ratings;
}
