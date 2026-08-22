import { getSeasonGamesForRating } from "../db/repo.js";
import type { GameForRating, Sport } from "../db/repo.js";
import { getRatingParams } from "../ratings/config.js";
import type { RatingParams } from "../ratings/config.js";
import { ridgeFit, selectLambda, computeVif } from "../stats/ridge.js";
import type { ComponentParamKey } from "./sweep.js";
import { runBacktest } from "./run.js";
import { getOverallReport, getOpeningCoverRate } from "./report.js";
import { JOINT_REFIT_COMPONENTS, computeComponentFeature, computeShrunkOpponentAdjFeature, computeBaseMargin, buildAsOfWeekGames } from "./jointRefitMath.js";

export { JOINT_REFIT_COMPONENTS, computeComponentFeature, computeShrunkOpponentAdjFeature, computeBaseMargin, buildAsOfWeekGames } from "./jointRefitMath.js";

/**
 * "contemporaneous" (the original design, see this file's header doc):
 * each component's raw per-game differential explains that SAME game's
 * margin -- a same-game accounting decomposition, not a forecast.
 *
 * "predictive": features come from buildAsOfWeekGames (each team's OWN
 * rolling average through PRIOR games this season only), and the target
 * is still the REAL outcome of the game being predicted -- i.e. "does
 * this team's accumulated explosiveness through last week forecast next
 * week's margin," the actual question the deployed Elo update needs
 * answered. Expect RMSE to land far closer to market/forecast quality
 * (~13-14 points) than the contemporaneous mode's ~8-9, since this is
 * now a genuine out-of-sample-style forecasting problem instead of an
 * explanatory one -- and expect some coefficients to move substantially
 * or go near-zero, which is the informative part.
 */
export type JointRefitMode = "contemporaneous" | "predictive";

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

/**
 * Components whose missingness is STRUCTURAL (not a random/lookup-bug
 * subsample) get value+indicator treatment instead of a hard complete-case
 * gate: the raw feature is zero-imputed when missing (its own neutral "no
 * information this game" value) AND a companion binary column (1 =
 * imputed, 0 = observed) is added. This lets ridge separate "the value was
 * X" from "there was nothing to measure" instead of conflating them into
 * one attenuated coefficient -- and the indicator's own fitted coefficient
 * is diagnostic: if it's doing all the work, the underlying stat is really
 * just a proxy for whatever situation causes the missingness (see each
 * doc below) and its raw-value coefficient shouldn't be trusted at face
 * value.
 *
 * - pointsPerFinishingDrives: a scoring opportunity requires a drive
 *   starting inside the opponent's 40, so a blowout's losing side often
 *   has none -- missingness is a proxy for "this side got blown out."
 * - pointsPerFgMakeRate: a team that attempts zero field goals in a game
 *   (scored only via TDs, or never got in range) has no make rate to
 *   measure -- missingness is a proxy for "no field goal opportunities."
 * - pointsPerOpponentAdj: off_adj/def_adj require prior-week data, so a
 *   team's first game of the season structurally has none -- missingness
 *   is a proxy for "early season, ratings not yet stabilized."
 *
 * Every other component (explosiveness, down/distance splits, sack rate,
 * field position) still hard-gates the row in CONTEMPORANEOUS mode: their
 * missingness in this dataset is negligible (Task 38's coverage printout
 * showed ~100%), so a gate costs almost nothing and avoids adding
 * indicator columns with no diagnostic value.
 *
 * In PREDICTIVE mode, ALL 8 components get value+indicator treatment
 * instead: buildAsOfWeekGames' as-of-week rolling averages can be null
 * for any component (not just these 3), not only on a team's literal
 * first game of the season (which is hard-gated separately via the
 * mandatory EPA requirement) but whenever a team hasn't yet accumulated
 * THAT specific stat (e.g. zero field goal attempts across several early
 * games) -- gating on all 8 would compound losses across components
 * instead of handling each one's own missingness independently.
 */
function getImputedComponentKeys(mode: JointRefitMode): ComponentParamKey[] {
  return mode === "predictive" ? JOINT_REFIT_COMPONENTS.map((c) => c.key) : ["pointsPerFinishingDrives", "pointsPerFgMakeRate", "pointsPerOpponentAdj"];
}

