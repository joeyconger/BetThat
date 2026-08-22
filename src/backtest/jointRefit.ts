import { getSeasonGamesForRating } from "../db/repo.js";
import type { GameForRating, Sport } from "../db/repo.js";
import { getRatingParams } from "../ratings/config.js";
import type { RatingParams } from "../ratings/config.js";
import { ridgeFit, selectLambda } from "../stats/ridge.js";
import type { ComponentParamKey } from "./sweep.js";
import { runBacktest } from "./run.js";
import { getOverallReport, getOpeningCoverRate } from "./report.js";
import { JOINT_REFIT_COMPONENTS, computeComponentFeature, computeShrunkOpponentAdjFeature, computeBaseMargin } from "./jointRefitMath.js";

export { JOINT_REFIT_COMPONENTS, computeComponentFeature, computeShrunkOpponentAdjFeature, computeBaseMargin } from "./jointRefitMath.js";

/**
 * Joint refit of the 8 component pointsPerX weights, replacing the
 * one-at-a-time-calibrated values with a single ridge-regularized fit --
 * see ratings/config.ts's pointsPerOpponentAdj doc for the finding that
 * motivated this: the sweep-one-at-a-time discipline holds every OTHER
 * weight fixed at values calibrated in the swept term's absence, so it
 * can only show redundancy UNDER THE CURRENT BLEND, not distinguish "this
 * signal carries nothing" from "this signal is correlated with other
 * components that already got credit for it."
 *
 * Design (pure math lives in jointRefitMath.ts): each component's raw
 * per-game differential (homeNetX - awayNetX, same quantity elo.ts's
 * additive terms compute) becomes one ridge regression feature. The
 * target is actualMarginHome - baseMargin, where baseMargin is the
 * epaMargin/successRateWeight blend elo.ts computes BEFORE any of the 8
 * components are added -- i.e. the regression explains the part of the
 * real game margin the base blend doesn't already capture, exactly the
 * job the 8 additive terms are FOR. Fitting jointly (not one at a time)
 * lets ridge allocate credit across genuinely correlated components
 * (explosiveness, down/distance splits, opponent-adjustment all measure
 * overlapping variance in team strength) instead of each one soaking up
 * however much appears attributable to it in isolation.
 *
 * This does NOT change what the 8 components feed into -- they still
 * enter computeSeasonRatings' actualMargin the same additive way, using
 * the SAME per-game achieved-performance values as before. Only HOW
 * their weights are chosen changes: a joint regularized fit on training
 * data instead of 8 separate single-parameter sweeps. This preserves the
 * architecture's existing "no lookahead" property: the components are
 * always this-game's-own achieved stats feeding the Elo UPDATE, never
 * used to predict a future game directly, so a cross-sectional
 * (non-time-ordered) regression over training-season games is legitimate
 * here -- it's not fitting a predictive model, it's calibrating what the
 * update signal itself should weigh.
 */
export interface JointRefitResult {
  gamesUsed: number;
  gamesTotal: number;
  selectedLambda: number;
  weights: Record<ComponentParamKey, number>;
  intercept: number;
  cvResults: { lambda: number; mse: number }[];
  /** Of gamesUsed, how many had a real (non-imputed) pointsPerFinishingDrives feature -- see the zero-imputation doc below. */
  finishingDrivesReal: number;
  finishingDrivesImputed: number;
  /** Per-component two-sided (both home and away) non-null count across ALL candidate games, counted BEFORE any gating or imputation -- see fitJointComponentWeights' inline doc. */
  componentCoverage: { key: ComponentParamKey; label: string; nonNullCount: number }[];
}

/**
 * Fits all 8 component weights jointly via ridge regression on
 * trainSeasonStart..trainSeasonEnd. Complete-case on 7 of the 8
 * components -- opponentAdj is the main remaining limiting factor
 * (off_adj/def_adj require prior-week data, so week-1 games and a team's
 * first game are always excluded), same population
 * cfb-opponentadjusted-ingest already reported (~693-705 of ~753 games
 * per season). pointsPerFinishingDrives is zero-imputed rather than
 * gating rows (see the inline doc where features are built) since its
 * own two-sided coverage is a structurally non-random ~26%.
 */
