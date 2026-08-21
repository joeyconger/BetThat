import { getRatingParams } from "../ratings/config.js";
import type { RatingParams } from "../ratings/config.js";
import type { Sport } from "../db/repo.js";
import { runBacktest } from "./run.js";
import { getOverallReport, getConfidenceReport, getOpeningCoverRate } from "./report.js";

/**
 * Tries a grid of rating-model constants against the same season range and
 * reports cover rate for each — the actual calibration step the README's
 * "What's next" flags as pending. Manual editing (redeploy, re-run, read
 * logs) doesn't scale once there's a real grid to search; this automates
 * it in one run.
 *
 * Sweeps pointsPerEpa and baseK by default — the two constants most
 * directly implicated by what testing has found so far (unanchored
 * predictions running too hot, i.e. pointsPerEpa too large). Deliberately
 * a small (3x3) grid — each combo re-runs the full season replay from
 * scratch, so this is coarse-search-then-refine: run this, look at which
 * corner of the grid wins, then narrow DEFAULT_POINTS_PER_EPA/
 * DEFAULT_BASE_K around it and run again, rather than one huge grid.
 */
const DEFAULT_POINTS_PER_EPA = [20, 30, 40];
const DEFAULT_BASE_K = [0.15, 0.25, 0.35];

export interface SweepResult {
  pointsPerEpa: number;
  baseK: number;
  runId: number;
  games: number;
  coverRate: number | null;
  avgClv: number | null;
}

export async function runSweep(
  sport: Sport,
  seasonStart: number,
  seasonEnd: number,
  pointsPerEpaGrid: number[] = DEFAULT_POINTS_PER_EPA,
  baseKGrid: number[] = DEFAULT_BASE_K,
): Promise<SweepResult[]> {
  const base = getRatingParams(sport);
  const results: SweepResult[] = [];

  for (const pointsPerEpa of pointsPerEpaGrid) {
    for (const baseK of baseKGrid) {
      const paramsOverride: RatingParams = { ...base, pointsPerEpa, baseK };
      const name = `sweep-${sport}-ppe${pointsPerEpa}-k${baseK}`;
      const { backtestRunId, scored } = await runBacktest({
        name,
        sport,
        seasonStart,
        seasonEnd,
        paramsOverride,
      });
      const overall = await getOverallReport(backtestRunId);
      results.push({
        pointsPerEpa,
        baseK,
        runId: backtestRunId,
        games: scored,
        coverRate: overall.coverRate,
        avgClv: overall.avgClv,
      });
      console.log(
        `pointsPerEpa=${pointsPerEpa} baseK=${baseK}: ${scored} games, cover=${
          overall.coverRate === null ? "n/a" : (overall.coverRate * 100).toFixed(1) + "%"
        } (run ${backtestRunId})`,
      );
    }
  }

  results.sort((a, b) => (b.coverRate ?? -1) - (a.coverRate ?? -1));
  return results;
}

/**
 * Same coarse-search-then-refine approach as runSweep, but for the two
 * external-ratings blend weights (spPriorWeight, eloSignalPoints) added in
 * ratings/config.ts — see README "External ratings". Deliberately holds
 * pointsPerEpa/baseK fixed at a single value (the best combo from an
 * earlier runSweep pass) rather than sweeping all four at once: a 3x3x3x3
 * grid would take ~9x longer for marginal extra information over two
 * separate, smaller sweeps. CFB-only — these params are always 0 for NFL.
 */
const DEFAULT_SP_PRIOR_WEIGHT = [0, 0.3, 0.5, 0.7, 1];
const DEFAULT_ELO_SIGNAL_POINTS = [0, 1, 1.5, 2, 3];

export interface ExternalRatingsSweepResult {
  spPriorWeight: number;
  eloSignalPoints: number;
  runId: number;
  games: number;
  coverRate: number | null;
  avgClv: number | null;
}

