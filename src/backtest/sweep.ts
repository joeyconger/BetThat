import { getRatingParams } from "../ratings/config.js";
import type { RatingParams } from "../ratings/config.js";
import type { Sport } from "../db/repo.js";
import { runBacktest } from "./run.js";
import { getOverallReport, getConfidenceReport } from "./report.js";

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