export async function fitJointComponentWeights(
  sport: Sport,
  trainSeasonStart: number,
  trainSeasonEnd: number,
  lambdaGrid: number[] = [0.1, 0.3, 1, 3, 10, 30, 100],
): Promise<JointRefitResult> {
  const base = getRatingParams(sport);
  const allGames: GameForRating[] = [];
  for (let season = trainSeasonStart; season <= trainSeasonEnd; season++) {
    allGames.push(...(await getSeasonGamesForRating(sport, season, 999)));
  }

  const X: number[][] = [];
  const y: number[] = [];
  let finishingDrivesImputed = 0;
  let finishingDrivesReal = 0;
  const finishingDrivesIdx = JOINT_REFIT_COMPONENTS.findIndex((c) => c.key === "pointsPerFinishingDrives");

  // Per-component two-sided coverage, counted BEFORE any gating or
  // imputation -- printed so the effective complete-case n (and which
  // component is actually the binding constraint) is visible up front,
  // not discovered after the fact from a crashed or empty-looking fit.
  const componentCoverage: { key: ComponentParamKey; label: string; nonNullCount: number }[] = JOINT_REFIT_COMPONENTS.map((c) => ({
    key: c.key,
    label: c.label,
    nonNullCount: 0,
  }));

  for (const game of allGames) {
    // opponentAdj uses the SHRUNK feature (games-played shrinkage applied),
    // matching exactly what elo.ts will consume once the fitted weight is
    // plugged in -- every other component uses the raw differential.
    //
    // pointsPerFinishingDrives is zero-imputed rather than gating the row:
    // Task 38 found its TWO-SIDED coverage is only ~26% of games (vs ~92%+
    // for every other component), and -- critically -- this isn't a random
    // subsample. It's structurally the COMPETITIVE games: a scoring
    // opportunity requires a drive starting inside the opponent's 40, so a
    // blowout's losing side frequently has zero, which is exactly the kind
    // of large-margin game CLV work most needs the OTHER 7 components
    // calibrated on. Requiring finishingDrives complete would silently
    // train the whole joint fit on a non-representative, close-games-only
    // population. Zero (== "no information from this component this game")
    // is finishingDrives' own neutral value, so this only costs some
    // attenuation on ITS coefficient -- the other 7 keep the full sample.
    const features = JOINT_REFIT_COMPONENTS.map((c) =>
      c.key === "pointsPerOpponentAdj" ? computeShrunkOpponentAdjFeature(game, base.opponentAdjShrinkageK) : computeComponentFeature(game, c.key, c.invert),
    );
    features.forEach((f, i) => {
      if (f !== null) componentCoverage[i]!.nonNullCount += 1;
    });
    if (features[finishingDrivesIdx] === null) {
      features[finishingDrivesIdx] = 0;
      finishingDrivesImputed += 1;
    } else {
      finishingDrivesReal += 1;
    }
    if (features.some((f) => f === null)) continue;

    const baseMargin = computeBaseMargin(game, base);
    const actualMarginHome = game.homeScore - game.awayScore;
    X.push(features as number[]);
    y.push(actualMarginHome - baseMargin);
  }

  if (X.length === 0) {
    throw new Error(
      `fitJointComponentWeights: 0 of ${allGames.length} games survived the complete-case gate. Per-component two-sided coverage: ${componentCoverage
        .map((c) => `${c.label}=${c.nonNullCount}`)
        .join(", ")}. Whichever count is near 0 is the binding constraint -- check that component's ingest/coverage before re-running.`,
    );
  }

  const cvResults = selectLambda(X, y, lambdaGrid, 5);
  const bestLambda = cvResults[0]!.lambda;
  const fit = ridgeFit(X, y, bestLambda);

  const weights = {} as Record<ComponentParamKey, number>;
  JOINT_REFIT_COMPONENTS.forEach((c, i) => {
    weights[c.key] = fit.coefficients[i]!;
  });

  return {
    gamesUsed: X.length,
    gamesTotal: allGames.length,
    selectedLambda: bestLambda,
    weights,
    finishingDrivesReal,
    finishingDrivesImputed,
    componentCoverage,
    intercept: fit.intercept,
    cvResults,
  };
}

export interface JointRefitHoldoutComparison {
  refit: JointRefitResult;
  handTunedHoldoutRunId: number;
  handTunedGames: number;
  handTunedCoverRateVsOpening: number | null;
  handTunedAvgClv: number | null;
  jointHoldoutRunId: number;
  jointGames: number;
  jointCoverRateVsOpening: number | null;
  jointAvgClv: number | null;
}

/**
 * Fits the joint weights on trainSeasonStart..trainSeasonEnd, then
 * compares two backtests on testSeason (never touched during fitting):
 * the CURRENT hand-tuned/one-at-a-time-calibrated weights vs. the newly
 * jointly-fit weights, both evaluated on the identical holdout games.
 */
export async function runJointRefitHoldout(
  sport: Sport,
  trainSeasonStart: number,
  trainSeasonEnd: number,
  testSeason: number,
  lambdaGrid?: number[],
): Promise<JointRefitHoldoutComparison> {
  const refit = await fitJointComponentWeights(sport, trainSeasonStart, trainSeasonEnd, lambdaGrid);
  const base = getRatingParams(sport);

  const handTuned = await runBacktest({
    name: `jointrefit-handtuned-${sport}-test${testSeason}`,
    sport,
    seasonStart: testSeason,
    seasonEnd: testSeason,
    paramsOverride: base,
  });
  const handTunedOverall = await getOverallReport(handTuned.backtestRunId);
  const handTunedOpening = await getOpeningCoverRate(handTuned.backtestRunId);

  const jointParams: RatingParams = { ...base, ...refit.weights };
  const joint = await runBacktest({
    name: `jointrefit-joint-${sport}-test${testSeason}`,
    sport,
    seasonStart: testSeason,
    seasonEnd: testSeason,
    paramsOverride: jointParams,
  });
  const jointOverall = await getOverallReport(joint.backtestRunId);
  const jointOpening = await getOpeningCoverRate(joint.backtestRunId);

  return {
    refit,
    handTunedHoldoutRunId: handTuned.backtestRunId,
    handTunedGames: handTuned.scored,
    handTunedCoverRateVsOpening: handTunedOpening.coverRateVsOpening,
    handTunedAvgClv: handTunedOverall.avgClv,
    jointHoldoutRunId: joint.backtestRunId,
    jointGames: joint.scored,
    jointCoverRateVsOpening: jointOpening.coverRateVsOpening,
    jointAvgClv: jointOverall.avgClv,
  };
}