export async function runExternalRatingsSweep(
  sport: Sport,
  seasonStart: number,
  seasonEnd: number,
  fixedPointsPerEpa: number,
  fixedBaseK: number,
  spPriorWeightGrid: number[] = DEFAULT_SP_PRIOR_WEIGHT,
  eloSignalPointsGrid: number[] = DEFAULT_ELO_SIGNAL_POINTS,
  excludeFromWeek?: number,
): Promise<ExternalRatingsSweepResult[]> {
  const base = getRatingParams(sport);
  const results: ExternalRatingsSweepResult[] = [];

  for (const spPriorWeight of spPriorWeightGrid) {
    for (const eloSignalPoints of eloSignalPointsGrid) {
      const paramsOverride: RatingParams = {
        ...base,
        pointsPerEpa: fixedPointsPerEpa,
        baseK: fixedBaseK,
        spPriorWeight,
        eloSignalPoints,
      };
      const name = `sweep-external-${sport}-sp${spPriorWeight}-elo${eloSignalPoints}`;
      const { backtestRunId, scored } = await runBacktest({
        name,
        sport,
        seasonStart,
        seasonEnd,
        paramsOverride,
        excludeFromWeek,
      });
      const overall = await getOverallReport(backtestRunId);
      results.push({
        spPriorWeight,
        eloSignalPoints,
        runId: backtestRunId,
        games: scored,
        coverRate: overall.coverRate,
        avgClv: overall.avgClv,
      });
      console.log(
        `spPriorWeight=${spPriorWeight} eloSignalPoints=${eloSignalPoints}: ${scored} games, cover=${
          overall.coverRate === null ? "n/a" : (overall.coverRate * 100).toFixed(1) + "%"
        } (run ${backtestRunId})`,
      );
    }
  }

  results.sort((a, b) => (b.coverRate ?? -1) - (a.coverRate ?? -1));
  return results;
}

/**
 * Sweeps sosWeight — the strength-of-schedule knob (see ratings/elo.ts's
 * SOS multiplier and README "Rating model") — which has never actually
 * been validated against a backtest. CFB's 0.4 (vs. NFL's 0.15) was set
 * "per spec" at the very start of the project and never tested; this
 * checks whether it actually helps, including sosWeight=0 in the grid as
 * a real "no SOS adjustment at all" baseline to compare against. Holds
 * every other param fixed at CFB's current validated defaults.
 */
const DEFAULT_SOS_WEIGHT = [0, 0.1, 0.2, 0.3, 0.4, 0.6, 0.8, 1.0];

export interface SosSweepResult {
  sosWeight: number;
  runId: number;
  games: number;
  coverRate: number | null;
  avgClv: number | null;
}

export async function runSosSweep(
  sport: Sport,
  seasonStart: number,
  seasonEnd: number,
  sosWeightGrid: number[] = DEFAULT_SOS_WEIGHT,
): Promise<SosSweepResult[]> {
  const base = getRatingParams(sport);
  const results: SosSweepResult[] = [];

  for (const sosWeight of sosWeightGrid) {
    const paramsOverride: RatingParams = { ...base, sosWeight };
    const name = `sweep-sos-${sport}-w${sosWeight}`;
    const { backtestRunId, scored } = await runBacktest({ name, sport, seasonStart, seasonEnd, paramsOverride });
    const overall = await getOverallReport(backtestRunId);
    results.push({
      sosWeight,
      runId: backtestRunId,
      games: scored,
      coverRate: overall.coverRate,
      avgClv: overall.avgClv,
    });
    console.log(
      `sosWeight=${sosWeight}: ${scored} games, cover=${
        overall.coverRate === null ? "n/a" : (overall.coverRate * 100).toFixed(1) + "%"
      } (run ${backtestRunId})`,
    );
  }

  results.sort((a, b) => (b.coverRate ?? -1) - (a.coverRate ?? -1));
  return results;
}