export interface JointRefitResult {
  gamesUsed: number;
  gamesTotal: number;
  selectedLambda: number;
  weights: Record<ComponentParamKey, number>;
  intercept: number;
  cvResults: { lambda: number; mse: number }[];
  /** For each of IMPUTED_COMPONENTS: how many of gamesUsed had a real (observed) vs zero-imputed value, and the fitted coefficient on that component's missingness indicator column -- see IMPUTED_COMPONENTS' doc for how to read this. */
  imputedComponents: { key: ComponentParamKey; real: number; imputed: number; missingIndicatorCoefficient: number }[];
  /** Per-component two-sided (both home and away) non-null count across ALL candidate games, counted BEFORE any gating or imputation -- see fitJointComponentWeights' inline doc. */
  componentCoverage: { key: ComponentParamKey; label: string; nonNullCount: number }[];
  /** Variance inflation factor per design-matrix column (8 components + one per IMPUTED_COMPONENTS indicator) -- see stats/ridge.ts's computeVif doc. VIF > 5 worth a look, VIF > 10 means that column's coefficient is close to uninterpretable alone. */
  vif: { label: string; vif: number }[];
  /** Only set when fitJointComponentWeights was called with includeBaseMarginFeature=true: the fitted coefficient on baseMargin itself, included as a 9th feature so the 8 components' weights become CONDITIONAL on the existing EPA/success-rate core rather than absorbing whatever it would have explained. */
  baseMarginCoefficient: number | null;
}

/**
 * Fits all 8 component weights jointly via ridge regression on
 * trainSeasonStart..trainSeasonEnd, plus one missingness-indicator column
 * per IMPUTED_COMPONENTS entry (see its doc). Complete-case gated on
 * every OTHER component (explosiveness, down/distance splits, sack rate,
 * field position), whose missingness in practice is negligible.
 *
 * Lambda selection uses group-aware CV keyed by `${season}-${week}` (see
 * stats/ridge.ts's assignFolds doc): off_adj/def_adj for every game in a
 * given week come from ONE shared iterative opponent-adjustment solve, so
 * games in the same week are not independent rows -- an ungrouped
 * (contiguous or random) fold split would let a test-fold game's
 * evaluation implicitly benefit from its train-fold week-mate's shared
 * solve, understating the true out-of-sample error.
 */