/**
 * Sweeps spSignalPoints — the additive, every-week SP+ signal (see
 * RatingParams.spSignalPoints' doc for why this is a DIFFERENT mechanism
 * from spPriorWeight, which a real sweep already found actively hurt cover
 * rate once weighted above ~0.3). eloSignalPoints' identical additive
 * treatment of a similar external rating (CFBD's weekly Elo) had "a
 * genuine, fairly clean positive effect" in that same sweep — this checks
 * whether SP+ behaves the same way once given the same treatment, rather
 * than assuming the spPriorWeight finding rules SP+ out entirely. Holds
 * eloSignalPoints fixed at its own already-swept value so this isolates
 * SP+'s effect specifically.
 */
const DEFAULT_SP_SIGNAL_POINTS = [0, 0.5, 1, 1.5, 2, 3];

export interface SpSignalSweepResult {
  spSignalPoints: number;
  runId: number;
  games: number;
  coverRate: number | null;
  avgClv: number | null;
}

export async function runSpSignalSweep(
  sport: Sport,
  seasonStart: number,
  seasonEnd: number,
  spSignalPointsGrid: number[] = DEFAULT_SP_SIGNAL_POINTS,
): Promise<SpSignalSweepResult[]> {
  const base = getRatingParams(sport);
  const results: SpSignalSweepResult[] = [];

  for (const spSignalPoints of spSignalPointsGrid) {
    const paramsOverride: RatingParams = { ...base, spSignalPoints };
    const name = `sweep-spsignal-${sport}-sp${spSignalPoints}`;
    const { backtestRunId, scored } = await runBacktest({ name, sport, seasonStart, seasonEnd, paramsOverride });
    const overall = await getOverallReport(backtestRunId);
    results.push({
      spSignalPoints,
      runId: backtestRunId,
      games: scored,
      coverRate: overall.coverRate,
      avgClv: overall.avgClv,
    });
    console.log(
      `spSignalPoints=${spSignalPoints}: ${scored} games, cover=${
        overall.coverRate === null ? "n/a" : (overall.coverRate * 100).toFixed(1) + "%"
      } (run ${backtestRunId})`,
    );
  }

  results.sort((a, b) => (b.coverRate ?? -1) - (a.coverRate ?? -1));
  return results;
}

/**
 * Sweeps successRateWeight x pointsPerSuccessRate (see
 * RatingParams.successRateWeight's doc) — the "how the game went vs. the
 * result" hypothesis: success rate is a lower-variance, more
 * execution-focused signal than EPA/points-per-play, which is itself
 * closer to "the result" (still dominated by a handful of explosive or
 * garbage-time plays). weight=0 is the current pure-EPA baseline, always
 * included so the grid shows whether blending in success rate helps,
 * hurts, or does nothing relative to today's behavior.
 */
const DEFAULT_SUCCESS_RATE_WEIGHT = [0, 0.25, 0.5, 0.75, 1];
const DEFAULT_POINTS_PER_SUCCESS_RATE = [60, 90, 120];

export interface SuccessRateSweepResult {
  successRateWeight: number;
  pointsPerSuccessRate: number;
  runId: number;
  games: number;
  coverRate: number | null;
  avgClv: number | null;
}

export async function runSuccessRateSweep(
  sport: Sport,
  seasonStart: number,
  seasonEnd: number,
  successRateWeightGrid: number[] = DEFAULT_SUCCESS_RATE_WEIGHT,
  pointsPerSuccessRateGrid: number[] = DEFAULT_POINTS_PER_SUCCESS_RATE,
): Promise<SuccessRateSweepResult[]> {
  const base = getRatingParams(sport);
  const results: SuccessRateSweepResult[] = [];

  for (const successRateWeight of successRateWeightGrid) {
    // weight=0 makes pointsPerSuccessRate irrelevant (see elo.ts's blend) --
    // don't waste full backtest re-runs on redundant combos.
    const ppsrGrid = successRateWeight === 0 ? [pointsPerSuccessRateGrid[0]!] : pointsPerSuccessRateGrid;
    for (const pointsPerSuccessRate of ppsrGrid) {
      const paramsOverride: RatingParams = { ...base, successRateWeight, pointsPerSuccessRate };
      const name = `sweep-successrate-${sport}-w${successRateWeight}-p${pointsPerSuccessRate}`;
      const { backtestRunId, scored } = await runBacktest({ name, sport, seasonStart, seasonEnd, paramsOverride });
      const overall = await getOverallReport(backtestRunId);
      results.push({
        successRateWeight,
        pointsPerSuccessRate,
        runId: backtestRunId,
        games: scored,
        coverRate: overall.coverRate,
        avgClv: overall.avgClv,
      });
      console.log(
        `successRateWeight=${successRateWeight} pointsPerSuccessRate=${pointsPerSuccessRate}: ${scored} games, cover=${
          overall.coverRate === null ? "n/a" : (overall.coverRate * 100).toFixed(1) + "%"
        } (run ${backtestRunId})`,
      );
    }
  }

  results.sort((a, b) => (b.coverRate ?? -1) - (a.coverRate ?? -1));
  return results;
}

/**
 * Sweeps bigSpreadShrinkRef (see ratings/elo.ts's predictSpread doc) — a
 * CONFIDENCE-widening knob, not a modelWeight one (a modelWeight-based
 * version was tried first and proven mathematically incapable of changing
 * cover rate/CLV, see predictSpread's doc — same reason overall cover rate
 * is not the right metric here either: computeCovered/computeClv only
 * depend on pickSide, which confidence doesn't touch). So this reports
 * cover rate FILTERED by confidence (getConfidenceReport) at a few
 * ceilings, not the overall/unfiltered rate — that's the metric that can
 * actually move: as bigSpreadShrinkRef shrinks, more big-market-spread
 * games get pushed out of a given confidence ceiling, and the question is
 * whether the games that remain cover better. ref=1000 is effectively a
 * no-op baseline (confidence barely widens even at huge spreads).
 */
const DEFAULT_BIG_SPREAD_SHRINK_REF = [1000, 60, 40, 25, 15, 10, 5];
const SWEEP_CONFIDENCE_CEILINGS = [6, 4, 3, 2];

export interface BigSpreadShrinkSweepResult {
  bigSpreadShrinkRef: number;
  runId: number;
  games: number;
  /** Cover rate restricted to confidence <= each of SWEEP_CONFIDENCE_CEILINGS, same order. */
  coverRateByConfidenceCeiling: Array<{ maxConfidence: number; games: number; coverRate: number | null }>;
}

export async function runBigSpreadShrinkSweep(
  sport: Sport,
  seasonStart: number,
  seasonEnd: number,
  refGrid: number[] = DEFAULT_BIG_SPREAD_SHRINK_REF,
): Promise<BigSpreadShrinkSweepResult[]> {
  const base = getRatingParams(sport);
  const results: BigSpreadShrinkSweepResult[] = [];

  for (const bigSpreadShrinkRef of refGrid) {
    const paramsOverride: RatingParams = { ...base, bigSpreadShrinkRef };
    const name = `sweep-bigspread-${sport}-ref${bigSpreadShrinkRef}`;
    const { backtestRunId, scored } = await runBacktest({ name, sport, seasonStart, seasonEnd, paramsOverride });
    const confidenceReport = await getConfidenceReport(backtestRunId, SWEEP_CONFIDENCE_CEILINGS);
    const coverRateByConfidenceCeiling = confidenceReport.map((c) => ({
      maxConfidence: c.maxConfidence,
      games: c.games,
      coverRate: c.coverRate,
    }));
    results.push({ bigSpreadShrinkRef, runId: backtestRunId, games: scored, coverRateByConfidenceCeiling });
    console.log(
      `bigSpreadShrinkRef=${bigSpreadShrinkRef} (run ${backtestRunId}): ` +
        coverRateByConfidenceCeiling
          .map((c) => `conf<=${c.maxConfidence}: ${c.games}g ${c.coverRate === null ? "n/a" : (c.coverRate * 100).toFixed(1) + "%"}`)
          .join(", "),
    );
  }

  // Sort by the tightest ceiling's cover rate — the most-filtered, most-selective bucket is the one this fix targets most directly.
  results.sort((a, b) => (b.coverRateByConfidenceCeiling[3]?.coverRate ?? -1) - (a.coverRateByConfidenceCeiling[3]?.coverRate ?? -1));
  return results;
}