export async function fitJointComponentWeights(
  sport: Sport,
  trainSeasonStart: number,
  trainSeasonEnd: number,
  lambdaGrid: number[] = [0.1, 0.3, 1, 3, 10, 30, 100],
  mode: JointRefitMode = "contemporaneous",
  /**
   * When true, baseMargin (the EPA/success-rate core, computed exactly as
   * computeBaseMargin always has) is added as a 9th design-matrix feature
   * and the target becomes the raw actualMarginHome, instead of
   * residualizing baseMargin out of the target beforehand. Per review:
   * every one of the 8 components is a reweighting of the SAME
   * play-by-play EPA already summarizes (success rate is EPA thresholded,
   * explosiveness is EPA conditioned on success, down-splits are EPA
   * partitioned by situation, opponentAdj is EPA opponent-adjusted) -- if
   * EPA is close to a sufficient statistic for play-level performance,
   * the 8 components have little left to contribute ONCE EPA's own
   * predictive content is in the design matrix rather than pre-subtracted
   * out (where their coefficients would otherwise silently absorb
   * whatever EPA would have explained). This is the direct test: if the
   * 8 collapse toward 0 with baseMargin included, redundancy is confirmed.
   */
  includeBaseMarginFeature: boolean = false,
): Promise<JointRefitResult> {
  const base = getRatingParams(sport);
  let gamesBySeason: { season: number; game: GameForRating }[] = [];
  for (let season = trainSeasonStart; season <= trainSeasonEnd; season++) {
    for (const game of await getSeasonGamesForRating(sport, season, 999)) {
      gamesBySeason.push({ season, game });
    }
  }
  if (mode === "predictive") {
    gamesBySeason = buildAsOfWeekGames(gamesBySeason, base);
  }

  const imputedComponentKeys = getImputedComponentKeys(mode);
  const X: number[][] = [];
  const y: number[] = [];
  const groups: string[] = [];
  const imputedIdx = imputedComponentKeys.map((key) => JOINT_REFIT_COMPONENTS.findIndex((c) => c.key === key));
  const imputedCounts = imputedComponentKeys.map(() => ({ real: 0, imputed: 0 }));

  // Per-component two-sided coverage, counted BEFORE any gating or
  // imputation -- printed so the effective complete-case n (and which
  // component is actually the binding constraint) is visible up front,
  // not discovered after the fact from a crashed or empty-looking fit.
  const componentCoverage: { key: ComponentParamKey; label: string; nonNullCount: number }[] = JOINT_REFIT_COMPONENTS.map((c) => ({
    key: c.key,
    label: c.label,
    nonNullCount: 0,
  }));

  for (const { season, game } of gamesBySeason) {
    // opponentAdj uses the SHRUNK feature (games-played shrinkage applied),
    // matching exactly what elo.ts will consume once the fitted weight is
    // plugged in -- every other component uses the raw differential.
    const features = JOINT_REFIT_COMPONENTS.map((c) =>
      c.key === "pointsPerOpponentAdj" ? computeShrunkOpponentAdjFeature(game, base.opponentAdjShrinkageK) : computeComponentFeature(game, c.key, c.invert),
    );
    features.forEach((f, i) => {
      if (f !== null) componentCoverage[i]!.nonNullCount += 1;
    });

    const indicators: number[] = new Array(imputedComponentKeys.length).fill(0);
    imputedIdx.forEach((idx, k) => {
      if (features[idx] === null) {
        features[idx] = 0;
        indicators[k] = 1;
        imputedCounts[k]!.imputed += 1;
      } else {
        imputedCounts[k]!.real += 1;
      }
    });
    if (features.some((f) => f === null)) continue; // one of the hard-gated (non-imputed) components was missing

    const baseMargin = computeBaseMargin(game, base);
    const actualMarginHome = game.homeScore - game.awayScore;
    if (includeBaseMarginFeature) {
      X.push([baseMargin, ...(features as number[]), ...indicators]);
      y.push(actualMarginHome);
    } else {
      X.push([...(features as number[]), ...indicators]);
      y.push(actualMarginHome - baseMargin);
    }
    groups.push(`${season}-${game.week}`);
  }

  if (X.length === 0) {
    throw new Error(
      `fitJointComponentWeights: 0 of ${gamesBySeason.length} games survived the complete-case gate. Per-component two-sided coverage: ${componentCoverage
        .map((c) => `${c.label}=${c.nonNullCount}`)
        .join(", ")}. Whichever count is near 0 (and isn't imputed under this mode) is the binding constraint -- check that component's ingest/coverage before re-running.`,
    );
  }

  // VIF on the raw (pre-standardization -- VIF is scale-invariant) design
  // matrix, computed on the SAME X the fit uses: pairwise correlation can
  // miss a 3+-way collinear cluster (each column predictable from a
  // COMBINATION of the others with no single alarming pair), which VIF
  // catches by regressing each column on ALL the others at once. See
  // stats/ridge.ts's computeVif doc for how to read the numbers.
  const baseMarginOffset = includeBaseMarginFeature ? 1 : 0;
  const vifValues = computeVif(X);
  const vifLabels = [
    ...(includeBaseMarginFeature ? ["baseMargin"] : []),
    ...JOINT_REFIT_COMPONENTS.map((c) => c.label),
    ...imputedComponentKeys.map((key) => `${key}_missing_indicator`),
  ];
  const vif = vifLabels.map((label, i) => ({ label, vif: vifValues[i]! }));

  const cvResults = selectLambda(X, y, lambdaGrid, 5, groups);
  const bestLambda = cvResults[0]!.lambda;
  const fit = ridgeFit(X, y, bestLambda);

  const weights = {} as Record<ComponentParamKey, number>;
  JOINT_REFIT_COMPONENTS.forEach((c, i) => {
    weights[c.key] = fit.coefficients[baseMarginOffset + i]!;
  });
  const imputedComponents = imputedComponentKeys.map((key, k) => ({
    key,
    real: imputedCounts[k]!.real,
    imputed: imputedCounts[k]!.imputed,
    missingIndicatorCoefficient: fit.coefficients[baseMarginOffset + JOINT_REFIT_COMPONENTS.length + k]!,
  }));
  const baseMarginCoefficient = includeBaseMarginFeature ? fit.coefficients[0]! : null;

  return {
    gamesUsed: X.length,
    gamesTotal: gamesBySeason.length,
    selectedLambda: bestLambda,
    weights,
    imputedComponents,
    componentCoverage,
    vif,
    baseMarginCoefficient,
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
  mode: JointRefitMode = "contemporaneous",
): Promise<JointRefitHoldoutComparison> {
  const refit = await fitJointComponentWeights(sport, trainSeasonStart, trainSeasonEnd, lambdaGrid, mode);
  const base = getRatingParams(sport);
  const namePrefix = mode === "predictive" ? "jointrefit-predictive" : "jointrefit";

  const handTuned = await runBacktest({
    name: `${namePrefix}-handtuned-${sport}-test${testSeason}`,
    sport,
    seasonStart: testSeason,
    seasonEnd: testSeason,
    paramsOverride: base,
  });
  const handTunedOverall = await getOverallReport(handTuned.backtestRunId);
  const handTunedOpening = await getOpeningCoverRate(handTuned.backtestRunId);

  const jointParams: RatingParams = { ...base, ...refit.weights };
  const joint = await runBacktest({
    name: `${namePrefix}-joint-${sport}-test${testSeason}`,
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