/**
 * A/B test: excludeGarbageTime false vs. true, holding every other param
 * at the sport's current defaults (including successRateWeight/
 * pointsPerSuccessRate, which are already blended in for CFB). Only two
 * points, not a grid, because excludeGarbageTime is a binary data-cleaning
 * switch (which plays count), not a signal weight to interpolate — see
 * RatingParams.excludeGarbageTime's doc. Requires the no-garbage columns
 * to actually be ingested first (syncCfbdGarbageTimeStats /
 * cfb-garbage-time-ingest job) — the true=true run is a silent no-op
 * (identical to false) for any game missing that data.
 */
export interface GarbageTimeSweepResult {
  excludeGarbageTime: boolean;
  runId: number;
  games: number;
  coverRate: number | null;
  avgClv: number | null;
}

export async function runGarbageTimeSweep(
  sport: Sport,
  seasonStart: number,
  seasonEnd: number,
): Promise<GarbageTimeSweepResult[]> {
  const base = getRatingParams(sport);
  const results: GarbageTimeSweepResult[] = [];

  for (const excludeGarbageTime of [false, true]) {
    const paramsOverride: RatingParams = { ...base, excludeGarbageTime };
    const name = `sweep-garbagetime-${sport}-${excludeGarbageTime}`;
    const { backtestRunId, scored } = await runBacktest({ name, sport, seasonStart, seasonEnd, paramsOverride });
    const overall = await getOverallReport(backtestRunId);
    results.push({
      excludeGarbageTime,
      runId: backtestRunId,
      games: scored,
      coverRate: overall.coverRate,
      avgClv: overall.avgClv,
    });
    console.log(
      `excludeGarbageTime=${excludeGarbageTime}: ${scored} games, cover=${
        overall.coverRate === null ? "n/a" : (overall.coverRate * 100).toFixed(1) + "%"
      }, avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(2)} (run ${backtestRunId})`,
    );
  }

  return results;
}

/**
 * Sweeps opponentAdjustWeight -- opponent-adjusted success rate, on top of
 * today's CFB defaults (which already include successRateWeight=0.75/
 * pointsPerSuccessRate=120). No new ingestion needed: success rate is
 * already in team_game_stats for every 2023-2025 game, this only changes
 * how it's interpreted (see RatingParams.opponentAdjustWeight's doc).
 * Includes 0 as the true no-adjustment baseline for direct comparison.
 */
const DEFAULT_OPPONENT_ADJUST_WEIGHT = [0, 0.25, 0.5, 0.75, 1, 1.5, 2];

export interface OpponentAdjustSweepResult {
  opponentAdjustWeight: number;
  runId: number;
  games: number;
  coverRate: number | null;
  avgClv: number | null;
}

export async function runOpponentAdjustSweep(
  sport: Sport,
  seasonStart: number,
  seasonEnd: number,
  weightGrid: number[] = DEFAULT_OPPONENT_ADJUST_WEIGHT,
): Promise<OpponentAdjustSweepResult[]> {
  const base = getRatingParams(sport);
  const results: OpponentAdjustSweepResult[] = [];

  for (const opponentAdjustWeight of weightGrid) {
    const paramsOverride: RatingParams = { ...base, opponentAdjustWeight };
    const name = `sweep-oppadjust-${sport}-w${opponentAdjustWeight}`;
    const { backtestRunId, scored } = await runBacktest({ name, sport, seasonStart, seasonEnd, paramsOverride });
    const overall = await getOverallReport(backtestRunId);
    results.push({
      opponentAdjustWeight,
      runId: backtestRunId,
      games: scored,
      coverRate: overall.coverRate,
      avgClv: overall.avgClv,
    });
    console.log(
      `opponentAdjustWeight=${opponentAdjustWeight}: ${scored} games, cover=${
        overall.coverRate === null ? "n/a" : (overall.coverRate * 100).toFixed(1) + "%"
      }, avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(2)} (run ${backtestRunId})`,
    );
  }

  results.sort((a, b) => (b.coverRate ?? -1) - (a.coverRate ?? -1));
  return results;
}

/**
 * Sweeps pointsPerRestDay -- rest/bye-week advantage as an additive signal
 * in predictSpread (see RatingParams doc). No new ingestion: game_date
 * already exists for every game. Includes negative values in the default
 * grid too, as a sanity check -- if the model is well-specified, a
 * negative pointsPerRestDay (extra rest HURTING the home team) should
 * clearly underperform 0 and the positive values, not come out on top.
 */
const DEFAULT_POINTS_PER_REST_DAY = [-0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.5];

export interface RestDaySweepResult {
  pointsPerRestDay: number;
  runId: number;
  games: number;
  coverRate: number | null;
  avgClv: number | null;
}

export async function runRestDaySweep(
  sport: Sport,
  seasonStart: number,
  seasonEnd: number,
  weightGrid: number[] = DEFAULT_POINTS_PER_REST_DAY,
): Promise<RestDaySweepResult[]> {
  const base = getRatingParams(sport);
  const results: RestDaySweepResult[] = [];

  for (const pointsPerRestDay of weightGrid) {
    const paramsOverride: RatingParams = { ...base, pointsPerRestDay };
    const name = `sweep-restday-${sport}-p${pointsPerRestDay}`;
    const { backtestRunId, scored } = await runBacktest({ name, sport, seasonStart, seasonEnd, paramsOverride });
    const overall = await getOverallReport(backtestRunId);
    results.push({
      pointsPerRestDay,
      runId: backtestRunId,
      games: scored,
      coverRate: overall.coverRate,
      avgClv: overall.avgClv,
    });
    console.log(
      `pointsPerRestDay=${pointsPerRestDay}: ${scored} games, cover=${
        overall.coverRate === null ? "n/a" : (overall.coverRate * 100).toFixed(1) + "%"
      }, avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(2)} (run ${backtestRunId})`,
    );
  }

  results.sort((a, b) => (b.coverRate ?? -1) - (a.coverRate ?? -1));
  return results;
}

/**
 * Sweeps turnoverLuckWeight -- turnover-play PPA stripped out of each
 * side's EPA average via a reweighted mean (see RatingParams doc). Requires
 * the turnover-stats ingestion pass to have run first (cfb-turnover-ingest
 * / syncCfbdTurnoverStats) -- any game missing that data makes
 * turnoverLuckWeight a silent per-field no-op, same as excludeGarbageTime's
 * sweep. Includes 0 as the true raw-EPA baseline for direct comparison.
 */
const DEFAULT_TURNOVER_LUCK_WEIGHT = [0, 0.25, 0.5, 0.75, 1];

export interface TurnoverLuckSweepResult {
  turnoverLuckWeight: number;
  runId: number;
  games: number;
  coverRate: number | null;
  avgClv: number | null;
}

export async function runTurnoverLuckSweep(
  sport: Sport,
  seasonStart: number,
  seasonEnd: number,
  weightGrid: number[] = DEFAULT_TURNOVER_LUCK_WEIGHT,
): Promise<TurnoverLuckSweepResult[]> {
  const base = getRatingParams(sport);
  const results: TurnoverLuckSweepResult[] = [];

  for (const turnoverLuckWeight of weightGrid) {
    const paramsOverride: RatingParams = { ...base, turnoverLuckWeight };
    const name = `sweep-turnoverluck-${sport}-w${turnoverLuckWeight}`;
    const { backtestRunId, scored } = await runBacktest({ name, sport, seasonStart, seasonEnd, paramsOverride });
    const overall = await getOverallReport(backtestRunId);
    results.push({
      turnoverLuckWeight,
      runId: backtestRunId,
      games: scored,
      coverRate: overall.coverRate,
      avgClv: overall.avgClv,
    });
    console.log(
      `turnoverLuckWeight=${turnoverLuckWeight}: ${scored} games, cover=${
        overall.coverRate === null ? "n/a" : (overall.coverRate * 100).toFixed(1) + "%"
      }, avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(2)} (run ${backtestRunId})`,
    );
  }

  results.sort((a, b) => (b.coverRate ?? -1) - (a.coverRate ?? -1));
  return results;
}

/**
 * Sweeps weeklySpSignalPoints -- real week-by-week SP+ as an additive
 * signal (see RatingParams doc). Requires cfb-manual-sp-ingest to have run
 * first. Unlike every other sweep in this file, ALWAYS scoped to 2025 only
 * regardless of the seasonStart/seasonEnd args -- the manual archive this
 * signal depends on only exists for 2025, so any other season is a silent
 * no-op that would just dilute the result with unaffected games. Reports
 * cover vs. OPENING line directly (not just vs. closing) since that's the
 * actual "would this make money" question this signal is being judged on,
 * given there's no 2023-2024 data to walk-forward validate it against.
 */
const DEFAULT_WEEKLY_SP_SIGNAL_POINTS = [0, 0.5, 1, 1.5, 2, 3];

export interface WeeklySpSignalSweepResult {
  weeklySpSignalPoints: number;
  runId: number;
  games: number;
  coverRate: number | null;
  avgClv: number | null;
  openingGames: number;
  coverRateVsOpening: number | null;
}

export async function runWeeklySpSignalSweep(
  sport: Sport,
  weightGrid: number[] = DEFAULT_WEEKLY_SP_SIGNAL_POINTS,
): Promise<WeeklySpSignalSweepResult[]> {
  const base = getRatingParams(sport);
  const results: WeeklySpSignalSweepResult[] = [];

  for (const weeklySpSignalPoints of weightGrid) {
    const paramsOverride: RatingParams = { ...base, weeklySpSignalPoints };
    const name = `sweep-weeklyspsignal-${sport}-w${weeklySpSignalPoints}`;
    const { backtestRunId, scored } = await runBacktest({ name, sport, seasonStart: 2025, seasonEnd: 2025, paramsOverride });
    const overall = await getOverallReport(backtestRunId);
    const opening = await getOpeningCoverRate(backtestRunId);
    results.push({
      weeklySpSignalPoints,
      runId: backtestRunId,
      games: scored,
      coverRate: overall.coverRate,
      avgClv: overall.avgClv,
      openingGames: opening.games,
      coverRateVsOpening: opening.coverRateVsOpening,
    });
    console.log(
      `weeklySpSignalPoints=${weeklySpSignalPoints}: ${scored} games, cover vs close=${
        overall.coverRate === null ? "n/a" : (overall.coverRate * 100).toFixed(1) + "%"
      }, cover vs open=${
        opening.coverRateVsOpening === null ? "n/a" : (opening.coverRateVsOpening * 100).toFixed(1) + "%"
      } (${opening.games} games), avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(2)} (run ${backtestRunId})`,
    );
  }

  results.sort((a, b) => (b.coverRateVsOpening ?? -1) - (a.coverRateVsOpening ?? -1));
  return results;
}
