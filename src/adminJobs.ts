import { runBacktest } from "./backtest/run.js";
import { syncCfbdTeams } from "./ingest/cfbd/syncTeams.js";
import { getPlays, getGames, getTeams, getWinProbabilityData, getDrives, getReturningProduction } from "./ingest/cfbd/client.js";
import type { CfbdPlayWinProbability } from "./ingest/cfbd/client.js";
import { syncCfbdGames } from "./ingest/cfbd/syncGames.js";
import { syncCfbdGameStats, syncCfbdGarbageTimeStats } from "./ingest/cfbd/syncStats.js";
import { syncCfbdTurnoverStats } from "./ingest/cfbd/syncTurnoverStats.js";
import { syncCfbdSackRateStats } from "./ingest/cfbd/syncSackRateStats.js";
import { syncCfbdFinishingDrivesStats } from "./ingest/cfbd/syncFinishingDrivesStats.js";
import { syncCfbdSpecialTeamsStats } from "./ingest/cfbd/syncSpecialTeamsStats.js";
import { syncCfbdRawPlays } from "./ingest/cfbd/syncRawPlays.js";
import { syncOpponentAdjustedStats } from "./ingest/cfbd/syncOpponentAdjustedStats.js";
import {
  getPlaysForSeasonThroughWeek,
  getTeamNameToIdMap,
  getGameSourceIdToIdMap,
  getFinishingDrivesGameCoverage,
  getGameParticipantsBySourceId,
  upsertFinishingDrivesStatsDebug,
  debugReadFinishingDrivesRow,
  getBacktestClvRows,
  getBacktestClvByGame,
  getBacktestGameDetails,
  getCombinedGamesPlayedByGame,
  listBacktestRuns,
  getPriorSeasonFinalRating,
  getPriorSeasonSpRating,
  getManualSpWeeklyDistributionForWeek,
  getCfbdSpDistributionForSeason,
  upsertExternalRating,
  getDistinctWeeks,
  getSeasonGamesForRating,
  getReturningProductionDistribution,
  getGameHistoryForSeason,
} from "./db/repo.js";
import type { BacktestRunSummary } from "./db/repo.js";
import { runPlaceboTest } from "./backtest/placebo.js";
import { pairedTTest } from "./stats/significance.js";
import { buildTeamPerformances, buildTeamPerformancesEpa } from "./ratings/gamePerformance.js";
import type { GamePlaysGroup } from "./ratings/gamePerformance.js";
import { computeOpponentAdjustedRatings, identifyLowConnectivityTeams } from "./ratings/opponentAdjust.js";
import type { TeamPerformance, OpponentAdjustedRatings } from "./ratings/opponentAdjust.js";
import { syncManualSpWeekly2025 } from "./ingest/manual/syncManualSpWeekly.js";
import { syncCfbdHistoricalOdds } from "./ingest/cfbd/syncHistoricalOdds.js";
import { syncCfbdSpRatings, syncCfbdEloRatings, syncCfbdReturningProduction } from "./ingest/cfbd/syncExternalRatings.js";
import { syncCfbdHistoricalWeather } from "./ingest/cfbd/syncHistoricalWeather.js";
import { syncNflHistoricalWeather } from "./ingest/weather/syncWeather.js";
import {
  runSweep,
  runExternalRatingsSweep,
  runSosSweep,
  runSpSignalSweep,
  runSuccessRateSweep,
  runGarbageTimeSweep,
  runOpponentAdjustSweep,
  runRestDaySweep,
  runTurnoverLuckSweep,
  runWeeklySpSignalSweep,
  runComponentSweep,
  runComponentSweepWalkforward,
} from "./backtest/sweep.js";
import { runJointRefitHoldout, fitJointComponentWeights } from "./backtest/jointRefit.js";
import type { JointRefitResult } from "./backtest/jointRefit.js";
import type { ComponentParamKey } from "./backtest/sweep.js";
import {
  getOverallReport,
  getOpeningCoverRate,
  getConferenceReport,
  getInOutConferenceReport,
  getWeekBucketReport,
  getHomeRoadBySpreadSizeReport,
  getHomeRoadByDeviationReport,
  getKeyNumberReport,
  getWeatherReport,
  getPrecipitationReport,
  getConfidenceReport,
  getConfidenceReportVsOpening,
} from "./backtest/report.js";
import { getRatingParams } from "./ratings/config.js";
import type { RatingParams } from "./ratings/config.js";
import { computeInitialRating } from "./ratings/elo.js";
import { computeRatings, computeAndStoreRatings, generateBacktestPredictionsForWeek } from "./ratings/service.js";
import type { Sport } from "./db/repo.js";

function fmtPct(value: number | null): string {
  return value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

/**
 * Background job runner for anything too slow to run inside Railway's
 * startCommand — the whole reason this exists is that chaining ingestion
 * before `npm run server` made the deploy's healthcheck time out (~1m40s
 * window) on every multi-season pull, which killed the deploy outright.
 * Triggered on demand via server.ts's POST /admin/jobs/:name instead, so
 * server startup is always fast, and long jobs run after the server (and
 * its healthcheck) are already up. In-memory only — job history resets on
 * redeploy, which is fine: the actual output (backtest_runs rows) persists
 * in Postgres regardless.
 */
export interface JobStatus {
  id: string;
  name: string;
  status: "running" | "done" | "error";
  startedAt: string;
  finishedAt: string | null;
  log: string[];
  error: string | null;
}

const jobs = new Map<string, JobStatus>();

function makeJob(name: string): JobStatus {
  const id = `${name}-${Date.now()}`;
  const job: JobStatus = { id, name, status: "running", startedAt: new Date().toISOString(), finishedAt: null, log: [], error: null };
  jobs.set(id, job);
  return job;
}

function log(job: JobStatus, line: string) {
  job.log.push(`[${new Date().toISOString()}] ${line}`);
}

async function runJob(name: string, fn: (job: JobStatus) => Promise<void>): Promise<JobStatus> {
  const job = makeJob(name);
  fn(job)
    .then(() => {
      job.status = "done";
      job.finishedAt = new Date().toISOString();
      log(job, "done");
    })
    .catch((err: unknown) => {
      job.status = "error";
      job.finishedAt = new Date().toISOString();
      job.error = err instanceof Error ? err.message : String(err);
      log(job, `error: ${job.error}`);
    });
  return job;
}

export function listJobs(): JobStatus[] {
  return [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function getJob(id: string): JobStatus | undefined {
  return jobs.get(id);
}

/** Re-runs the NFL backtest with today's (post-numeric-bug-fix) code. Data is already ingested, so this is fast. */
export function startNflBacktestJob(): Promise<JobStatus> {
  return runJob("nfl-backtest-refresh", async (job) => {
    log(job, "running NFL backtest 2023-2025");
    const summary = await runBacktest({ name: "v2-fixed", sport: "nfl", seasonStart: 2023, seasonEnd: 2025 });
    log(job, `scored ${summary.scored}, skipped ${summary.skippedNoOdds}, run id ${summary.backtestRunId}`);
  });
}

/** Ingests CFB 2023+2024 (2025 already done) then runs the CFB backtest — the slow job that broke deploy healthchecks. */
export function startCfbPipelineJob(): Promise<JobStatus> {
  return runJob("cfb-pipeline", async (job) => {
    for (const year of [2023, 2024]) {
      log(job, `${year}: teams`);
      await syncCfbdTeams(year);
      log(job, `${year}: games`);
      await syncCfbdGames(year);
      log(job, `${year}: stats`);
      await syncCfbdGameStats(year);
      log(job, `${year}: historical odds`);
      await syncCfbdHistoricalOdds(year);
    }
    log(job, "2025: historical odds");
    await syncCfbdHistoricalOdds(2025);

    log(job, "running CFB backtest 2023-2025");
    const summary = await runBacktest({ name: "cfb-v1", sport: "cfb", seasonStart: 2023, seasonEnd: 2025 });
    log(job, `scored ${summary.scored}, skipped ${summary.skippedNoOdds}, run id ${summary.backtestRunId}`);
  });
}

/** 3x3 grid (pointsPerEpa x baseK), 9 full season replays — coarse calibration pass. */
function startSweepJob(sport: Sport, seasonStart: number, seasonEnd: number): Promise<JobStatus> {
  return runJob(`${sport}-sweep`, async (job) => {
    log(job, `sweeping ${sport} ${seasonStart}-${seasonEnd}`);
    const results = await runSweep(sport, seasonStart, seasonEnd);
    for (const r of results) {
      const cover = r.coverRate === null ? "n/a" : `${(r.coverRate * 100).toFixed(1)}%`;
      const clv = r.avgClv === null ? "n/a" : r.avgClv.toFixed(2);
      log(job, `pointsPerEpa=${r.pointsPerEpa} baseK=${r.baseK}: ${r.games} games, cover=${cover}, avgClv=${clv} (run ${r.runId})`);
    }
  });
}

export function startNflSweepJob(): Promise<JobStatus> {
  return startSweepJob("nfl", 2023, 2025);
}

export function startCfbSweepJob(): Promise<JobStatus> {
  return startSweepJob("cfb", 2023, 2025);
}

/**
 * Ingests CFBD's SP+ (season-final, used as next season's rating prior) and
 * weekly Elo (in-season z-score signal), then re-runs the CFB backtest with
 * that data — see ratings/elo.ts's computeInitialRating/predictSpread and
 * README "External ratings" for what these feed into. Separate from
 * cfb-pipeline since teams/games/stats/odds are already ingested; this only
 * needs to add the two new external_ratings sources on top.
 */
export function startCfbExternalRatingsJob(): Promise<JobStatus> {
  return runJob("cfb-external-ratings", async (job) => {
    for (const year of [2022, 2023, 2024]) {
      log(job, `${year}: SP+ ratings`);
      const sp = await syncCfbdSpRatings(year);
      log(job, `${year}: SP+ synced ${sp.synced}, skipped ${sp.skipped}`);
    }
    for (const year of [2023, 2024, 2025]) {
      log(job, `${year}: weekly Elo ratings`);
      const elo = await syncCfbdEloRatings(year);
      log(job, `${year}: Elo synced ${elo.synced}, skipped ${elo.skipped}`);
    }

    log(job, "running CFB backtest 2023-2025 with external ratings");
    const summary = await runBacktest({ name: "cfb-v2-external-ratings", sport: "cfb", seasonStart: 2023, seasonEnd: 2025 });
    log(job, `scored ${summary.scored}, skipped ${summary.skippedNoOdds}, run id ${summary.backtestRunId}`);
  });
}

/**
 * Ingests CFBD returning-production percentPPA for CFB 2023-2025 (each
 * season's OWN year, not season-1 -- see syncCfbdReturningProduction's
 * doc). Requires cfb-verify-returning-production to have already come back
 * clean per docs/prompts/returning-production-seed-adjustment.md's Step 1.
 * Run this before any cfb-returning-production-sweep -- without it,
 * RatingParams.returningProductionPoints is a silent per-team no-op (every
 * team falls back to computeInitialRating's existing carryover/SP+ blend
 * unchanged, per that function's "missing data" guard).
 */
export function startCfbReturningProductionIngestJob(): Promise<JobStatus> {
  return runJob("cfb-returning-production-ingest", async (job) => {
    for (const year of [2023, 2024, 2025]) {
      log(job, `${year}: returning production`);
      const result = await syncCfbdReturningProduction(year);
      log(job, `${year}: synced ${result.synced}, skipped ${result.skipped}`);
    }
  });
}

/**
 * Grids spPriorWeight x eloSignalPoints (25 combos) with pointsPerEpa=20,
 * baseK=0.25 held fixed — the best cover-rate combo from the post-SOS-fix
 * cfb-sweep run. Requires cfb-external-ratings to have run first (needs
 * external_ratings data present).
 */
export function startCfbExternalSweepJob(): Promise<JobStatus> {
  return runJob("cfb-external-sweep", async (job) => {
    log(job, "sweeping cfb spPriorWeight x eloSignalPoints, 2023-2025");
    const results = await runExternalRatingsSweep("cfb", 2023, 2025, 20, 0.25);
    for (const r of results) {
      const cover = r.coverRate === null ? "n/a" : `${(r.coverRate * 100).toFixed(1)}%`;
      const clv = r.avgClv === null ? "n/a" : r.avgClv.toFixed(2);
      log(job, `spPriorWeight=${r.spPriorWeight} eloSignalPoints=${r.eloSignalPoints}: ${r.games} games, cover=${cover}, avgClv=${clv} (run ${r.runId})`);
    }
  });
}

/**
 * Walk-forward validation: calibrates spPriorWeight/eloSignalPoints using
 * ONLY 2023-2024 (the same grid as cfb-external-sweep), then tests that
 * winning combo on 2025 alone — data the calibration never saw. Answers
 * "is the edge real, or did we just tune spPriorWeight/eloSignalPoints to
 * fit noise in the exact 2023-2025 sample we're also evaluating on."
 * Reports both cover rate vs. closing line and vs. opening line for the
 * 2025 holdout — the opening-line number is the one that actually answers
 * "would this have been profitable" (see README "Backtest results").
 */
export function startCfbWalkforwardJob(): Promise<JobStatus> {
  return runJob("cfb-walkforward", async (job) => {
    log(job, "training: sweeping spPriorWeight x eloSignalPoints on 2023-2024 only");
    const trainResults = await runExternalRatingsSweep("cfb", 2023, 2024, 20, 0.25);
    for (const r of trainResults) {
      log(job, `train: spPriorWeight=${r.spPriorWeight} eloSignalPoints=${r.eloSignalPoints}: cover=${fmtPct(r.coverRate)} (run ${r.runId})`);
    }
    const best = trainResults[0]!; // runExternalRatingsSweep sorts desc by coverRate
    log(job, `best training combo: spPriorWeight=${best.spPriorWeight} eloSignalPoints=${best.eloSignalPoints} (train cover ${fmtPct(best.coverRate)})`);

    log(job, "holdout: running 2025-only backtest with training-selected params");
    const base = getRatingParams("cfb");
    const paramsOverride = {
      ...base,
      pointsPerEpa: 20,
      baseK: 0.25,
      spPriorWeight: best.spPriorWeight,
      eloSignalPoints: best.eloSignalPoints,
    };
    const holdout = await runBacktest({
      name: "cfb-walkforward-holdout-2025",
      sport: "cfb",
      seasonStart: 2025,
      seasonEnd: 2025,
      paramsOverride,
    });
    const overall = await getOverallReport(holdout.backtestRunId);
    const openingCover = await getOpeningCoverRate(holdout.backtestRunId);
    log(
      job,
      `holdout 2025: ${holdout.scored} games, cover vs close=${fmtPct(overall.coverRate)}, ` +
        `cover vs open=${fmtPct(openingCover.coverRateVsOpening)} (${openingCover.games} games w/ opening line), ` +
        `avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(2)} (run ${holdout.backtestRunId})`,
    );
  });
}

/**
 * Same walk-forward validation as startCfbWalkforwardJob, but with week 14+
 * (rivalry week / conference championships — see cfb-no-rivalry-week's doc)
 * excluded from BOTH the training sweep and the 2025 holdout. Answers the
 * question cfb-no-rivalry-week's in-sample result couldn't: does excluding
 * that segment actually generalize, or was the improvement just an artifact
 * of removing a chunk we identified by looking at this same 2023-2025 pool
 * in the first place (near-circular, not independent evidence).
 */
export function startCfbWalkforwardNoRivalryJob(): Promise<JobStatus> {
  return runJob("cfb-walkforward-no-rivalry", async (job) => {
    log(job, "training: sweeping spPriorWeight x eloSignalPoints on 2023-2024 only, excluding week 14+");
    const trainResults = await runExternalRatingsSweep("cfb", 2023, 2024, 20, 0.25, undefined, undefined, 14);
    for (const r of trainResults) {
      log(job, `train: spPriorWeight=${r.spPriorWeight} eloSignalPoints=${r.eloSignalPoints}: cover=${fmtPct(r.coverRate)} (run ${r.runId})`);
    }
    const best = trainResults[0]!;
    log(job, `best training combo: spPriorWeight=${best.spPriorWeight} eloSignalPoints=${best.eloSignalPoints} (train cover ${fmtPct(best.coverRate)})`);

    log(job, "holdout: running 2025-only backtest with training-selected params, excluding week 14+");
    const base = getRatingParams("cfb");
    const paramsOverride = {
      ...base,
      pointsPerEpa: 20,
      baseK: 0.25,
      spPriorWeight: best.spPriorWeight,
      eloSignalPoints: best.eloSignalPoints,
    };
    const holdout = await runBacktest({
      name: "cfb-walkforward-holdout-2025-no-rivalry",
      sport: "cfb",
      seasonStart: 2025,
      seasonEnd: 2025,
      paramsOverride,
      excludeFromWeek: 14,
    });
    const overall = await getOverallReport(holdout.backtestRunId);
    const openingCover = await getOpeningCoverRate(holdout.backtestRunId);
    log(
      job,
      `holdout 2025 (no rivalry week): ${holdout.scored} games, cover vs close=${fmtPct(overall.coverRate)}, ` +
        `cover vs open=${fmtPct(openingCover.coverRateVsOpening)} (${openingCover.games} games w/ opening line), ` +
        `avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(2)} (run ${holdout.backtestRunId})`,
    );
    log(job, "compare against original cfb-walkforward holdout (all weeks): cover vs close=47.1%, cover vs open=50.0%, avgClv=0.76");
  });
}

/**
 * Segment breakdowns (conference of the pick, in-vs-out-of-conference,
 * early-season week buckets, home/road crossed with spread size and with
 * model-deviation size) against a fresh CFB backtest using today's
 * validated defaults (spPriorWeight=0, eloSignalPoints=1.5, pointsPerEpa=20
 * — see README "Rating model / A real bug"). CFB only — conference
 * structure doesn't map meaningfully onto NFL's four-team divisions.
 *
 * Important: this runs on the FULL 2023-2025 sample, not train/holdout
 * split — the walk-forward job already showed a promising-looking number
 * can evaporate out-of-sample. Treat any standout segment here as a
 * hypothesis worth a dedicated holdout test, not a confirmed edge, same
 * caveat as getConferenceReport's own doc comment.
 */
export function startCfbSegmentsJob(): Promise<JobStatus> {
  return runJob("cfb-segments", async (job) => {
    log(job, "running fresh CFB backtest 2023-2025 with validated defaults");
    const summary = await runBacktest({ name: "cfb-segments-baseline", sport: "cfb", seasonStart: 2023, seasonEnd: 2025 });
    const runId = summary.backtestRunId;
    log(job, `scored ${summary.scored}, skipped ${summary.skippedNoOdds}, run id ${runId}`);

    const overall = await getOverallReport(runId);
    const openingCover = await getOpeningCoverRate(runId);
    log(
      job,
      `overall: cover vs close=${fmtPct(overall.coverRate)}, cover vs open=${fmtPct(openingCover.coverRateVsOpening)} ` +
        `(${openingCover.games} games w/ opening line), avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(2)}`,
    );

    log(job, "--- by conference of the picked team ---");
    for (const r of await getConferenceReport(runId)) {
      log(job, `${r.conference}: ${r.games} games, cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)}`);
    }

    log(job, "--- in-conference vs out-of-conference ---");
    for (const r of await getInOutConferenceReport(runId)) {
      log(job, `${r.matchupType}: ${r.games} games, cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)}`);
    }

    log(job, "--- by week bucket ---");
    for (const r of await getWeekBucketReport(runId)) {
      log(job, `${r.weekBucket}: ${r.games} games, cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)}`);
    }

    log(job, "--- home/road x spread size (game's own closing spread) ---");
    for (const r of await getHomeRoadBySpreadSizeReport(runId)) {
      log(job, `pick=${r.pickSide} spread=${r.sizeBucket}: ${r.games} games, cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)}`);
    }

    log(job, "--- home/road x model deviation size ---");
    for (const r of await getHomeRoadByDeviationReport(runId)) {
      log(job, `pick=${r.pickSide} deviation=${r.sizeBucket}: ${r.games} games, cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)}`);
    }
  });
}

/**
 * Sweeps sosWeight (see backtest/sweep.ts's runSosSweep doc) — the SOS
 * strength knob, set "per spec" at project start and never actually
 * tested against a backtest until now. Includes sosWeight=0 to check
 * whether SOS adjustment helps at all versus doing nothing.
 */
export function startCfbSosSweepJob(): Promise<JobStatus> {
  return runJob("cfb-sos-sweep", async (job) => {
    log(job, "sweeping cfb sosWeight, 2023-2025");
    const results = await runSosSweep("cfb", 2023, 2025);
    for (const r of results) {
      log(job, `sosWeight=${r.sosWeight}: ${r.games} games, cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)} (run ${r.runId})`);
    }
  });
}

/**
 * Sweeps spSignalPoints (see backtest/sweep.ts's runSpSignalSweep doc) —
 * the additive, every-week SP+ signal, a deliberately different mechanism
 * from spPriorWeight (which a real sweep already found hurt cover rate
 * once weighted above ~0.3 as a one-time carryover blend). Requires
 * cfb-external-ratings to have run first (needs external_ratings SP+ data
 * present for the prior season).
 */
export function startCfbSpSignalSweepJob(): Promise<JobStatus> {
  return runJob("cfb-spsignal-sweep", async (job) => {
    log(job, "sweeping cfb spSignalPoints, 2023-2025");
    const results = await runSpSignalSweep("cfb", 2023, 2025);
    for (const r of results) {
      log(job, `spSignalPoints=${r.spSignalPoints}: ${r.games} games, cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)} (run ${r.runId})`);
    }
  });
}

/**
 * Sweeps successRateWeight x pointsPerSuccessRate (see backtest/sweep.ts's
 * runSuccessRateSweep doc) — the "how the game went vs. the result"
 * hypothesis: blending success rate (lower-variance, execution-focused)
 * alongside EPA (closer to the result, dominated by a few explosive or
 * garbage-time plays) into the rating engine's per-game performance
 * signal. weight=0 in the grid is the current pure-EPA baseline.
 */
export function startCfbSuccessRateSweepJob(): Promise<JobStatus> {
  return runJob("cfb-successrate-sweep", async (job) => {
    log(job, "sweeping cfb successRateWeight x pointsPerSuccessRate, 2023-2025");
    const results = await runSuccessRateSweep("cfb", 2023, 2025);
    for (const r of results) {
      log(job, `successRateWeight=${r.successRateWeight} pointsPerSuccessRate=${r.pointsPerSuccessRate}: ${r.games} games, cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)} (run ${r.runId})`);
    }
  });
}

/**
 * Walk-forward validation for the success-rate blend, same discipline as
 * startCfbWalkforwardJob: pick the best successRateWeight/
 * pointsPerSuccessRate combo by training ONLY on 2023-2024, then score that
 * exact combo on 2025 alone — data the training sweep never saw. The full
 * 2023-2025 sweep (cfb-successrate-sweep) found successRateWeight=0.75-1.0
 * with pointsPerSuccessRate=90-120 beating the EPA-only baseline (49.9% ->
 * 50.5% cover), but that shift is inside one standard error at ~2268 games
 * (SE~1.05pp) and the grid wasn't picked out-of-sample — this is the actual
 * test of whether it's signal or noise, not the in-sample sweep itself.
 */
export function startCfbSuccessRateWalkforwardJob(): Promise<JobStatus> {
  return runJob("cfb-successrate-walkforward", async (job) => {
    log(job, "training: sweeping successRateWeight x pointsPerSuccessRate on 2023-2024 only");
    const trainResults = await runSuccessRateSweep("cfb", 2023, 2024);
    for (const r of trainResults) {
      log(job, `train: successRateWeight=${r.successRateWeight} pointsPerSuccessRate=${r.pointsPerSuccessRate}: cover=${fmtPct(r.coverRate)} (run ${r.runId})`);
    }
    const best = trainResults[0]!; // runSuccessRateSweep sorts desc by coverRate
    log(job, `best training combo: successRateWeight=${best.successRateWeight} pointsPerSuccessRate=${best.pointsPerSuccessRate} (train cover ${fmtPct(best.coverRate)})`);

    log(job, "holdout: running 2025-only backtest with training-selected params");
    const base = getRatingParams("cfb");
    const paramsOverride = {
      ...base,
      successRateWeight: best.successRateWeight,
      pointsPerSuccessRate: best.pointsPerSuccessRate,
    };
    const holdout = await runBacktest({
      name: "cfb-successrate-walkforward-holdout-2025",
      sport: "cfb",
      seasonStart: 2025,
      seasonEnd: 2025,
      paramsOverride,
    });
    const overall = await getOverallReport(holdout.backtestRunId);
    const openingCover = await getOpeningCoverRate(holdout.backtestRunId);
    log(
      job,
      `holdout 2025: ${holdout.scored} games, cover vs close=${fmtPct(overall.coverRate)}, ` +
        `cover vs open=${fmtPct(openingCover.coverRateVsOpening)} (${openingCover.games} games w/ opening line), ` +
        `avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(2)} (run ${holdout.backtestRunId})`,
    );
    log(job, "compare against EPA-only baseline (successRateWeight=0) 2025 holdout for context -- see cfb-walkforward's holdout run for the equivalent number without this blend.");
  });
}

/**
 * Ingests garbage-time-excluded EPA/success rate for CFB 2023-2025 via a
 * second CFBD call (excludeGarbageTime=true) against the same endpoint
 * already in use for the all-plays stats -- see syncCfbdGarbageTimeStats's
 * doc. Run this BEFORE cfb-garbagetime-sweep or cfb-garbagetime-
 * walkforward; without it, RatingParams.excludeGarbageTime=true is a
 * silent no-op (every game falls back to its all-plays value).
 */
export function startCfbGarbageTimeIngestJob(): Promise<JobStatus> {
  return runJob("cfb-garbage-time-ingest", async (job) => {
    for (const year of [2023, 2024, 2025]) {
      log(job, `${year}: garbage-time-excluded stats`);
      const result = await syncCfbdGarbageTimeStats(year);
      log(job, `${year}: synced ${result.synced}, skipped ${result.skipped}`);
    }
  });
}

/**
 * A/B: excludeGarbageTime false vs. true, on top of today's CFB defaults
 * (which already include successRateWeight=0.75/pointsPerSuccessRate=120
 * -- see ratings/config.ts). Requires cfb-garbage-time-ingest to have run
 * first.
 */
export function startCfbGarbageTimeSweepJob(): Promise<JobStatus> {
  return runJob("cfb-garbagetime-sweep", async (job) => {
    log(job, "sweeping cfb excludeGarbageTime false vs true, 2023-2025");
    const results = await runGarbageTimeSweep("cfb", 2023, 2025);
    for (const r of results) {
      log(job, `excludeGarbageTime=${r.excludeGarbageTime}: ${r.games} games, cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)} (run ${r.runId})`);
    }
  });
}

/**
 * Walk-forward validation for excludeGarbageTime, same discipline as
 * cfb-successrate-walkforward: train (the false-vs-true A/B) on 2023-2024
 * only, then score the winner on the untouched 2025 season. With only two
 * candidates there's less multiple-comparison risk than the successRate
 * grid had, but the same in-sample-vs-holdout question still applies.
 * Requires cfb-garbage-time-ingest to have run first.
 */
export function startCfbGarbageTimeWalkforwardJob(): Promise<JobStatus> {
  return runJob("cfb-garbagetime-walkforward", async (job) => {
    log(job, "training: excludeGarbageTime false vs true on 2023-2024 only");
    const trainResults = await runGarbageTimeSweep("cfb", 2023, 2024);
    for (const r of trainResults) {
      log(job, `train: excludeGarbageTime=${r.excludeGarbageTime}: cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)} (run ${r.runId})`);
    }
    const best = trainResults.reduce((a, b) => ((b.coverRate ?? -1) > (a.coverRate ?? -1) ? b : a));
    log(job, `best training option: excludeGarbageTime=${best.excludeGarbageTime} (train cover ${fmtPct(best.coverRate)})`);

    log(job, "holdout: running 2025-only backtest with training-selected option");
    const base = getRatingParams("cfb");
    const paramsOverride = { ...base, excludeGarbageTime: best.excludeGarbageTime };
    const holdout = await runBacktest({
      name: "cfb-garbagetime-walkforward-holdout-2025",
      sport: "cfb",
      seasonStart: 2025,
      seasonEnd: 2025,
      paramsOverride,
    });
    const overall = await getOverallReport(holdout.backtestRunId);
    const openingCover = await getOpeningCoverRate(holdout.backtestRunId);
    log(
      job,
      `holdout 2025: ${holdout.scored} games, cover vs close=${fmtPct(overall.coverRate)}, ` +
        `cover vs open=${fmtPct(openingCover.coverRateVsOpening)} (${openingCover.games} games w/ opening line), ` +
        `avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(2)} (run ${holdout.backtestRunId})`,
    );
    log(job, "compare against cfb-successrate-walkforward's holdout for the equivalent number without this toggle: cover vs close=48.7%, cover vs open=50.7%, avgClv=0.87.");
  });
}

/**
 * The reference comparison at the end of cfb-garbagetime-walkforward's log
 * is a hardcoded number from cfb-successrate-walkforward's holdout -- a
 * run from BEFORE Part 1's market-anchor removal, under a different
 * prediction path entirely. Not a valid apples-to-apples A/B for whether
 * excludeGarbageTime helps under the CURRENT (unanchored) model. This
 * runs both excludeGarbageTime settings on the SAME 2025-only holdout,
 * current CFB defaults otherwise, and a proper paired significance test
 * on identical games -- the real comparison, replacing reliance on that
 * stale reference line. Motivated by a real ODU case (see chat): the
 * model rated them a plausible top-20-ish team in week 12 largely off
 * blowout wins over already-known-bad Sun Belt teams (Troy, Georgia
 * Southern), and pulling the actual team_game_stats for those games
 * showed the EPA/success-rate-implied margin running moderately hotter
 * than the real scoreboard margin in both -- consistent with garbage-time
 * inflation, though not enough on its own to explain the full rating
 * jump (the other additive components -- explosiveness, downs splits,
 * sack rate, etc. -- account for the rest).
 */
export function startCfbGarbageTimeHoldoutPairedTestJob(): Promise<JobStatus> {
  return runJob("cfb-garbagetime-holdout-paired-test", async (job) => {
    log(job, "excludeGarbageTime false vs true, 2025-only holdout, current CFB defaults otherwise -- the real apples-to-apples comparison under the unanchored model.");
    const results = await runGarbageTimeSweep("cfb", 2025, 2025);
    for (const r of results) {
      log(job, `excludeGarbageTime=${r.excludeGarbageTime}: ${r.games} games, cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(3)} (run ${r.runId})`);
    }
    const baseline = results.find((r) => !r.excludeGarbageTime);
    const variant = results.find((r) => r.excludeGarbageTime);
    if (!baseline || !variant) {
      log(job, "expected both excludeGarbageTime=false and =true runs -- missing one, can't pair.");
      return;
    }
    const baselineDetails = await getBacktestGameDetails(baseline.runId);
    const variantDetails = await getBacktestGameDetails(variant.runId);
    const commonGameIds = [...baselineDetails.keys()].filter((id) => variantDetails.has(id));
    log(job, `${commonGameIds.length} identical games between the two runs.`);

    const clvGameIds = commonGameIds.filter(
      (id) => baselineDetails.get(id)!.clv !== null && variantDetails.get(id)!.clv !== null,
    );
    if (clvGameIds.length >= 2) {
      const baseClv = clvGameIds.map((id) => baselineDetails.get(id)!.clv!);
      const varClv = clvGameIds.map((id) => variantDetails.get(id)!.clv!);
      const paired = pairedTTest(baseClv, varClv);
      log(
        job,
        `CLV (excludeGarbageTime=true - false) on ${paired.n} games: mean diff=${paired.meanDiff.toFixed(4)}, t=${paired.tStatistic.toFixed(3)}, p=${paired.pValueTwoSided.toFixed(4)} -- ${
          paired.pValueTwoSided < 0.05 ? "statistically significant at p<0.05." : "NOT statistically significant."
        }`,
      );
    }
    const coveredGameIds = commonGameIds.filter(
      (id) => baselineDetails.get(id)!.covered !== null && variantDetails.get(id)!.covered !== null,
    );
    if (coveredGameIds.length >= 2) {
      const baseCovered = coveredGameIds.map((id) => (baselineDetails.get(id)!.covered ? 1 : 0));
      const varCovered = coveredGameIds.map((id) => (variantDetails.get(id)!.covered ? 1 : 0));
      const paired = pairedTTest(baseCovered, varCovered);
      log(
        job,
        `covered-as-0/1 (excludeGarbageTime=true - false) on ${paired.n} games: mean diff=${paired.meanDiff.toFixed(4)}, t=${paired.tStatistic.toFixed(3)}, p=${paired.pValueTwoSided.toFixed(4)} -- ${
          paired.pValueTwoSided < 0.05 ? "statistically significant at p<0.05." : "NOT statistically significant."
        }`,
      );
    }
    log(
      job,
      "Note: this holdout is small (2025 only, ~700-something games), and the underlying no-garbage data itself has a real coverage gap (~50% of games skipped at ingestion, silently falling back to all-plays EPA for those) -- a null result here doesn't rule out a real effect the data can't see yet, and a positive one still wants the full 2023-2025 in-sample sweep's significance checked too before trusting it.",
    );
  });
}

/**
 * Per-game rating-delta diagnostic for one team/season -- for every game,
 * the team's rating immediately before and after, the delta, and the
 * OPPONENT's rating at that same pre-game point. Tells you directly
 * whether a big delta came from an oversized margin against an already-
 * correctly-rated opponent (points toward errorCapPoints-style margin
 * dampening), or from the model not having registered the opponent as
 * weak yet (points toward opponent-adjustment actually mattering,
 * contrary to the CLV sweep). If one single game accounts for most of a
 * season's net movement, that's the answer in one row, not an aggregate
 * pattern -- see the ODU case (README's "Rating-sensibility fix" section)
 * for the first real use of this.
 *
 * Deliberately uses computeRatings (read-only, elo.ts/service.ts) instead
 * of querying the team_ratings table directly -- team_ratings is a
 * SHARED, MUTABLE table every backtest run upserts into for whatever
 * season it touches, so a direct query can reflect whichever sweep ran
 * last rather than the actual current default config (see
 * cfb-recompute-ratings' doc for why this matters for the live UI too).
 * computeRatings recomputes from the real current defaults on demand, so
 * it can't be contaminated this way.
 */
async function logTeamRatingDeltas(
  job: JobStatus,
  sport: Sport,
  season: number,
  teamName: string,
  uncappedComparison = false,
): Promise<void> {
  const teamNameToId = await getTeamNameToIdMap(sport);
  const teamId = teamNameToId.get(teamName);
  if (!teamId) {
    log(job, `"${teamName}" not found in teams table.`);
    return;
  }

  const games = await getGameHistoryForSeason(sport, season);
  const teamGames = games
    .filter((g) => (g.homeTeam === teamName || g.awayTeam === teamName) && g.status === "final")
    .sort((a, b) => a.week - b.week);

  const uncappedParams = uncappedComparison ? { ...getRatingParams(sport), errorCapPoints: 0 } : undefined;
  log(
    job,
    `${teamName} ${season}: recomputing ratings before/after each game via computeRatings (default params, no persistence) -- ${teamGames.length} completed games.` +
      (uncappedComparison ? " Also showing the uncapped (errorCapPoints=0) delta for comparison." : ""),
  );
  log(
    job,
    "week  opponent             result        team_before  team_after  delta" +
      (uncappedComparison ? "    raw_delta" : "") +
      "    opp_before",
  );

  for (const g of teamGames) {
    const isHome = g.homeTeam === teamName;
    const opponentName = isHome ? g.awayTeam : g.homeTeam;
    const opponentId = teamNameToId.get(opponentName);
    const teamScore = isHome ? g.homeScore : g.awayScore;
    const oppScore = isHome ? g.awayScore : g.homeScore;
    const resultStr = teamScore !== null && oppScore !== null ? `${teamScore}-${oppScore}` : "?-?";

    const before = await computeRatings(sport, season, g.week - 1);
    const after = await computeRatings(sport, season, g.week);
    const teamBefore = before.get(teamId)?.rating;
    const teamAfter = after.get(teamId)?.rating;
    const oppBefore = opponentId ? before.get(opponentId)?.rating : undefined;
    const delta = teamBefore !== undefined && teamAfter !== undefined ? teamAfter - teamBefore : undefined;

    let rawDelta: number | undefined;
    if (uncappedParams) {
      // Both sides of this delta use uncappedParams (not teamBefore/teamAfter
      // above, which are the capped run) so the raw delta reflects only this
      // one game's error in an uncapped world, isolated from cumulative drift
      // the uncapped setting would also cause in every prior game.
      const rawBefore = await computeRatings(sport, season, g.week - 1, uncappedParams);
      const rawAfter = await computeRatings(sport, season, g.week, uncappedParams);
      const teamRawBefore = rawBefore.get(teamId)?.rating;
      const teamRawAfter = rawAfter.get(teamId)?.rating;
      rawDelta = teamRawBefore !== undefined && teamRawAfter !== undefined ? teamRawAfter - teamRawBefore : undefined;
    }

    log(
      job,
      [
        String(g.week).padEnd(5),
        opponentName.padEnd(20).slice(0, 20),
        resultStr.padEnd(13),
        (teamBefore === undefined ? "n/a" : teamBefore.toFixed(2)).padStart(11),
        (teamAfter === undefined ? "n/a" : teamAfter.toFixed(2)).padStart(10),
        (delta === undefined ? "n/a" : (delta >= 0 ? "+" : "") + delta.toFixed(2)).padStart(8),
        ...(uncappedParams
          ? [(rawDelta === undefined ? "n/a" : (rawDelta >= 0 ? "+" : "") + rawDelta.toFixed(2)).padStart(9)]
          : []),
        oppBefore === undefined ? "n/a" : oppBefore.toFixed(2),
      ].join("  "),
    );
  }
}

/** Hardcoded to Old Dominion / CFB / 2025 -- the original ODU face-validity investigation. See logTeamRatingDeltas' doc. */
export function startCfbTeamRatingDeltaDiagnosticJob(): Promise<JobStatus> {
  return runJob("cfb-team-rating-delta-diagnostic", (job) => logTeamRatingDeltas(job, "cfb", 2025, "Old Dominion"));
}

/**
 * Same diagnostic for Penn State / CFB / 2025 week 14 -- flagged as a
 * second face-validity case (6-6 record showing up rated 10th) right
 * after errorCapPoints=35 was adopted and re-persisted. Worth checking
 * whether this is the same single-outlier-blowout pattern ODU showed
 * (in which case the cap should already be helping, and this is asking
 * whether it needs to go further) or a different mechanism entirely.
 */
export function startCfbPennStateRatingDeltaDiagnosticJob(): Promise<JobStatus> {
  return runJob("cfb-pennstate-rating-delta-diagnostic", (job) => logTeamRatingDeltas(job, "cfb", 2025, "Penn State"));
}

/**
 * Same diagnostic for Clemson / CFB / 2025 -- second example cited
 * alongside Penn State of a team with bad losses to weak opponents whose
 * rating still looks propped up by close losses to good opponents. This
 * is a different complaint from errorCapPoints (which caps a single
 * game's surprise in isolation): the ask is cross-game -- a team's bad
 * losses should discount how much credit ITS OWN close losses to good
 * teams get elsewhere in the season. Need the full, chronological game
 * list (not just the capped rows) to see whether the bad losses land
 * before or after the good near-misses -- that determines whether a
 * sequential single-pass discount can even work without a second pass.
 */
export function startCfbClemsonRatingDeltaDiagnosticJob(): Promise<JobStatus> {
  return runJob("cfb-clemson-rating-delta-diagnostic", (job) => logTeamRatingDeltas(job, "cfb", 2025, "Clemson", true));
}

/**
 * Sweeps opponentAdjustWeight -- opponent-adjusted success rate (see
 * backtest/sweep.ts's runOpponentAdjustSweep and RatingParams doc). No
 * ingestion job needed first: unlike excludeGarbageTime, this only
 * reinterprets success rate already ingested for every 2023-2025 game.
 */
export function startCfbOpponentAdjustSweepJob(): Promise<JobStatus> {
  return runJob("cfb-oppadjust-sweep", async (job) => {
    log(job, "sweeping cfb opponentAdjustWeight, 2023-2025");
    const results = await runOpponentAdjustSweep("cfb", 2023, 2025);
    for (const r of results) {
      log(job, `opponentAdjustWeight=${r.opponentAdjustWeight}: ${r.games} games, cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)} (run ${r.runId})`);
    }
  });
}

/**
 * Walk-forward validation for opponentAdjustWeight, same discipline as
 * every other rating-param change tonight: train (sweep) on 2023-2024
 * only, then score the winning weight on the untouched 2025 season.
 */
export function startCfbOpponentAdjustWalkforwardJob(): Promise<JobStatus> {
  return runJob("cfb-oppadjust-walkforward", async (job) => {
    log(job, "training: sweeping opponentAdjustWeight on 2023-2024 only");
    const trainResults = await runOpponentAdjustSweep("cfb", 2023, 2024);
    for (const r of trainResults) {
      log(job, `train: opponentAdjustWeight=${r.opponentAdjustWeight}: cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)} (run ${r.runId})`);
    }
    const best = trainResults[0]!; // runOpponentAdjustSweep sorts desc by coverRate
    log(job, `best training weight: opponentAdjustWeight=${best.opponentAdjustWeight} (train cover ${fmtPct(best.coverRate)})`);

    log(job, "holdout: running 2025-only backtest with training-selected weight");
    const base = getRatingParams("cfb");
    const paramsOverride = { ...base, opponentAdjustWeight: best.opponentAdjustWeight };
    const holdout = await runBacktest({
      name: "cfb-oppadjust-walkforward-holdout-2025",
      sport: "cfb",
      seasonStart: 2025,
      seasonEnd: 2025,
      paramsOverride,
    });
    const overall = await getOverallReport(holdout.backtestRunId);
    const openingCover = await getOpeningCoverRate(holdout.backtestRunId);
    log(
      job,
      `holdout 2025: ${holdout.scored} games, cover vs close=${fmtPct(overall.coverRate)}, ` +
        `cover vs open=${fmtPct(openingCover.coverRateVsOpening)} (${openingCover.games} games w/ opening line), ` +
        `avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(2)} (run ${holdout.backtestRunId})`,
    );
    log(job, "compare against cfb-successrate-walkforward's holdout for the equivalent number without this adjustment: cover vs close=48.7%, cover vs open=50.7%, avgClv=0.87.");
  });
}

/**
 * Sweeps pointsPerRestDay -- rest/bye-week advantage (see
 * backtest/sweep.ts's runRestDaySweep and RatingParams doc). No ingestion
 * job needed first: game_date already exists for every game.
 */
export function startCfbRestDaySweepJob(): Promise<JobStatus> {
  return runJob("cfb-restday-sweep", async (job) => {
    log(job, "sweeping cfb pointsPerRestDay, 2023-2025");
    const results = await runRestDaySweep("cfb", 2023, 2025);
    for (const r of results) {
      log(job, `pointsPerRestDay=${r.pointsPerRestDay}: ${r.games} games, cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)} (run ${r.runId})`);
    }
  });
}

/**
 * Walk-forward validation for pointsPerRestDay, same discipline as every
 * other rating-param change tonight: train (sweep) on 2023-2024 only, then
 * score the winning value on the untouched 2025 season.
 */
export function startCfbRestDayWalkforwardJob(): Promise<JobStatus> {
  return runJob("cfb-restday-walkforward", async (job) => {
    log(job, "training: sweeping pointsPerRestDay on 2023-2024 only");
    const trainResults = await runRestDaySweep("cfb", 2023, 2024);
    for (const r of trainResults) {
      log(job, `train: pointsPerRestDay=${r.pointsPerRestDay}: cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)} (run ${r.runId})`);
    }
    const best = trainResults[0]!; // runRestDaySweep sorts desc by coverRate
    log(job, `best training value: pointsPerRestDay=${best.pointsPerRestDay} (train cover ${fmtPct(best.coverRate)})`);

    log(job, "holdout: running 2025-only backtest with training-selected value");
    const base = getRatingParams("cfb");
    const paramsOverride = { ...base, pointsPerRestDay: best.pointsPerRestDay };
    const holdout = await runBacktest({
      name: "cfb-restday-walkforward-holdout-2025",
      sport: "cfb",
      seasonStart: 2025,
      seasonEnd: 2025,
      paramsOverride,
    });
    const overall = await getOverallReport(holdout.backtestRunId);
    const openingCover = await getOpeningCoverRate(holdout.backtestRunId);
    log(
      job,
      `holdout 2025: ${holdout.scored} games, cover vs close=${fmtPct(overall.coverRate)}, ` +
        `cover vs open=${fmtPct(openingCover.coverRateVsOpening)} (${openingCover.games} games w/ opening line), ` +
        `avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(2)} (run ${holdout.backtestRunId})`,
    );
    log(job, "compare against cfb-successrate-walkforward's holdout for the equivalent number without this signal: cover vs close=48.7%, cover vs open=50.7%, avgClv=0.87.");
  });
}

/**
 * Ingests the manually-provided real week-by-week SP+ archive for CFB
 * 2025 (weeks 1-15) -- see ingest/manual/syncManualSpWeekly.ts. Not a live
 * API pull, unlike every other ingestion job here: reads a JSON file
 * checked into the repo, built from a spreadsheet the user supplied,
 * since CFBD's own /ratings/sp confirmed (via their real client docs) to
 * have no week parameter at all. Run this BEFORE cfb-weeklyspsignal-sweep;
 * without it, RatingParams.weeklySpSignalPoints is a silent no-op.
 */
export function startCfbManualSpIngestJob(): Promise<JobStatus> {
  return runJob("cfb-manual-sp-ingest", async (job) => {
    const result = await syncManualSpWeekly2025();
    log(job, `synced ${result.synced}, skipped ${result.skipped}`);
  });
}

/**
 * Sweeps weeklySpSignalPoints -- real week-by-week SP+ as an additive
 * signal (see backtest/sweep.ts's runWeeklySpSignalSweep and
 * RatingParams.weeklySpSignalPoints' doc). ALWAYS scoped to 2025 only
 * (the manual archive only covers that season) regardless of what other
 * jobs use -- see runWeeklySpSignalSweep's doc for why. Requires
 * cfb-manual-sp-ingest to have run first.
 *
 * No walk-forward job for this one: with only a single season of real
 * data, there's no untouched 2023-2024-style holdout to train on and
 * validate against -- see weeklySpSignalPoints' doc in config.ts. Treat
 * any positive result here as single-season, in-sample evidence, not a
 * walk-forward-validated edge like successRateWeight's.
 */
export function startCfbWeeklySpSignalSweepJob(): Promise<JobStatus> {
  return runJob("cfb-weeklyspsignal-sweep", async (job) => {
    log(job, "sweeping cfb weeklySpSignalPoints, 2025 only (real weekly SP+ archive covers just this season)");
    const results = await runWeeklySpSignalSweep("cfb");
    for (const r of results) {
      log(
        job,
        `weeklySpSignalPoints=${r.weeklySpSignalPoints}: ${r.games} games, cover vs close=${fmtPct(r.coverRate)}, ` +
          `cover vs open=${fmtPct(r.coverRateVsOpening)} (${r.openingGames} games w/ opening line), ` +
          `avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)} (run ${r.runId})`,
      );
    }
    log(job, "breakeven vs. standard -110 vig is ~52.4% -- this is single-season/in-sample only, no holdout possible with just one season of real data.");
  });
}

/**
 * Backfills explosiveness + standard/passing-downs success-rate splits for
 * CFB 2023-2025 by RE-RUNNING syncCfbdGameStats -- these come off the SAME
 * /stats/game/advanced response already fetched for EPA/success rate (see
 * ingest/cfbd/client.ts's CfbdAdvancedSide), so this is not a new API call
 * pattern, just more fields off an existing one; the upsert safely updates
 * already-ingested rows in place. THEN ingests sack rate via a genuinely
 * separate /plays pass (syncCfbdSackRateStats, same ~15-calls-per-year
 * shape as cfb-turnover-ingest). Run this before any of the four
 * cfb-component-sweep-* jobs below; without it, those params are silent
 * no-ops (every game falls back to a lower-fidelity signal or pure EPA).
 */
export function startCfbComponentIngestJob(): Promise<JobStatus> {
  return runJob("cfb-component-ingest", async (job) => {
    for (const year of [2023, 2024, 2025]) {
      log(job, `${year}: re-syncing advanced stats (backfills explosiveness + down/distance splits)`);
      const advResult = await syncCfbdGameStats(year);
      log(job, `${year}: advanced stats synced ${advResult.synced}, skipped ${advResult.skipped}`);
      log(job, `${year}: sack rate (weeks 1-15)`);
      const sackResult = await syncCfbdSackRateStats(year);
      log(job, `${year}: sack rate synced ${sackResult.synced}, skipped ${sackResult.skipped}`);
    }
  });
}

/**
 * Phase 2 of the component-model rebuild: "finishing drives" (points per
 * scoring opportunity), from CFBD's /drives endpoint -- a genuinely
 * separate call from cfb-component-ingest's /stats/game/advanced and
 * /plays sources. Only 3 calls total (one per season, week is optional
 * on this endpoint) -- far cheaper than the turnover/sack-rate ingestion.
 * Logs the raw drive count per season as a sanity check, since this
 * sandbox never confirmed the "omit week -> whole season" behavior
 * against a real response (see client.ts's getDrives doc). Run this
 * before cfb-component-sweep-finishingdrives.
 */
export function startCfbFinishingDrivesIngestJob(): Promise<JobStatus> {
  return runJob("cfb-finishingdrives-ingest", async (job) => {
    for (const year of [2023, 2024, 2025]) {
      log(job, `${year}: finishing drives`);
      const result = await syncCfbdFinishingDrivesStats(year);
      log(job, `${year}: fetched ${result.drivesFetched} raw drives, synced ${result.synced}, skipped ${result.skipped}`);
    }
  });
}

const FINISHING_DRIVES_DIAGNOSE_YARDS_TO_GOAL = 40; // must match syncFinishingDrivesStats.ts's SCORING_OPPORTUNITY_YARDS_TO_GOAL

/**
 * Throwaway diagnostic (Task 38): syncCfbdFinishingDrivesStats.ts's
 * per-row findGameId/findTeamIdByName lookup is silently skipping ~48-53%
 * of aggregated (game, team) scoring-opportunity entries per season, far
 * above what "raw /drives feed includes every division, not just FBS"
 * alone should explain (synced counts fall BELOW the theoretical
 * FBS-only max of ~2 * games/season). This classifies every (gameId,
 * team) pair from one season's /drives response into 4 buckets using the
 * bulk maps (fast, no DB round-trip per row) and samples the actual
 * team-name strings that fail to resolve on games that DO resolve --
 * i.e. confirmed-real (likely FBS) games where the team name itself
 * doesn't match teams.name, the case that most directly indicates a
 * name-formatting mismatch rather than legitimate non-FBS filtering.
 *
 * Buckets both the UNFILTERED (gameId, team) universe (every team that
 * appears in any drive) and the SAME startYardsToGoal<=40 "scoring
 * opportunity" filter syncCfbdFinishingDrivesStats.ts actually applies
 * before syncing -- the filtered bucket is what should reproduce
 * production's synced/skipped counts, and its implied per-GAME
 * both-sides-resolve rate (assuming independence) is compared against
 * the database's actual current coverage to check whether the shortfall
 * is fully explained by "non-FBS games + teams with zero scoring
 * opportunities in a game" (no bug) or leaves a residual (still a bug).
 */
export function startCfbFinishingDrivesDiagnoseJob(): Promise<JobStatus> {
  return runJob("cfb-finishingdrives-diagnose", async (job) => {
    const year = 2024;
    log(job, `${year}: fetching raw drives + bulk lookup maps`);
    const [drives, teamMap, gameMap] = await Promise.all([getDrives(year, "regular"), getTeamNameToIdMap("cfb"), getGameSourceIdToIdMap("cfb", year)]);
    log(job, `${year}: fetched ${drives.length} raw drives, ${teamMap.size} teams known, ${gameMap.size} games known for ${year}`);

    function bucketize(pairs: Set<string>, label: string): { bothResolve: number; failingNames: Map<string, number> } {
      let bothResolve = 0;
      let gameOnlyResolves = 0;
      let teamOnlyResolves = 0;
      let neitherResolves = 0;
      const failingNames = new Map<string, number>();
      for (const pair of pairs) {
        const sep = pair.indexOf(":");
        const gameIdStr = pair.slice(0, sep);
        const team = pair.slice(sep + 1);
        const gameResolves = gameMap.has(gameIdStr);
        const teamResolves = teamMap.has(team);
        if (gameResolves && teamResolves) bothResolve += 1;
        else if (gameResolves && !teamResolves) {
          gameOnlyResolves += 1;
          failingNames.set(team, (failingNames.get(team) ?? 0) + 1);
        } else if (!gameResolves && teamResolves) teamOnlyResolves += 1;
        else neitherResolves += 1;
      }
      log(job, `${year} [${label}]: ${pairs.size} pairs -- both resolve=${bothResolve}, game-only=${gameOnlyResolves}, team-only=${teamOnlyResolves}, neither=${neitherResolves}`);
      return { bothResolve, failingNames };
    }

    const allPairs = new Set<string>();
    for (const drive of drives) {
      allPairs.add(`${drive.gameId}:${drive.offense}`);
      allPairs.add(`${drive.gameId}:${drive.defense}`);
    }
    const allResult = bucketize(allPairs, "unfiltered, every team in every drive");

    const opportunityPairs = new Set<string>();
    for (const drive of drives) {
      if (drive.startYardsToGoal > FINISHING_DRIVES_DIAGNOSE_YARDS_TO_GOAL) continue;
      opportunityPairs.add(`${drive.gameId}:${drive.offense}`);
      opportunityPairs.add(`${drive.gameId}:${drive.defense}`);
    }
    const oppResult = bucketize(opportunityPairs, "scoring-opportunity-filtered, matches production sync's population");

    // Participant-correctness check: teamMap.has(team) only proves the name
    // matches SOME row in teams -- not that it's the CORRECT participant
    // for THIS game. upsertFinishingDrivesStats's UPDATE is keyed on
    // (game_id, team_id), so a name that resolves to the wrong team's id
    // silently updates zero rows despite "both resolve" being true above.
    const participants = await getGameParticipantsBySourceId("cfb", year);
    let correctParticipant = 0;
    let wrongParticipant = 0;
    const wrongParticipantSamples: string[] = [];
    for (const pair of opportunityPairs) {
      const sep = pair.indexOf(":");
      const gameIdStr = pair.slice(0, sep);
      const team = pair.slice(sep + 1);
      const gameInfo = participants.get(gameIdStr);
      const teamId = teamMap.get(team);
      if (!gameInfo || teamId == null) continue; // already counted as a resolve failure above
      if (teamId === gameInfo.homeTeamId || teamId === gameInfo.awayTeamId) {
        correctParticipant += 1;
      } else {
        wrongParticipant += 1;
        if (wrongParticipantSamples.length < 15) wrongParticipantSamples.push(`game ${gameIdStr}: drive team "${team}" -> teamId ${teamId}, but game's participants are ${gameInfo.homeTeamId}/${gameInfo.awayTeamId}`);
      }
    }
    log(job, `${year}: of the ${correctParticipant + wrongParticipant} pairs where both game and team "resolve", ${correctParticipant} resolve to the CORRECT participant and ${wrongParticipant} resolve to a team that isn't actually in that game`);
    if (wrongParticipantSamples.length > 0) {
      log(job, `${year}: sample wrong-participant mismatches: ${wrongParticipantSamples.join(" | ")}`);
    }

    const sampleNames = [...allResult.failingNames.entries(), ...oppResult.failingNames.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
      .map(([name, count]) => `"${name}" (x${count})`);
    log(job, `${year}: sample team-name strings that failed to resolve on a confirmed-real game across both buckets (most frequent first): ${sampleNames.join(", ") || "(none -- team-name matching never fails on a resolved game)"}`);

    // independence-assumption prediction: if a team's single-side resolve
    // rate within the opportunity-filtered population is p, and the two
    // sides of a game resolve independently, P(both sides resolve) = p^2.
    const knownGames = gameMap.size;
    const singleSideRate = oppResult.bothResolve / (2 * knownGames);
    const predictedGameCoverage = singleSideRate * singleSideRate;
    log(job, `${year}: opportunity-filtered single-side resolve rate on known games = ${(singleSideRate * 100).toFixed(1)}% -> independence-predicted per-game both-sides coverage = ${(predictedGameCoverage * 100).toFixed(1)}%`);

    const actual = await getFinishingDrivesGameCoverage("cfb", year);
    const actualRate = actual.gamesTotal > 0 ? actual.gamesWithBoth / actual.gamesTotal : 0;
    const statsRowRate = actual.gamesTotal > 0 ? actual.gamesWithBothStatsRows / actual.gamesTotal : 0;
    log(
      job,
      `${year}: ACTUAL database coverage = ${actual.gamesWithBoth}/${actual.gamesTotal} games (${(actualRate * 100).toFixed(1)}%) -- ${
        Math.abs(actualRate - predictedGameCoverage) < 0.1
          ? "matches the independence prediction within ~10pts: fully explained by non-FBS games + zero-opportunity teams, not a lookup bug."
          : "DIFFERS meaningfully from the independence prediction -- something beyond non-FBS filtering + zero-opportunity teams is still suppressing coverage."
      }`,
    );
    log(
      job,
      `${year}: team_game_stats has BOTH sides' rows present (regardless of finishing-drives fields) for ${actual.gamesWithBothStatsRows}/${actual.gamesTotal} games (${(statsRowRate * 100).toFixed(1)}%) -- upsertFinishingDrivesStats is UPDATE-only (see repo.ts doc: "a game with no prior team_game_stats row is a no-op"), so if this rate is also well below the independence prediction, the missing team_game_stats base row -- not the game/team name lookup -- is the real bottleneck.`,
    );

    // Live write instrumentation: game/team/participant all check out on
    // paper, and a fresh production ingest run (immediately before this
    // job) still left DB coverage unchanged -- so actually perform the
    // UPDATE for every correct-participant opportunity entry and record
    // its real rowCount, to see directly whether the WHERE clause matches
    // at write time.
    interface TeamGameAgg {
      offPoints: number;
      offOpportunities: number;
      defPoints: number;
      defOpportunities: number;
    }
    const agg = new Map<string, TeamGameAgg>();
    function get(gameId: number, team: string): TeamGameAgg {
      const key = `${gameId}:${team}`;
      let entry = agg.get(key);
      if (!entry) {
        entry = { offPoints: 0, offOpportunities: 0, defPoints: 0, defOpportunities: 0 };
        agg.set(key, entry);
      }
      return entry;
    }
    for (const drive of drives) {
      if (drive.startYardsToGoal > FINISHING_DRIVES_DIAGNOSE_YARDS_TO_GOAL) continue;
      const points = drive.endOffenseScore - drive.startOffenseScore;
      const offEntry = get(drive.gameId, drive.offense);
      offEntry.offPoints += points;
      offEntry.offOpportunities += 1;
      const defEntry = get(drive.gameId, drive.defense);
      defEntry.defPoints += points;
      defEntry.defOpportunities += 1;
    }

    let attempted = 0;
    let rowCountOne = 0;
    let rowCountZero = 0;
    let rowCountOther = 0;
    const zeroRowSamples: string[] = [];
    let firstSuccess: { gameId: number; teamId: number; team: string; gameIdStr: string; offPpo: number | null; defPpo: number | null } | null = null;
    for (const [key, entry] of agg) {
      const sep = key.indexOf(":");
      const gameIdStr = key.slice(0, sep);
      const team = key.slice(sep + 1);
      const gameInfo = participants.get(gameIdStr);
      const teamId = teamMap.get(team);
      if (!gameInfo || teamId == null) continue;
      if (teamId !== gameInfo.homeTeamId && teamId !== gameInfo.awayTeamId) continue;
      attempted += 1;
      const offPpo = entry.offOpportunities === 0 ? null : entry.offPoints / entry.offOpportunities;
      const defPpo = entry.defOpportunities === 0 ? null : entry.defPoints / entry.defOpportunities;
      const rowCount = await upsertFinishingDrivesStatsDebug({ gameId: gameInfo.gameId, teamId, offFinishingDrivesPpo: offPpo, defFinishingDrivesPpo: defPpo });
      if (rowCount === 1) {
        rowCountOne += 1;
        if (!firstSuccess) firstSuccess = { gameId: gameInfo.gameId, teamId, team, gameIdStr, offPpo, defPpo };
      } else if (rowCount === 0) {
        rowCountZero += 1;
        if (zeroRowSamples.length < 15) zeroRowSamples.push(`game source_id=${gameIdStr} (resolved gameId=${gameInfo.gameId}), team="${team}" (resolved teamId=${teamId})`);
      } else rowCountOther += 1;
    }
    log(job, `${year}: LIVE write test -- attempted ${attempted} real UPDATEs, rowCount=1 (success) for ${rowCountOne}, rowCount=0 (silently matched nothing) for ${rowCountZero}, other rowCount for ${rowCountOther}`);
    if (zeroRowSamples.length > 0) {
      log(job, `${year}: sample rowCount=0 entries: ${zeroRowSamples.join(" | ")}`);
    }

    if (firstSuccess) {
      const readBack = await debugReadFinishingDrivesRow(firstSuccess.gameId, firstSuccess.teamId);
      log(
        job,
        `${year}: direct read-back of the first rowCount=1 write (game source_id=${firstSuccess.gameIdStr}, team="${firstSuccess.team}", gameId=${firstSuccess.gameId}, teamId=${firstSuccess.teamId}) -- wrote offPpo=${firstSuccess.offPpo}, defPpo=${firstSuccess.defPpo} -- DB now has: ${readBack ? `found=true, offPpo=${readBack.offFinishingDrivesPpo}, defPpo=${readBack.defFinishingDrivesPpo}` : "found=false (no row at all!)"}`,
      );
    }

    const reCheck = await getFinishingDrivesGameCoverage("cfb", year);
    log(job, `${year}: post-write-test database coverage = ${reCheck.gamesWithBoth}/${reCheck.gamesTotal} games (was ${actual.gamesWithBoth}/${actual.gamesTotal} before this job's own writes)`);
  });
}

/**
 * Phase 3 of the component-model rebuild: special teams (field position +
 * FG make rate), from a combined /drives + /plays pass -- see
 * ingest/cfbd/syncSpecialTeamsStats.ts. Run this before
 * cfb-component-sweep-fieldposition or cfb-component-sweep-fgmakerate.
 */
export function startCfbSpecialTeamsIngestJob(): Promise<JobStatus> {
  return runJob("cfb-specialteams-ingest", async (job) => {
    for (const year of [2023, 2024, 2025]) {
      log(job, `${year}: special teams (field position + FG rate)`);
      const result = await syncCfbdSpecialTeamsStats(year);
      log(job, `${year}: fetched ${result.drivesFetched} raw drives, synced ${result.synced}, skipped ${result.skipped}`);
    }
  });
}

/**
 * Populates off_adj/def_adj (migration 0013) for every game of 2023-2025,
 * from the raw plays cfb-rawplays-ingest already stored -- no CFBD API
 * calls, pure DB computation via ratings/opponentAdjust.ts's iterative
 * solve, re-run fresh per week over prior weeks only (see
 * ingest/cfbd/syncOpponentAdjustedStats.ts's doc). This is what actually
 * feeds the pointsPerOpponentAdj rating-engine term -- currently 0/untested
 * until this has run and a real sweep follows.
 */
export function startCfbOpponentAdjustedIngestJob(): Promise<JobStatus> {
  return runJob("cfb-opponentadjusted-ingest", async (job) => {
    for (const year of [2023, 2024, 2025]) {
      log(job, `${year}: opponent-adjusted stats (as-of-week, from ingested plays)`);
      const result = await syncOpponentAdjustedStats(year);
      log(job, `${year}: weeksProcessed=${result.weeksProcessed} gamesUpdated=${result.gamesUpdated} teamSidesUpdated=${result.teamSidesUpdated}`);
    }
  });
}

/**
 * Foundation for the SP+-style rebuild: raw play-by-play storage (see
 * migration 0012 and ingest/cfbd/syncRawPlays.ts) -- our own success-rate/
 * situational-split definitions and weighted garbage-time both need
 * individual play rows, not CFBD's pre-aggregated /stats/game/advanced
 * numbers everything up to this point has relied on. Same ~15-calls-per-
 * year /plays shape as syncTurnoverStats.ts, but MUCH heavier on DB writes
 * -- a full season is roughly 250-300k plays (a single real week sampled
 * this session had 19,574), so expect this to take noticeably longer than
 * any other ingestion job tonight. Run this before anything that reads
 * from the `plays` table directly.
 */
export function startCfbRawPlaysIngestJob(): Promise<JobStatus> {
  return runJob("cfb-rawplays-ingest", async (job) => {
    for (const year of [2023, 2024, 2025]) {
      log(job, `${year}: raw play-by-play (weeks 1-15) -- this will take a while`);
      const result = await syncCfbdRawPlays(year);
      log(job, `${year}: fetched ${result.playsFetched} raw plays, synced ${result.synced}, skipped (no game match) ${result.skippedNoGame}`);
    }
  });
}

/**
 * Runs today's default CFB params (SOS removed, all six Phase 1-3
 * component weights calibrated) against 2025 alone. NOT a true blind
 * walk-forward holdout the way cfb-successrate-walkforward's was: every
 * component sweep tonight (Phase 1-3) calibrated its weight against the
 * FULL 2023-2025 sample, including 2025 itself -- so this only shows how
 * the combined package performs on that season, not out-of-sample
 * generalization. A real train-blind/test-blind version would mean
 * re-sweeping every one of the six new params on 2023-2024 only first,
 * a much larger undertaking not done here.
 */
export function startCfb2025CheckJob(): Promise<JobStatus> {
  return runJob("cfb-2025-check", async (job) => {
    log(job, "running cfb 2025-only backtest with today's default params (SOS removed, all Phase 1-3 components calibrated)");
    const result = await runBacktest({ name: "cfb-2025-check", sport: "cfb", seasonStart: 2025, seasonEnd: 2025 });
    const overall = await getOverallReport(result.backtestRunId);
    const openingCover = await getOpeningCoverRate(result.backtestRunId);
    log(
      job,
      `2025: ${result.scored} games, cover vs close=${fmtPct(overall.coverRate)}, ` +
        `cover vs open=${fmtPct(openingCover.coverRateVsOpening)} (${openingCover.games} games w/ opening line), ` +
        `avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(2)} (run ${result.backtestRunId})`,
    );
    log(job, "NOT a true blind holdout -- every component weight above was calibrated against the full 2023-2025 sample, including 2025 itself. Breakeven vs. -110 vig is ~52.4%.");
  });
}

const COMPONENT_SWEEP_JOBS: Array<{ jobName: string; paramKey: ComponentParamKey; grid: number[]; label: string }> = [
  // Refined after the first coarse pass (run 279-298): explosiveness was
  // flat across 0-20 (best near 10) -- narrowed grid for a slightly finer
  // read around that flat region. standardDownsSplit peaked at 30 then
  // declined -- narrowed to pinpoint the peak between 0-50. passingDownsSplit
  // and pointsPerSackRate both declined monotonically starting at the first
  // nonzero point tested (30) -- narrowed toward 0 to find where each is
  // actually best-calibrated, per the user's explicit instruction that these
  // are being included regardless of whether they clear breakeven; this
  // sweep is about WHERE to set the weight, not whether to use it.
  { jobName: "cfb-component-sweep-explosiveness", paramKey: "pointsPerExplosiveness", grid: [0, 5, 8, 10, 12, 15], label: "pointsPerExplosiveness" },
  { jobName: "cfb-component-sweep-standarddowns", paramKey: "pointsPerStandardDownsSplit", grid: [0, 10, 20, 30, 40, 50], label: "pointsPerStandardDownsSplit" },
  { jobName: "cfb-component-sweep-passingdowns", paramKey: "pointsPerPassingDownsSplit", grid: [0, 5, 10, 15, 20, 25], label: "pointsPerPassingDownsSplit" },
  { jobName: "cfb-component-sweep-sackrate", paramKey: "pointsPerSackRate", grid: [0, 5, 10, 15, 20, 25], label: "pointsPerSackRate" },
  // Phase 2: finishing drives. Points-per-opportunity magnitude is
  // EPA/points-scale, not a 0-1 rate -- grid centered more like
  // pointsPerEpa=20's magnitude than the success-rate-scale splits above.
  { jobName: "cfb-component-sweep-finishingdrives", paramKey: "pointsPerFinishingDrives", grid: [0, 2, 5, 10, 20], label: "pointsPerFinishingDrives" },
  // Phase 3: special teams. Field position differentials run maybe 5-15
  // yards -- real football analytics puts field position worth roughly
  // 0.05-0.1 expected points per yard, so a small grid around that.
  { jobName: "cfb-component-sweep-fieldposition", paramKey: "pointsPerFieldPosition", grid: [0, 0.1, 0.2, 0.5, 1], label: "pointsPerFieldPosition" },
  // FG make rate is a 0-1 rate stat like success rate/sack rate -- same scale reasoning.
  { jobName: "cfb-component-sweep-fgmakerate", paramKey: "pointsPerFgMakeRate", grid: [0, 5, 10, 15, 20, 25], label: "pointsPerFgMakeRate" },
  // Phase 4: real opponent-adjustment. off_adj/def_adj are success-rate-
  // scale deviations from league average (real 2024 snapshot ranged
  // roughly -0.15 to +0.12 -- see cfb-opponent-adjust-snapshot) -- same
  // rough scale as the standard/passing-downs splits above, so starting
  // with a similar-order coarse grid before refining.
  { jobName: "cfb-component-sweep-opponentadj", paramKey: "pointsPerOpponentAdj", grid: [0, 20, 40, 60, 80, 100], label: "pointsPerOpponentAdj" },
  // Winsorizing-style cap on the per-game error term -- see elo.ts's doc
  // right where `error` is computed, and RatingParams.errorCapPoints.
  // Grid spans well below the user's suggested 28-35 range (to see if an
  // even tighter cap does better) up through a much looser one (to see
  // where the effect fades out), not just the suggested range alone.
  { jobName: "cfb-component-sweep-errorcap", paramKey: "errorCapPoints", grid: [0, 15, 20, 25, 30, 35, 45, 60], label: "errorCapPoints" },
  // Consistency-based shrinkage toward league mean (0) -- see elo.ts's
  // post-loop shrink pass and RatingParams.varianceShrinkK's doc. Units
  // are the same raw-error points as errorCapPoints (dispersion is a
  // sample stdev of the same rawError values that cap clamps), so the
  // grid brackets a similar range -- coarse first pass, refine toward
  // whichever region shows a real trend, same as every other sweep here.
  { jobName: "cfb-component-sweep-varianceshrink", paramKey: "varianceShrinkK", grid: [0, 5, 10, 15, 20, 30, 45, 60], label: "varianceShrinkK" },
];

/**
 * Seven component sweeps (explosiveness, standard-downs split, passing-
 * downs split, sack rate, finishing drives, field position, FG make rate),
 * each varying ONE param in isolation while every other component stays
 * at its 0 default -- same "one param at a time" discipline as every
 * other sweep tonight, not an expensive multi-dimensional grid. See
 * backtest/sweep.ts's runComponentSweep. Requires cfb-component-ingest
 * (Phase 1 fields), cfb-finishingdrives-ingest (Phase 2), or
 * cfb-specialteams-ingest (Phase 3) to have run first, respectively. No
 * walk-forward job yet for any of these -- built on demand for whichever
 * component(s) actually show a real in-sample trend, same pattern as
 * excludeGarbageTime/pointsPerRestDay (walk-forward only run when the
 * sweep result looked worth confirming).
 */
export const startCfbComponentSweepExplosivenessJob = () => runComponentSweepJob(COMPONENT_SWEEP_JOBS[0]!);
export const startCfbComponentSweepStandardDownsJob = () => runComponentSweepJob(COMPONENT_SWEEP_JOBS[1]!);
export const startCfbComponentSweepPassingDownsJob = () => runComponentSweepJob(COMPONENT_SWEEP_JOBS[2]!);
export const startCfbComponentSweepSackRateJob = () => runComponentSweepJob(COMPONENT_SWEEP_JOBS[3]!);
export const startCfbComponentSweepFinishingDrivesJob = () => runComponentSweepJob(COMPONENT_SWEEP_JOBS[4]!);
export const startCfbComponentSweepFieldPositionJob = () => runComponentSweepJob(COMPONENT_SWEEP_JOBS[5]!);
export const startCfbComponentSweepFgMakeRateJob = () => runComponentSweepJob(COMPONENT_SWEEP_JOBS[6]!);
export const startCfbComponentSweepOpponentAdjJob = () => runComponentSweepJob(COMPONENT_SWEEP_JOBS[7]!);
export const startCfbComponentSweepErrorCapJob = () => runComponentSweepJob(COMPONENT_SWEEP_JOBS[8]!);
export const startCfbComponentSweepVarianceShrinkJob = () => runComponentSweepJob(COMPONENT_SWEEP_JOBS[9]!);

/**
 * The original pointsPerOpponentAdj screening (config.ts's history) ran
 * BEFORE Part 1's market-anchor removal -- under a completely different
 * prediction path. A fresh in-sample sweep post-anchor-removal
 * (cfb-component-sweep-opponentadj) came back with a different shape:
 * cover-vs-close actually looked BETTER at weight=40/60 (50.6% -> 51.3-
 * 51.4%) while avgClv still declined, unlike the old sweep's clean
 * monotonic decline on every metric. This runs a proper paired
 * significance test (identical game sets) comparing weight=40 and
 * weight=60 against weight=0, on both CLV and covered, using the most
 * recent runs of each from listBacktestRuns() by the exact name
 * runComponentSweep uses (`sweep-pointsPerOpponentAdj-cfb-v{value}`) --
 * requires cfb-component-sweep-opponentadj to have just run.
 */
export function startCfbOpponentAdjPairedTestJob(): Promise<JobStatus> {
  return runJob("cfb-opponentadj-paired-test", async (job) => {
    const runs = await listBacktestRuns();
    function latestRunForValue(value: number) {
      const name = `sweep-pointsPerOpponentAdj-cfb-v${value}`;
      const matches = runs.filter((r) => r.name === name);
      return matches.sort((a, b) => b.id - a.id)[0];
    }
    const baseline = latestRunForValue(0);
    if (!baseline) {
      log(job, "No sweep-pointsPerOpponentAdj-cfb-v0 run found -- run cfb-component-sweep-opponentadj first.");
      return;
    }
    log(job, `baseline (pointsPerOpponentAdj=0): run ${baseline.id}`);
    const baselineDetails = await getBacktestGameDetails(baseline.id);

    for (const value of [40, 60]) {
      const variant = latestRunForValue(value);
      if (!variant) {
        log(job, `No sweep-pointsPerOpponentAdj-cfb-v${value} run found -- skipping.`);
        continue;
      }
      const variantDetails = await getBacktestGameDetails(variant.id);
      const commonGameIds = [...baselineDetails.keys()].filter((id) => variantDetails.has(id));
      log(job, `\npointsPerOpponentAdj=${value} (run ${variant.id}) vs. 0 (run ${baseline.id}), ${commonGameIds.length} identical games:`);

      const clvGameIds = commonGameIds.filter(
        (id) => baselineDetails.get(id)!.clv !== null && variantDetails.get(id)!.clv !== null,
      );
      if (clvGameIds.length >= 2) {
        const baseClv = clvGameIds.map((id) => baselineDetails.get(id)!.clv!);
        const varClv = clvGameIds.map((id) => variantDetails.get(id)!.clv!);
        const paired = pairedTTest(baseClv, varClv);
        log(
          job,
          `  CLV (variant - baseline) on ${paired.n} games: mean diff=${paired.meanDiff.toFixed(4)}, t=${paired.tStatistic.toFixed(3)}, p=${paired.pValueTwoSided.toFixed(4)} -- ${
            paired.pValueTwoSided < 0.05 ? "statistically significant at p<0.05." : "NOT statistically significant."
          }`,
        );
      }
      const coveredGameIds = commonGameIds.filter(
        (id) => baselineDetails.get(id)!.covered !== null && variantDetails.get(id)!.covered !== null,
      );
      if (coveredGameIds.length >= 2) {
        const baseCovered = coveredGameIds.map((id) => (baselineDetails.get(id)!.covered ? 1 : 0));
        const varCovered = coveredGameIds.map((id) => (variantDetails.get(id)!.covered ? 1 : 0));
        const paired = pairedTTest(baseCovered, varCovered);
        log(
          job,
          `  covered-as-0/1 (variant - baseline) on ${paired.n} games: mean diff=${paired.meanDiff.toFixed(4)}, t=${paired.tStatistic.toFixed(3)}, p=${paired.pValueTwoSided.toFixed(4)} -- ${
            paired.pValueTwoSided < 0.05 ? "statistically significant at p<0.05." : "NOT statistically significant."
          }`,
        );
      }
    }
    log(
      job,
      "\nIf covered improves significantly while CLV doesn't decline significantly, that's a real, if modest, case for reopening pointsPerOpponentAdj post-anchor-removal. If neither is significant, this is noise around the same null the pre-anchor-removal sweep found, just with different in-sample point estimates -- still doesn't clear the bar for a walk-forward test.",
    );
  });
}

/**
 * cfb-component-sweep-errorcap came back non-monotonic: tight caps (15,
 * 20) hurt BOTH cover and avgClv vs. the uncapped baseline (clip too
 * aggressively, cutting legitimate large surprises along with pathological
 * ones), while 30-35 beat the baseline on both -- the same range the
 * ODU diagnostic's hand math suggested. Paired significance test on 30
 * and 35 against 0, identical games, same pattern as
 * cfb-opponentadj-paired-test. Requires cfb-component-sweep-errorcap to
 * have just run.
 */
export function startCfbErrorCapPairedTestJob(): Promise<JobStatus> {
  return runJob("cfb-errorcap-paired-test", async (job) => {
    const runs = await listBacktestRuns();
    function latestRunForValue(value: number) {
      const name = `sweep-errorCapPoints-cfb-v${value}`;
      const matches = runs.filter((r) => r.name === name);
      return matches.sort((a, b) => b.id - a.id)[0];
    }
    const baseline = latestRunForValue(0);
    if (!baseline) {
      log(job, "No sweep-errorCapPoints-cfb-v0 run found -- run cfb-component-sweep-errorcap first.");
      return;
    }
    log(job, `baseline (errorCapPoints=0): run ${baseline.id}`);
    const baselineDetails = await getBacktestGameDetails(baseline.id);

    for (const value of [30, 35]) {
      const variant = latestRunForValue(value);
      if (!variant) {
        log(job, `No sweep-errorCapPoints-cfb-v${value} run found -- skipping.`);
        continue;
      }
      const variantDetails = await getBacktestGameDetails(variant.id);
      const commonGameIds = [...baselineDetails.keys()].filter((id) => variantDetails.has(id));
      log(job, `\nerrorCapPoints=${value} (run ${variant.id}) vs. 0 (run ${baseline.id}), ${commonGameIds.length} identical games:`);

      const clvGameIds = commonGameIds.filter(
        (id) => baselineDetails.get(id)!.clv !== null && variantDetails.get(id)!.clv !== null,
      );
      if (clvGameIds.length >= 2) {
        const baseClv = clvGameIds.map((id) => baselineDetails.get(id)!.clv!);
        const varClv = clvGameIds.map((id) => variantDetails.get(id)!.clv!);
        const paired = pairedTTest(baseClv, varClv);
        log(
          job,
          `  CLV (variant - baseline) on ${paired.n} games: mean diff=${paired.meanDiff.toFixed(4)}, t=${paired.tStatistic.toFixed(3)}, p=${paired.pValueTwoSided.toFixed(4)} -- ${
            paired.pValueTwoSided < 0.05 ? "statistically significant at p<0.05." : "NOT statistically significant."
          }`,
        );
      }
      const coveredGameIds = commonGameIds.filter(
        (id) => baselineDetails.get(id)!.covered !== null && variantDetails.get(id)!.covered !== null,
      );
      if (coveredGameIds.length >= 2) {
        const baseCovered = coveredGameIds.map((id) => (baselineDetails.get(id)!.covered ? 1 : 0));
        const varCovered = coveredGameIds.map((id) => (variantDetails.get(id)!.covered ? 1 : 0));
        const paired = pairedTTest(baseCovered, varCovered);
        log(
          job,
          `  covered-as-0/1 (variant - baseline) on ${paired.n} games: mean diff=${paired.meanDiff.toFixed(4)}, t=${paired.tStatistic.toFixed(3)}, p=${paired.pValueTwoSided.toFixed(4)} -- ${
            paired.pValueTwoSided < 0.05 ? "statistically significant at p<0.05." : "NOT statistically significant."
          }`,
        );
      }
    }
    log(
      job,
      "\nEven if neither clears significance here, remember the standard for this specific param is different from a pure edge-hunting param per the earlier discussion: face validity (does the power ratings tab look sane) is legitimate evidence on its own for a reference tool, as long as this doesn't show a real CLV COST. A significant CLV cost would be a real reason to hold off regardless of face validity; a null CLV result alongside better cover and fixed face validity is a reasonable adopt.",
    );
  });
}

/**
 * Paired significance test for cfb-component-sweep-varianceshrink, same
 * pattern as startCfbErrorCapPairedTestJob just above -- but tests the
 * FULL grid against the 0 baseline (not a narrowed subset) since this is
 * the first pass, unlike errorCapPoints which had already been narrowed
 * to [30, 35] by the time its paired test was written. Requires
 * cfb-component-sweep-varianceshrink to have just run.
 */
export function startCfbVarianceShrinkPairedTestJob(): Promise<JobStatus> {
  return runJob("cfb-varianceshrink-paired-test", async (job) => {
    const runs = await listBacktestRuns();
    function latestRunForValue(value: number) {
      const name = `sweep-varianceShrinkK-cfb-v${value}`;
      const matches = runs.filter((r) => r.name === name);
      return matches.sort((a, b) => b.id - a.id)[0];
    }
    const baseline = latestRunForValue(0);
    if (!baseline) {
      log(job, "No sweep-varianceShrinkK-cfb-v0 run found -- run cfb-component-sweep-varianceshrink first.");
      return;
    }
    log(job, `baseline (varianceShrinkK=0): run ${baseline.id}`);
    const baselineDetails = await getBacktestGameDetails(baseline.id);

    for (const value of [5, 10, 15, 20, 30, 45, 60]) {
      const variant = latestRunForValue(value);
      if (!variant) {
        log(job, `No sweep-varianceShrinkK-cfb-v${value} run found -- skipping.`);
        continue;
      }
      const variantDetails = await getBacktestGameDetails(variant.id);
      const commonGameIds = [...baselineDetails.keys()].filter((id) => variantDetails.has(id));
      log(job, `\nvarianceShrinkK=${value} (run ${variant.id}) vs. 0 (run ${baseline.id}), ${commonGameIds.length} identical games:`);

      const clvGameIds = commonGameIds.filter(
        (id) => baselineDetails.get(id)!.clv !== null && variantDetails.get(id)!.clv !== null,
      );
      if (clvGameIds.length >= 2) {
        const baseClv = clvGameIds.map((id) => baselineDetails.get(id)!.clv!);
        const varClv = clvGameIds.map((id) => variantDetails.get(id)!.clv!);
        const paired = pairedTTest(baseClv, varClv);
        log(
          job,
          `  CLV (variant - baseline) on ${paired.n} games: mean diff=${paired.meanDiff.toFixed(4)}, t=${paired.tStatistic.toFixed(3)}, p=${paired.pValueTwoSided.toFixed(4)} -- ${
            paired.pValueTwoSided < 0.05 ? "statistically significant at p<0.05." : "NOT statistically significant."
          }`,
        );
      }
      const coveredGameIds = commonGameIds.filter(
        (id) => baselineDetails.get(id)!.covered !== null && variantDetails.get(id)!.covered !== null,
      );
      if (coveredGameIds.length >= 2) {
        const baseCovered = coveredGameIds.map((id) => (baselineDetails.get(id)!.covered ? 1 : 0));
        const varCovered = coveredGameIds.map((id) => (variantDetails.get(id)!.covered ? 1 : 0));
        const paired = pairedTTest(baseCovered, varCovered);
        log(
          job,
          `  covered-as-0/1 (variant - baseline) on ${paired.n} games: mean diff=${paired.meanDiff.toFixed(4)}, t=${paired.tStatistic.toFixed(3)}, p=${paired.pValueTwoSided.toFixed(4)} -- ${
            paired.pValueTwoSided < 0.05 ? "statistically significant at p<0.05." : "NOT statistically significant."
          }`,
        );
      }
    }
    log(
      job,
      "\nPer the user's explicit framing: keep CLV as a do-no-harm check, not the decider -- the actual decision criterion is whether the top 25 looks right (see cfb-variance-facevalidity). A significant CLV COST here would be a real reason to hold off regardless of face validity; a null-to-positive CLV result alongside fixed face validity is a reasonable adopt.",
    );
  });
}

/**
 * Direct face-validity check for varianceShrinkK -- the actual decision
 * criterion per the user's explicit framing ("does the top 25 look
 * right", CLV as do-no-harm only). Shows CFB 2025 week 14's top 25 by
 * baseline (varianceShrinkK=0) rating, each team's dispersion, its
 * shrunk rating at a representative candidate K, and where it lands in
 * the shrunk ranking -- plus explicit before/after lines for the three
 * teams that motivated this (Old Dominion, Penn State, Clemson), whether
 * or not they're still in the top 25 after shrinking.
 *
 * K=20 is a representative candidate, not a calibrated choice -- picked
 * because it's mid-grid in cfb-component-sweep-varianceshrink and matches
 * the dispersion scale real per-team stdevs are expected to fall in (see
 * that sweep's grid comment). Re-run this by hand with a different K
 * (edit CANDIDATE_VARIANCE_SHRINK_K below) once the sweep/paired-test
 * results point to an actual best value.
 */
const CANDIDATE_VARIANCE_SHRINK_K = 20;

export function startCfbVarianceFaceValidityJob(): Promise<JobStatus> {
  return runJob("cfb-variance-facevalidity", async (job) => {
    const season = 2025;
    const week = 14;
    const teamNameToId = await getTeamNameToIdMap("cfb");
    const idToTeamName = new Map<number, string>();
    for (const [name, id] of teamNameToId) idToTeamName.set(id, name);

    const baseParams = getRatingParams("cfb");
    const shrunkParams = { ...baseParams, varianceShrinkK: CANDIDATE_VARIANCE_SHRINK_K };
    const [baseState, shrunkState] = await Promise.all([
      computeRatings("cfb", season, week, baseParams),
      computeRatings("cfb", season, week, shrunkParams),
    ]);

    interface Row {
      teamId: number;
      name: string;
      baseRating: number;
      dispersion: number;
      shrunkRating: number;
    }
    const rows: Row[] = [];
    for (const [teamId, base] of baseState) {
      const shrunk = shrunkState.get(teamId);
      rows.push({
        teamId,
        name: idToTeamName.get(teamId) ?? `team ${teamId}`,
        baseRating: base.rating,
        dispersion: base.dispersion,
        shrunkRating: shrunk?.rating ?? base.rating,
      });
    }

    const byBase = [...rows].sort((a, b) => b.baseRating - a.baseRating);
    const byShrunk = [...rows].sort((a, b) => b.shrunkRating - a.shrunkRating);
    const shrunkRank = new Map<number, number>();
    byShrunk.forEach((r, i) => shrunkRank.set(r.teamId, i + 1));

    log(job, `CFB ${season} week ${week}: top 25 by baseline (varianceShrinkK=0) rating, vs. shrunk at K=${CANDIDATE_VARIANCE_SHRINK_K}.`);
    log(job, "rank  team                  base_rating  dispersion  shrunk_rating  shrunk_rank");
    byBase.slice(0, 25).forEach((r, i) => {
      log(
        job,
        [
          String(i + 1).padEnd(4),
          r.name.padEnd(20).slice(0, 20),
          r.baseRating.toFixed(2).padStart(11),
          r.dispersion.toFixed(2).padStart(10),
          r.shrunkRating.toFixed(2).padStart(13),
          String(shrunkRank.get(r.teamId)).padStart(11),
        ].join("  "),
      );
    });

    log(job, "\nThe three teams that motivated this:");
    for (const name of ["Old Dominion", "Penn State", "Clemson"]) {
      const row = rows.find((r) => r.name === name);
      if (!row) {
        log(job, `  ${name}: not found (didn't play through week ${week}?)`);
        continue;
      }
      const baseRank = byBase.findIndex((r) => r.teamId === row.teamId) + 1;
      log(
        job,
        `  ${name}: base rank ${baseRank} (${row.baseRating.toFixed(2)}), dispersion ${row.dispersion.toFixed(2)} -> shrunk rank ${shrunkRank.get(row.teamId)} (${row.shrunkRating.toFixed(2)})`,
      );
    }
  });
}

/**
 * Re-persists real (non-backtest) team_ratings + model_predictions for
 * CFB 2025 using CURRENT config defaults, no override -- needed after
 * adopting errorCapPoints=35 (or any config change) because
 * computeAndStoreRatings/predictAndStoreWeek write to those SAME shared
 * tables every time ANY backtest run touches a season (see
 * cfb-team-rating-delta-diagnostic's doc for why this matters) -- the
 * dozens of sweep/paired-test backtests run while investigating the ODU
 * case left team_ratings/model_predictions for 2025 reflecting whichever
 * run went last (errorCapPoints=60, the final sweep grid value), not
 * today's actual default. The Slate UI's Weekly Slate and Power Ratings
 * tabs read directly from these tables (Matchup Sim doesn't -- it uses
 * the read-only computeRatings, always fresh), so this is what actually
 * makes the live site reflect the current config, not just the code
 * being deployed.
 */
export function startCfbRecomputeRatingsJob(): Promise<JobStatus> {
  return runJob("cfb-recompute-ratings", async (job) => {
    const season = 2025;
    log(job, `Recomputing and persisting real CFB ${season} ratings + predictions, weeks 1-15, current config defaults (no override).`);
    for (let week = 1; week <= 15; week++) {
      const state = await computeAndStoreRatings("cfb", season, week);
      const { predicted } = await generateBacktestPredictionsForWeek("cfb", season, week);
      log(job, `week ${week}: ${state.size} teams rated, ${predicted} predictions generated`);
    }
    log(job, "done -- /slate should now reflect the current default config.");
  });
}

function runComponentSweepJob(spec: { jobName: string; paramKey: ComponentParamKey; grid: number[]; label: string }): Promise<JobStatus> {
  return runJob(spec.jobName, async (job) => {
    log(job, `sweeping cfb ${spec.label}, 2023-2025`);
    const results = await runComponentSweep("cfb", 2023, 2025, spec.paramKey, spec.grid);
    for (const r of results) {
      log(
        job,
        `${spec.label}=${r.value}: ${r.games} games, cover vs close=${fmtPct(r.coverRate)}, ` +
          `cover vs open=${fmtPct(r.coverRateVsOpening)} (${r.openingGames} games w/ opening line), ` +
          `avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)} (run ${r.runId})`,
      );
    }
    log(job, "breakeven vs. standard -110 vig is ~52.4%. In-sample only (2023-2025 combined) -- treat any promising trend as a hypothesis to walk-forward test, not a proven edge.");
  });
}

/**
 * The real answer to "was any of tonight's Phase 1-4 calibration actually
 * validated, or just fit to the sample it was evaluated on": every one of
 * COMPONENT_SWEEP_JOBS' 9 params (the 7 already-adopted Phase 1-3
 * weights, pointsPerOpponentAdj (still 0), and errorCapPoints (still 0))
 * was originally calibrated against the FULL 2023-2025 sample -- this
 * runs a genuine train(2023-2024)/test(2025) split for each, via
 * runComponentSweepWalkforward, and for comparison also runs a weight=0
 * baseline on the SAME 2025 holdout, so "did the training-selected weight
 * actually beat doing nothing, out of sample" is a direct, visible
 * comparison rather than an inference.
 *
 * This is a lot of backtest runs (9 params x (6-8ish training values + 2
 * holdout runs) = ~70+ full season replays) -- expect this to take
 * several minutes.
 */
export function startCfbWalkforwardAllComponentsJob(): Promise<JobStatus> {
  return runJob("cfb-walkforward-allcomponents", async (job) => {
    log(job, "Real train(2023-2024)/test(2025) holdout for every Phase 1-4 component weight.");
    for (const spec of COMPONENT_SWEEP_JOBS) {
      log(job, `\n=== ${spec.label} ===`);
      const result = await runComponentSweepWalkforward("cfb", spec.paramKey, spec.grid, 2023, 2024, 2025);
      for (const r of result.trainResults) {
        log(
          job,
          `  train (2023-2024): ${spec.label}=${r.value}: cover vs open=${fmtPct(r.coverRateVsOpening)} ` +
            `(${r.openingGames} games), avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)} (run ${r.runId})`,
        );
      }
      log(job, `  BEST TRAINING VALUE (by cover vs open): ${spec.label}=${result.bestTrainValue}`);

      const base = getRatingParams("cfb");
      const zeroed = { ...base, [spec.paramKey]: 0 };
      const zeroHoldout = await runBacktest({
        name: `walkforward-${spec.paramKey}-cfb-v0-test2025-baseline`,
        sport: "cfb",
        seasonStart: 2025,
        seasonEnd: 2025,
        paramsOverride: zeroed,
      });
      const zeroOverall = await getOverallReport(zeroHoldout.backtestRunId);
      const zeroOpening = await getOpeningCoverRate(zeroHoldout.backtestRunId);

      log(
        job,
        `  HOLDOUT 2025, ${spec.label}=0 (baseline): ${zeroHoldout.scored} games, cover vs open=${fmtPct(zeroOpening.coverRateVsOpening)} ` +
          `(${zeroOpening.games} games), avgClv=${zeroOverall.avgClv === null ? "n/a" : zeroOverall.avgClv.toFixed(2)} (run ${zeroHoldout.backtestRunId})`,
      );
      log(
        job,
        `  HOLDOUT 2025, ${spec.label}=${result.bestTrainValue} (training-selected): ${result.holdoutGames} games, ` +
          `cover vs open=${fmtPct(result.holdoutCoverRateVsOpening)} (${result.holdoutOpeningGames} games), ` +
          `avgClv=${result.holdoutAvgClv === null ? "n/a" : result.holdoutAvgClv.toFixed(2)} (run ${result.holdoutRunId})`,
      );
    }
    log(
      job,
      "\nFor each component: did the training-selected weight's 2025 holdout numbers actually beat the weight=0 baseline's 2025 holdout numbers? " +
        "If not, that component's Phase 1-3/4 calibration didn't generalize out of sample, regardless of how it looked on the full 2023-2025 sample.",
    );
  });
}

/**
 * The joint-refit answer to the architectural critique that one-at-a-time
 * sweeps (holding every other weight fixed at values calibrated in the
 * swept term's absence) can't distinguish "this component carries no
 * information" from "this component is correlated with others that
 * already got credit for it" -- see backtest/jointRefit.ts's full design
 * doc. Fits all 8 component weights jointly via ridge regression on
 * 2023-2024 (never touching 2025), then compares the CURRENT hand-tuned
 * weights against the newly jointly-fit weights on the SAME untouched
 * 2025 holdout.
 */
function logJointRefitFit(job: JobStatus, refit: JointRefitResult): void {
  log(job, "\nper-component two-sided coverage (non-null count, before any gating/imputation):");
  for (const c of refit.componentCoverage) {
    log(job, `  ${c.label}: ${c.nonNullCount} of ${refit.gamesTotal}`);
  }
  log(job, `\ntraining games used (complete-case on the non-imputed components, value+indicator on the rest): ${refit.gamesUsed} of ${refit.gamesTotal}`);
  log(job, "imputed components (value+indicator instead of a hard gate):");
  for (const c of refit.imputedComponents) {
    log(
      job,
      `  ${c.key}: real=${c.real}, imputed=${c.imputed}, missingness-indicator coefficient=${c.missingIndicatorCoefficient.toFixed(4)} (large magnitude here means missingness itself, not the raw value, is carrying the signal -- treat the raw-value weight below with that in mind)`,
    );
  }
  log(job, "\nvariance inflation factors (VIF > 5 worth a look, VIF > 10 means that column's coefficient is close to uninterpretable alone):");
  for (const v of refit.vif) {
    log(job, `  ${v.label}: ${Number.isFinite(v.vif) ? v.vif.toFixed(2) : "Infinity (perfectly/near-perfectly collinear with the rest)"}`);
  }
  log(job, `selected lambda (5-fold CV, grouped by season-week): ${refit.selectedLambda}`);
  log(job, "CV grid (lambda: mse):");
  for (const r of refit.cvResults) log(job, `  ${r.lambda}: ${r.mse.toFixed(3)}`);

  if (refit.baseMarginCoefficient !== null) {
    log(job, `\nbaseMargin coefficient (the 9th feature -- EPA/success-rate core): ${refit.baseMarginCoefficient.toFixed(4)}`);
  }
  log(job, `\njointly-fit weights (intercept ${refit.intercept.toFixed(3)}):`);
  for (const [key, value] of Object.entries(refit.weights)) {
    log(job, `  ${key} = ${(value as number).toFixed(4)}`);
  }
}

function logJointRefitResult(job: JobStatus, result: Awaited<ReturnType<typeof runJointRefitHoldout>>): void {
  logJointRefitFit(job, result.refit);

  log(
    job,
    `\nHOLDOUT 2025, current hand-tuned weights: ${result.handTunedGames} games, ` +
      `cover vs open=${fmtPct(result.handTunedCoverRateVsOpening)}, avgClv=${result.handTunedAvgClv === null ? "n/a" : result.handTunedAvgClv.toFixed(2)} (run ${result.handTunedHoldoutRunId})`,
  );
  log(
    job,
    `HOLDOUT 2025, jointly-fit weights: ${result.jointGames} games, ` +
      `cover vs open=${fmtPct(result.jointCoverRateVsOpening)}, avgClv=${result.jointAvgClv === null ? "n/a" : result.jointAvgClv.toFixed(2)} (run ${result.jointHoldoutRunId})`,
  );
  log(
    job,
    "\nDid the joint refit's 2025 holdout numbers actually beat the hand-tuned weights' 2025 holdout numbers? " +
      "This is the real test of whether joint (vs. one-at-a-time) calibration recovers value the sweep-based approach left on the table.",
  );
}

export function startCfbJointRefitHoldoutJob(): Promise<JobStatus> {
  return runJob("cfb-jointrefit-holdout", async (job) => {
    log(job, "CONTEMPORANEOUS mode: fitting all 8 component weights against the SAME game's own margin (ridge, CV-selected lambda) on 2023-2024, holding out 2025 entirely.");
    const result = await runJointRefitHoldout("cfb", 2023, 2024, 2025, undefined, "contemporaneous");
    logJointRefitResult(job, result);
  });
}

/**
 * PREDICTIVE reframing (see jointRefit.ts's JointRefitMode doc): features
 * are each team's own rolling average through PRIOR games this season
 * only (buildAsOfWeekGames), target is still the real outcome of the game
 * being predicted -- a genuine forecasting regression instead of a
 * same-game accounting decomposition. Expect RMSE far closer to
 * market/forecast quality (~13-14) than the contemporaneous mode's ~8-9,
 * and expect some coefficients (especially finishingDrives, which the
 * contemporaneous run's missingness-indicator already suggested was
 * mostly a blowout proxy) to move substantially or go near-zero.
 */
export function startCfbJointRefitPredictiveHoldoutJob(): Promise<JobStatus> {
  return runJob("cfb-jointrefit-predictive-holdout", async (job) => {
    log(
      job,
      "PREDICTIVE mode: fitting all 8 component weights against the FOLLOWING game's real margin, using each team's own as-of-week rolling averages through prior games (ridge, CV-selected lambda) on 2023-2024, holding out 2025 entirely.",
    );
    const result = await runJointRefitHoldout("cfb", 2023, 2024, 2025, undefined, "predictive");
    logJointRefitResult(job, result);
  });
}

/**
 * Direct test of the redundancy hypothesis this whole thread has been
 * circling (per review): every one of the 8 components is a reweighting
 * of the SAME play-by-play EPA already summarizes (success rate is EPA
 * thresholded, explosiveness is EPA conditioned on success, down-splits
 * are EPA partitioned by situation, opponentAdj is EPA opponent-adjusted).
 * If EPA is close to a sufficient statistic for play-level performance,
 * the 8 components have little left to contribute ONCE EPA's own
 * predictive content is actually in the design matrix, rather than
 * pre-subtracted out of the target (where their coefficients silently
 * absorb whatever EPA would have explained). This is a fit-only
 * diagnostic (no holdout backtest -- baseMargin's coefficient isn't a
 * RatingParams field, so there's nothing to deploy here, only something
 * to read): if the 8 collapse toward 0 with baseMargin included as a 9th
 * feature, redundancy is confirmed and the architecture decision follows.
 */
export function startCfbJointRefitConditionalEpaJob(): Promise<JobStatus> {
  return runJob("cfb-jointrefit-conditional-epa", async (job) => {
    log(
      job,
      "PREDICTIVE mode + baseMargin as a 9th feature: does the 8 components' coefficients collapse toward 0 once conditioned on the EPA/success-rate core? Fitting on 2023-2024 (no holdout backtest -- this is a fit-only diagnostic).",
    );
    const refit = await fitJointComponentWeights("cfb", 2023, 2024, undefined, "predictive", true);
    logJointRefitFit(job, refit);
    log(
      job,
      "\nIf the 8 components above are small relative to their contemporaneous/predictive-without-EPA values (compare against cfb-jointrefit-predictive-holdout's weights), that confirms they're mostly redundant with EPA rather than carrying independent signal.",
    );
  });
}

/**
 * Placebo/shuffle check for the CLV metric itself: takes the two most
 * recent cfb-jointrefit-holdout runs (hand-tuned and jointly-fit, both on
 * the 2025 holdout), and for each, randomly reassigns modelSpreadHome
 * across games many times, recomputing CLV each time against the game's
 * REAL opening/closing lines. If CLV is a sound metric, this shuffle-null
 * distribution should center near 0 regardless of which run it's applied
 * to -- both hand-tuned and jointly-fit real avgClv have landed in the
 * +0.78 to +0.91 range, which is large enough (and stable enough across
 * models that should differ) to be worth checking isn't actually a
 * property of the bet-selection/line-timestamp logic rather than either
 * model. See backtest/placebo.ts for the full reasoning.
 */
async function logClvPlaceboAndPairedTest(job: JobStatus, label: string, handTuned: BacktestRunSummary | undefined, joint: BacktestRunSummary | undefined): Promise<void> {
  const targets = [handTuned, joint].filter((r): r is BacktestRunSummary => r != null);
  if (targets.length === 0) {
    log(job, `\n[${label}] no matching runs found -- skipping.`);
    return;
  }

  for (const run of targets) {
    const rows = await getBacktestClvRows(run.id);
    const overall = await getOverallReport(run.id);
    const result = runPlaceboTest(rows, overall.avgClv, 2000, 42);
    log(job, `\n[${label}] run ${run.id} (${run.name}): real avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(3)} over ${rows.length} games with a real opening line`);
    log(job, `  placebo null (${result.trials} random reassignments of modelSpreadHome across games): mean=${result.placeboMean.toFixed(4)}, sd=${result.placeboSd.toFixed(4)}`);
    log(
      job,
      `  real avgClv is ${result.realClvZScore === null ? "n/a" : result.realClvZScore.toFixed(2)} placebo-SDs from the placebo mean -- ` +
        `${
          Math.abs(result.placeboMean) > 0.1
            ? "placebo mean is NOT near 0: CLV itself likely carries a structural bias independent of model quality -- treat every avgClv number in this project as suspect until this is root-caused."
            : "placebo mean is near 0, as a sound CLV metric should be -- the real result isn't explained by a bias in the metric itself."
        }`,
    );
  }

  await logPairedClvTest(job, label, "jointly-fit", "hand-tuned", joint, handTuned);
}

/** Paired t-test on CLV between any two backtest runs (by game_id) -- generic, used for hand-tuned-vs-joint AND for the naive-baseline comparison. */
async function logPairedClvTest(
  job: JobStatus,
  label: string,
  aName: string,
  bName: string,
  runA: BacktestRunSummary | undefined,
  runB: BacktestRunSummary | undefined,
): Promise<void> {
  if (!runA || !runB) return;
  const aClv = await getBacktestClvByGame(runA.id);
  const bClv = await getBacktestClvByGame(runB.id);
  const commonGameIds = [...aClv.keys()].filter((id) => bClv.has(id));
  if (commonGameIds.length < 2) {
    log(job, `[${label}] could not run the paired CLV test (${aName} vs ${bName}) -- only ${commonGameIds.length} games in common between the two runs.`);
    return;
  }
  const a = commonGameIds.map((id) => bClv.get(id)!);
  const b = commonGameIds.map((id) => aClv.get(id)!);
  const paired = pairedTTest(a, b);
  log(
    job,
    `[${label}] paired test, ${aName} CLV vs ${bName} CLV on the SAME ${paired.n} holdout games: mean diff=${paired.meanDiff.toFixed(4)}, t=${paired.tStatistic.toFixed(3)}, p(two-sided)=${paired.pValueTwoSided.toFixed(4)} -- ${
      paired.pValueTwoSided < 0.05 ? "statistically significant at p<0.05." : "NOT statistically significant."
    }`,
  );
}

export function startCfbClvPlaceboJob(): Promise<JobStatus> {
  return runJob("cfb-clv-placebo", async (job) => {
    const runs = await listBacktestRuns();
    const contemporaneousHandTuned = runs.find((r) => r.name.startsWith("jointrefit-handtuned-cfb-test"));
    const contemporaneousJoint = runs.find((r) => r.name.startsWith("jointrefit-joint-cfb-test"));
    await logClvPlaceboAndPairedTest(job, "contemporaneous", contemporaneousHandTuned, contemporaneousJoint);

    const predictiveHandTuned = runs.find((r) => r.name.startsWith("jointrefit-predictive-handtuned-cfb-test"));
    const predictiveJoint = runs.find((r) => r.name.startsWith("jointrefit-predictive-joint-cfb-test"));
    await logClvPlaceboAndPairedTest(job, "predictive", predictiveHandTuned, predictiveJoint);

    if (!contemporaneousHandTuned && !contemporaneousJoint && !predictiveHandTuned && !predictiveJoint) {
      log(job, "\nNo jointrefit* holdout runs found at all -- run cfb-jointrefit-holdout and/or cfb-jointrefit-predictive-holdout first.");
    }

    const naiveBaseline = runs.find((r) => r.name.startsWith("jointrefit-naivebaseline-cfb-test"));
    if (naiveBaseline && contemporaneousHandTuned) {
      log(job, "\n[naive-baseline] does the hand-tuned model's CLV actually differ from a model with all 8 components zeroed out (same market-anchoring)?");
      await logPairedClvTest(job, "naive-baseline", "hand-tuned", "naive-baseline (0 components)", contemporaneousHandTuned, naiveBaseline);
    }

    const frozenRatings = runs.find((r) => r.name.startsWith("jointrefit-frozenratings-cfb-test"));
    if (frozenRatings && contemporaneousHandTuned) {
      log(job, "\n[frozen-ratings] does the hand-tuned model's CLV actually differ from ratings frozen at prior-season-final (no in-season learning, same market-shrinkage)?");
      await logPairedClvTest(job, "frozen-ratings", "hand-tuned", "frozen-ratings (baseK=0)", contemporaneousHandTuned, frozenRatings);
    }
  });
}

/**
 * Second placebo, per review: shuffling modelSpreadHome across games (the
 * job above) only tests whether the CLV FORMULA is biased, since it
 * destroys any relationship between the model's number and the specific
 * game -- it says nothing about whether the model's SKILL (vs. the
 * market-anchoring blend it sits inside) is what's producing the real
 * ~0.8-0.9 avgClv. This runs a deliberately naive model -- current
 * hand-tuned params with all 8 component weights forced to 0, so
 * predictions are pure EPA/success-rate-blend anchored to market the
 * SAME way the real model is -- on the identical 2025 holdout. If this
 * naive baseline ALSO lands near 0.8-0.9 avgClv, the number is coming
 * from the market-anchoring mechanics themselves (or from EPA/success
 * alone), not from anything the 8 components contribute.
 */
export function startCfbClvNaiveBaselineJob(): Promise<JobStatus> {
  return runJob("cfb-clv-naive-baseline", async (job) => {
    const base = getRatingParams("cfb");
    const naiveParams: RatingParams = {
      ...base,
      pointsPerExplosiveness: 0,
      pointsPerStandardDownsSplit: 0,
      pointsPerPassingDownsSplit: 0,
      pointsPerSackRate: 0,
      pointsPerFinishingDrives: 0,
      pointsPerFieldPosition: 0,
      pointsPerFgMakeRate: 0,
      pointsPerOpponentAdj: 0,
    };
    log(job, "Running a deliberately naive model (all 8 component weights = 0, pure EPA/success-rate blend, same market-anchoring as always) on the 2025 holdout.");
    const naive = await runBacktest({
      name: "jointrefit-naivebaseline-cfb-test2025",
      sport: "cfb",
      seasonStart: 2025,
      seasonEnd: 2025,
      paramsOverride: naiveParams,
    });
    const overall = await getOverallReport(naive.backtestRunId);
    const opening = await getOpeningCoverRate(naive.backtestRunId);
    log(
      job,
      `naive baseline (run ${naive.backtestRunId}): ${naive.scored} games, cover vs open=${fmtPct(opening.coverRateVsOpening)}, avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(3)}`,
    );
    log(
      job,
      `Compare this to the ~0.78-0.91 avgClv the hand-tuned and jointly-fit runs (with all 8 components active) have shown. ` +
        `If this naive number lands in the same range, the CLV is coming from market-anchoring/EPA alone, not from the 8 components' contribution -- ` +
        `run cfb-clv-placebo to see the hand-tuned/jointly-fit numbers again for direct comparison.`,
    );
  });
}

/**
 * SUPERSEDED by the market-anchor removal (predictSpread no longer takes
 * marketSpreadHome as an input at all -- see its doc). This job's own
 * result was exactly what motivated that removal: it was built to test
 * whether market-anchoring mechanics (as opposed to in-season learning)
 * explained the model's CLV, and pointed straight at the anchor as the
 * remaining live suspect. Kept for history; a fresh run today no longer
 * has any "market-shrinkage" to hold constant, so its result would no
 * longer test what this doc originally describes.
 *
 * Original doc: the naive baseline above still lets ratings ADAPT
 * in-season (EPA/success-rate updates every week) -- it establishes
 * "components add nothing," not "where does +0.8 CLV come from." This
 * freezes each team's rating at its prior-season-final carryover value
 * for the ENTIRE 2025 season (baseK=0 means `rating += baseK*error`
 * never moves the rating, while gamesPlayed still increments normally --
 * see ratings/elo.ts's computeSeasonRatings tail), so market-shrinkage
 * behaves EXACTLY as it always does (same modelWeight/combinedGames
 * formula), but in-season learning is switched off entirely.
 */
export function startCfbClvFrozenRatingsJob(): Promise<JobStatus> {
  return runJob("cfb-clv-frozen-ratings", async (job) => {
    const base = getRatingParams("cfb");
    const frozenParams: RatingParams = { ...base, baseK: 0 };
    log(job, "Running with baseK=0 -- ratings frozen at their prior-season-final carryover value all season, same market-shrinkage mechanics -- on the 2025 holdout.");
    const frozen = await runBacktest({
      name: "jointrefit-frozenratings-cfb-test2025",
      sport: "cfb",
      seasonStart: 2025,
      seasonEnd: 2025,
      paramsOverride: frozenParams,
    });
    const overall = await getOverallReport(frozen.backtestRunId);
    const opening = await getOpeningCoverRate(frozen.backtestRunId);
    log(
      job,
      `frozen-ratings baseline (run ${frozen.backtestRunId}): ${frozen.scored} games, cover vs open=${fmtPct(opening.coverRateVsOpening)}, avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(3)}`,
    );
    log(
      job,
      `Compare this to the ~0.78-0.91 avgClv every OTHER configuration (hand-tuned, jointly-fit, naive baseline) has shown. ` +
        `If this ALSO lands in the same range despite ratings never updating in-season, the CLV is coming from market-anchoring mechanics/prior-season carryover, not from in-season learning -- ` +
        `run the paired CLV test (see cfb-clv-placebo's pattern) against the hand-tuned run to confirm statistically rather than eyeballing it.`,
    );
  });
}

/**
 * Honest re-baseline after Part 1's market-anchor removal (see
 * ratings/elo.ts's predictSpread doc -- it no longer takes a market line
 * as an input at all). Every prior number in this file's history
 * (including this session's own cfb-jointrefit and cfb-clv prefixed
 * runs) was produced by the OLD market-anchored model and is not
 * comparable to this. No tuning pass before this run -- report cover
 * rate/avgClv exactly as they come out, worse numbers included.
 */
export function startCfbUnanchoredRebaselineJob(): Promise<JobStatus> {
  return runJob("cfb-unanchored-rebaseline", async (job) => {
    log(job, "Running the full 2023-2025 CFB backtest with the market anchor removed -- current RatingParams, no override, no tuning.");
    const result = await runBacktest({ name: "cfb-unanchored-rebaseline-2023-2025", sport: "cfb", seasonStart: 2023, seasonEnd: 2025 });
    const overall = await getOverallReport(result.backtestRunId);
    const opening = await getOpeningCoverRate(result.backtestRunId);
    log(
      job,
      `unanchored rebaseline (run ${result.backtestRunId}): ${result.scored} games, cover vs open=${fmtPct(opening.coverRateVsOpening)} (${opening.games} games with an opening line), avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(3)}, overall cover=${fmtPct(overall.coverRate)}`,
    );
    log(
      job,
      `Every earlier number in this project (this session's cfb-jointrefit-*/cfb-clv-* included) was produced by the market-anchored model and is not comparable to this. This is the new honest baseline.`,
    );
  });
}

/**
 * Per review: the unanchored rebaseline's two headline numbers moved in
 * OPPOSITE directions (avgClv fell, cover-vs-open rose) -- when that
 * happens the usual cause is a change in the DISTRIBUTION of picks, not
 * their quality, since removing the anchor lets the model deviate from
 * market much further on marginal games. This checks that directly:
 * finds the most recent pre-Part-1 (anchored) full 2023-2025 CFB run,
 * restricts to the games BOTH runs scored, and reports (a) how many
 * picks flipped sides, (b) cover rate restricted to same-side-pick
 * games only, (c) a proper paired significance test on CLV and on
 * covered (not eyeballed aggregate deltas from two different
 * populations), and (d) a breakdown bucketed by COMBINED GAMES PLAYED
 * (not calendar week -- a team's week 4 with a bye and an FCS game is a
 * different information state than a team's week 4 with 3 FBS games),
 * testing the specific prediction that unanchored should be clearly
 * worse when games-played is low and comparable-or-better once it's not.
 */
export function startCfbAnchorRemovalBreakdownJob(): Promise<JobStatus> {
  return runJob("cfb-anchor-removal-breakdown", async (job) => {
    const runs = await listBacktestRuns();
    const unanchored = runs.find((r) => r.name.startsWith("cfb-unanchored-rebaseline-"));
    if (!unanchored) {
      log(job, "No cfb-unanchored-rebaseline-* run found -- run cfb-unanchored-rebaseline first.");
      return;
    }
    const anchored = runs.find(
      (r) => r.sport === "cfb" && r.seasonStart === 2023 && r.seasonEnd === 2025 && r.id !== unanchored.id && r.id < unanchored.id && !r.hasParamsOverride,
    );
    if (!anchored) {
      log(job, "No pre-existing UNMODIFIED-baseline (no paramsOverride) full 2023-2025 CFB run found to compare against -- can't do an apples-to-apples check. A sweep-variant run doesn't count -- it confounds the anchor-removal comparison with an unrelated parameter change.");
      return;
    }
    log(job, `Comparing unanchored run ${unanchored.id} (${unanchored.name}) against anchored run ${anchored.id} (${anchored.name}, created ${anchored.createdAt.toISOString()}).`);

    const [anchoredDetails, unanchoredDetails] = await Promise.all([getBacktestGameDetails(anchored.id), getBacktestGameDetails(unanchored.id)]);
    const commonGameIds = [...anchoredDetails.keys()].filter((id) => unanchoredDetails.has(id));
    log(job, `${commonGameIds.length} games scored by both runs.`);

    function pickSide(d: { modelSpreadHome: number; openingSpreadHome: number | null }): "home" | "away" | null {
      if (d.openingSpreadHome === null) return null;
      return d.openingSpreadHome - d.modelSpreadHome >= 0 ? "home" : "away";
    }

    let bothHaveOpeningLine = 0;
    let flips = 0;
    let sameSideBothCovered = 0;
    let sameSideAnchoredCovered = 0;
    let sameSideUnanchoredCovered = 0;
    let sameSideCount = 0;
    for (const id of commonGameIds) {
      const a = anchoredDetails.get(id)!;
      const u = unanchoredDetails.get(id)!;
      const aSide = pickSide(a);
      const uSide = pickSide(u);
      if (aSide === null || uSide === null) continue;
      bothHaveOpeningLine += 1;
      if (aSide !== uSide) {
        flips += 1;
        continue;
      }
      sameSideCount += 1;
      if (a.covered !== null) sameSideAnchoredCovered += a.covered ? 1 : 0;
      if (u.covered !== null) sameSideUnanchoredCovered += u.covered ? 1 : 0;
      if (a.covered !== null && u.covered !== null && a.covered === u.covered) sameSideBothCovered += 1;
    }
    log(
      job,
      `of ${bothHaveOpeningLine} games with an opening line on both sides: ${flips} (${((flips / bothHaveOpeningLine) * 100).toFixed(1)}%) flipped pick side between anchored and unanchored -- this is the change-in-distribution-of-picks question.`,
    );
    log(
      job,
      `restricted to the ${sameSideCount} SAME-side-pick games: anchored cover rate=${((sameSideAnchoredCovered / sameSideCount) * 100).toFixed(1)}%, unanchored cover rate=${((sameSideUnanchoredCovered / sameSideCount) * 100).toFixed(1)}% -- if these two are close while the FULL-population cover rates differ more, the aggregate cover-rate shift is coming from WHICH side gets picked on the flipped games, not from better forecasting on the games both models agree on.`,
    );

    // Paired tests -- both models scored on the identical game_id set.
    const clvGameIds = commonGameIds.filter((id) => anchoredDetails.get(id)!.clv !== null && unanchoredDetails.get(id)!.clv !== null);
    if (clvGameIds.length >= 2) {
      const aClv = clvGameIds.map((id) => anchoredDetails.get(id)!.clv!);
      const uClv = clvGameIds.map((id) => unanchoredDetails.get(id)!.clv!);
      const paired = pairedTTest(aClv, uClv);
      log(
        job,
        `paired test, CLV (unanchored - anchored) on ${paired.n} identical games: mean diff=${paired.meanDiff.toFixed(4)}, t=${paired.tStatistic.toFixed(3)}, p=${paired.pValueTwoSided.toFixed(4)}`,
      );
    }
    const coveredGameIds = commonGameIds.filter((id) => anchoredDetails.get(id)!.covered !== null && unanchoredDetails.get(id)!.covered !== null);
    if (coveredGameIds.length >= 2) {
      const aCovered = coveredGameIds.map((id) => (anchoredDetails.get(id)!.covered ? 1 : 0));
      const uCovered = coveredGameIds.map((id) => (unanchoredDetails.get(id)!.covered ? 1 : 0));
      const paired = pairedTTest(aCovered, uCovered);
      log(
        job,
        `paired test, covered-as-0/1 (unanchored - anchored) on ${paired.n} identical games: mean diff=${paired.meanDiff.toFixed(4)}, t=${paired.tStatistic.toFixed(3)}, p=${paired.pValueTwoSided.toFixed(4)} -- ${
          paired.pValueTwoSided < 0.05 ? "statistically significant at p<0.05." : "NOT statistically significant."
        }`,
      );
    }

    // Games-played-bucketed breakdown -- the direct test of Part 2's premise.
    const gamesPlayedBySeason = new Map<number, Map<number, number>>();
    for (const season of [2023, 2024, 2025]) {
      gamesPlayedBySeason.set(season, await getCombinedGamesPlayedByGame("cfb", season));
    }
    // We don't have season per game_id here without another lookup -- check
    // all three seasons' maps for this gameId (game ids are globally unique,
    // so at most one map will have it).
    function combinedGamesPlayed(gameId: number): number | null {
      for (const map of gamesPlayedBySeason.values()) {
        const v = map.get(gameId);
        if (v !== undefined) return v;
      }
      return null;
    }

    const buckets: { label: string; min: number; max: number }[] = [
      { label: "0-8 (roughly weeks 1-4)", min: 0, max: 8 },
      { label: "9-16 (roughly weeks 5-8)", min: 9, max: 16 },
      { label: "17-24 (roughly weeks 9-12)", min: 17, max: 24 },
      { label: "25+ (late season)", min: 25, max: Infinity },
    ];
    log(job, "\nbucketed by COMBINED games played (home+away) at prediction time, not calendar week:");
    for (const bucket of buckets) {
      let n = 0;
      let anchoredCoveredCount = 0;
      let unanchoredCoveredCount = 0;
      let anchoredCoveredN = 0;
      let unanchoredCoveredN = 0;
      let anchoredClvSum = 0;
      let anchoredClvN = 0;
      let unanchoredClvSum = 0;
      let unanchoredClvN = 0;
      for (const id of commonGameIds) {
        const cgp = combinedGamesPlayed(id);
        if (cgp === null || cgp < bucket.min || cgp > bucket.max) continue;
        n += 1;
        const a = anchoredDetails.get(id)!;
        const u = unanchoredDetails.get(id)!;
        if (a.covered !== null) {
          anchoredCoveredN += 1;
          anchoredCoveredCount += a.covered ? 1 : 0;
        }
        if (u.covered !== null) {
          unanchoredCoveredN += 1;
          unanchoredCoveredCount += u.covered ? 1 : 0;
        }
        if (a.clv !== null) {
          anchoredClvN += 1;
          anchoredClvSum += a.clv;
        }
        if (u.clv !== null) {
          unanchoredClvN += 1;
          unanchoredClvSum += u.clv;
        }
      }
      log(
        job,
        `  ${bucket.label}: ${n} games -- anchored cover=${anchoredCoveredN > 0 ? ((anchoredCoveredCount / anchoredCoveredN) * 100).toFixed(1) + "%" : "n/a"} avgClv=${anchoredClvN > 0 ? (anchoredClvSum / anchoredClvN).toFixed(3) : "n/a"}; ` +
          `unanchored cover=${unanchoredCoveredN > 0 ? ((unanchoredCoveredCount / unanchoredCoveredN) * 100).toFixed(1) + "%" : "n/a"} avgClv=${unanchoredClvN > 0 ? (unanchoredClvSum / unanchoredClvN).toFixed(3) : "n/a"}`,
      );
    }
    log(
      job,
      "\nPrediction to check: unanchored should be clearly worse in the low-games-played buckets and comparable-or-better in the high ones. " +
        "If it's uniformly similar across all buckets instead, the anchor was never doing meaningful early-season work, and Part 2's preseason-prior justification is weaker than assumed.",
    );
  });
}

/**
 * INVALIDATED test, kept out of JOB_STARTERS: an earlier version of this
 * job swept priorShrinkK, which re-blended the prior season's rating into
 * the effective rating EVERY WEEK at prediction time (weight fading by
 * combined games played, but never reaching 0) -- a permanent stale-data
 * drag term, not a prior. Its monotonic decline as the weight increased was
 * the expected artifact of that bug, not a finding about whether prior-
 * season information helps. The mechanism (RatingParams.priorShrinkK,
 * elo.ts's shrinkTowardPrior, and the wiring in service.ts's
 * predictAndStoreWeek) has been fully reverted.
 *
 * This is the corrected version. A prior is a STARTING VALUE, not a
 * recurring term: computeAndStoreRatings (service.ts) builds an
 * `initialRatings` map ONCE per team by calling computeInitialRating (which
 * calls carryoverRating -- `priorRating * params.seasonCarryover`, i.e.
 * regression toward league-average 0, plus an spPriorWeight-weighted blend
 * with prior-season SP+), then computeSeasonRatings (elo.ts) seeds `state`
 * from that map ONE TIME at the top of the function and the per-game update
 * loop after that never reads `initialRatings` or any prior-season value
 * again -- confirmed by reading both functions directly, not inferred.
 * spPriorWeight itself is applied through this exact same one-time path
 * (computeInitialRating is called once per team, same as carryoverRating),
 * so the earlier "spPriorWeight hurts above ~0.3" sweep result (see
 * config.ts's history) WAS testing a real seed, not a drag term -- it
 * remains valid, corroborating evidence, not something this test needs to
 * redo.
 *
 * Because seasonCarryover already IS "how much of a team's prior-season
 * final rating carries into a one-time seed, the rest regressing to
 * league-average" -- exactly the mechanism asked for -- this sweeps that
 * one parameter rather than inventing a new one. seasonCarryover=0.6 is
 * literally today's default (current behavior); seasonCarryover=1.0 is the
 * raw, unregressed prior-season rating; seasonCarryover=0 is no seed at
 * all (every team starts at league average). These aren't three
 * independent strategies, they're three points on the one curve the
 * grid sweeps -- the honest framing, not three different code paths.
 * spPriorWeight is held at its current CFB default (0) throughout, since
 * that's a distinct external signal (SP+), not what's being tested here.
 *
 * Bucketed by combined games played, with FINER early buckets than the
 * anchor-removal breakdown used -- that breakdown's 0-8 bucket lumped a
 * team with zero prior games this season together with one four games in,
 * very different informational states for a SEED effect specifically,
 * which should matter most exactly at gamesPlayed=0 and fade quickly.
 *
 * Also logs, per season, how many teams actually receive a nonzero seed --
 * 2023 is this backtest's first season with NO prior-season ratings ever
 * computed (see README's "External ratings" section: "the backtest's first
 * season, with no prior-season ratings available"), so EVERY strategy
 * seeds EVERY team at 0 there regardless of seasonCarryover. That's a real
 * structural limitation of this comparison (2023's ~1/3 of games are
 * seed-invariant in every row of the sweep, diluting but not fabricating
 * any effect seen in 2024/2025) -- reported explicitly via a live query
 * rather than left for the reader to discover or just asserted from memory.
 */
export function startCfbSeedStrategySweepJob(): Promise<JobStatus> {
  return runJob("cfb-seed-strategy-sweep", async (job) => {
    log(
      job,
      "Seed-only prior test: seasonCarryover sweep (one-time week-0 seed via computeInitialRating/carryoverRating -- see elo.ts/service.ts -- with NO blending of prior-season info at any point after initialization). spPriorWeight held at the current CFB default (0) throughout, everything else at current CFB defaults.",
    );

    const base = getRatingParams("cfb");
    const carryoverGrid = [0, 0.2, 0.4, 0.6, 0.8, 1.0];
    const BASELINE_CARRYOVER = base.seasonCarryover;

    for (const season of [2023, 2024, 2025]) {
      const games = await getSeasonGamesForRating("cfb", season, 20);
      const teamIds = new Set<number>();
      for (const g of games) {
        teamIds.add(g.homeTeamId);
        teamIds.add(g.awayTeamId);
      }
      let withPrior = 0;
      for (const teamId of teamIds) {
        const priorRating = await getPriorSeasonFinalRating(teamId, "cfb", season - 1, "elo");
        if (priorRating !== undefined) withPrior += 1;
      }
      log(
        job,
        `seed coverage ${season}: ${withPrior}/${teamIds.size} teams have a prior-season (${season - 1}) final rating available -- these are the only teams any nonzero seasonCarryover actually affects; the rest seed at 0 in every row of this sweep.`,
      );
    }

    const gamesPlayedBySeason = new Map<number, Map<number, number>>();
    for (const season of [2023, 2024, 2025]) {
      gamesPlayedBySeason.set(season, await getCombinedGamesPlayedByGame("cfb", season));
    }
    function combinedGamesPlayed(gameId: number): number | null {
      for (const map of gamesPlayedBySeason.values()) {
        const v = map.get(gameId);
        if (v !== undefined) return v;
      }
      return null;
    }
    const buckets: { label: string; min: number; max: number }[] = [
      { label: "0-1", min: 0, max: 1 },
      { label: "2-3", min: 2, max: 3 },
      { label: "4-5", min: 4, max: 5 },
      { label: "6-7", min: 6, max: 7 },
      { label: "8-9", min: 8, max: 9 },
      { label: "10-13", min: 10, max: 13 },
      { label: "14-17", min: 14, max: 17 },
      { label: "18-21", min: 18, max: 21 },
      { label: "22+", min: 22, max: Infinity },
    ];

    const runsByCarryover = new Map<number, { runId: number; details: Awaited<ReturnType<typeof getBacktestGameDetails>> }>();

    for (const carryover of carryoverGrid) {
      const result = await runBacktest({
        name: `cfb-seed-strategy-sweep-carryover${carryover}`,
        sport: "cfb",
        seasonStart: 2023,
        seasonEnd: 2025,
        paramsOverride: { ...base, seasonCarryover: carryover },
      });
      const overall = await getOverallReport(result.backtestRunId);
      const opening = await getOpeningCoverRate(result.backtestRunId);
      const details = await getBacktestGameDetails(result.backtestRunId);
      runsByCarryover.set(carryover, { runId: result.backtestRunId, details });
      const tag =
        carryover === BASELINE_CARRYOVER
          ? " [current default]"
          : carryover === 1
            ? " [raw prior rating, no regression]"
            : carryover === 0
              ? " [no seed at all -- every team starts at league average]"
              : "";
      log(
        job,
        `seasonCarryover=${carryover}${tag}: ${result.scored} games, overall cover=${fmtPct(overall.coverRate)} avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(3)}, cover vs open=${fmtPct(opening.coverRateVsOpening)} (run ${result.backtestRunId})`,
      );
      for (const bucket of buckets) {
        let n = 0;
        let coveredCount = 0;
        let coveredN = 0;
        let clvSum = 0;
        let clvN = 0;
        for (const [id, d] of details) {
          const cgp = combinedGamesPlayed(id);
          if (cgp === null || cgp < bucket.min || cgp > bucket.max) continue;
          n += 1;
          if (d.covered !== null) {
            coveredN += 1;
            coveredCount += d.covered ? 1 : 0;
          }
          if (d.clv !== null) {
            clvN += 1;
            clvSum += d.clv;
          }
        }
        log(
          job,
          `  ${bucket.label}: ${n} games -- cover=${coveredN > 0 ? ((coveredCount / coveredN) * 100).toFixed(1) + "%" : "n/a"} avgClv=${clvN > 0 ? (clvSum / clvN).toFixed(3) : "n/a"}`,
        );
      }
    }

    const baselineRun = runsByCarryover.get(BASELINE_CARRYOVER)!;
    log(job, `\npaired tests vs. seasonCarryover=${BASELINE_CARRYOVER} (current default), identical game sets:`);
    for (const carryover of carryoverGrid) {
      if (carryover === BASELINE_CARRYOVER) continue;
      const variant = runsByCarryover.get(carryover)!;
      const commonGameIds = [...baselineRun.details.keys()].filter((id) => variant.details.has(id));
      const clvGameIds = commonGameIds.filter(
        (id) => baselineRun.details.get(id)!.clv !== null && variant.details.get(id)!.clv !== null,
      );
      if (clvGameIds.length >= 2) {
        const baseClv = clvGameIds.map((id) => baselineRun.details.get(id)!.clv!);
        const varClv = clvGameIds.map((id) => variant.details.get(id)!.clv!);
        const paired = pairedTTest(baseClv, varClv);
        log(
          job,
          `  seasonCarryover=${carryover}: CLV (variant - baseline) on ${paired.n} games: mean diff=${paired.meanDiff.toFixed(4)}, t=${paired.tStatistic.toFixed(3)}, p=${paired.pValueTwoSided.toFixed(4)}`,
        );
      }
      const coveredGameIds = commonGameIds.filter(
        (id) => baselineRun.details.get(id)!.covered !== null && variant.details.get(id)!.covered !== null,
      );
      if (coveredGameIds.length >= 2) {
        const baseCovered = coveredGameIds.map((id) => (baselineRun.details.get(id)!.covered ? 1 : 0));
        const varCovered = coveredGameIds.map((id) => (variant.details.get(id)!.covered ? 1 : 0));
        const paired = pairedTTest(baseCovered, varCovered);
        log(
          job,
          `  seasonCarryover=${carryover}: covered-as-0/1 (variant - baseline) on ${paired.n} games: mean diff=${paired.meanDiff.toFixed(4)}, t=${paired.tStatistic.toFixed(3)}, p=${paired.pValueTwoSided.toFixed(4)} -- ${
            paired.pValueTwoSided < 0.05 ? "statistically significant at p<0.05." : "NOT statistically significant."
          }`,
        );
      }
    }

    log(
      job,
      "\nThis differs structurally from the invalidated priorShrinkK version: the seed is applied ONCE, before any in-season game is processed, and never referenced again by computeSeasonRatings' update loop -- confirmed by code trace (see this function's doc), not just intent. There is no per-week drag term left to blame here, so a real decline as seasonCarryover increases would mean something genuine: that the model's own early-season EPA-based updates already do this better than any prior-season starting point. 2023's games are seed-invariant across every row of this sweep (see seed coverage above) -- that attenuates any real 2024/2025 effect when the three seasons are pooled, it does not fabricate one.",
    );
  });
}

/**
 * Step 3 of docs/prompts/returning-production-seed-adjustment.md: sweeps
 * returningProductionPoints the same way cfb-seed-strategy-sweep swept
 * seasonCarryover (seed applied ONCE at computeInitialRating, never
 * re-referenced by computeSeasonRatings' update loop -- see that
 * function's doc). Requires cfb-returning-production-ingest to have run.
 *
 * IMPORTANT difference from the seasonCarryover sweep, worth stating
 * explicitly rather than silently reusing that job's "2023 is seed-
 * invariant" framing: seasonCarryover needs season-1 data (absent for
 * 2023, this backtest's first season), but returning production is read
 * for THIS season directly (see getReturningProductionDistribution's doc)
 * -- CFBD has 2023 returning-production data, and computeInitialRating
 * applies the returningProductionPoints term unconditionally whenever a
 * deviation exists, independent of whether a carryover/SP+ base exists.
 * So 2023 is NOT inert here: its teams seed from "0 base +
 * returningProductionPoints * deviation" (no carryover), a genuinely
 * different regime from 2024/2025's "carryover+SP+ blend +
 * returningProductionPoints * deviation" -- pooling all three seasons
 * blindly would blur two different mechanisms together. Reports pooled
 * AND 2024-2025-only numbers side by side rather than assuming one
 * approximates the other.
 *
 * Buckets fold 22+ into 18-21 (n=33 in the prior sweep couldn't support
 * interpretation on its own).
 */
export function startCfbReturningProductionSweepJob(): Promise<JobStatus> {
  return runJob("cfb-returning-production-sweep", async (job) => {
    log(
      job,
      "Returning-production seed adjustment sweep: returningProductionPoints, seed applied ONCE via computeInitialRating, no post-init blending. Reporting pooled (2023-2025) AND 2024-2025-only numbers separately -- see this function's doc for why 2023 is NOT seed-invariant here, unlike the seasonCarryover sweep.",
    );

    const base = getRatingParams("cfb");
    const weightGrid = [0, 5, 10, 15, 20, 30, 50];
    const BASELINE_WEIGHT = 0;

    // Seed-coverage + league-average diagnostic, live per season -- the
    // exact numbers this sweep's centering math depends on.
    for (const season of [2023, 2024, 2025]) {
      const dist = await getReturningProductionDistribution("cfb", season);
      const values = [...dist.values()];
      const avg = values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : null;
      const min = values.length > 0 ? Math.min(...values) : null;
      const max = values.length > 0 ? Math.max(...values) : null;
      log(
        job,
        `returning-production coverage ${season}: ${dist.size} teams, league avg percentPPA=${avg === null ? "n/a" : avg.toFixed(3)}, range=[${min === null ? "n/a" : min.toFixed(3)}, ${max === null ? "n/a" : max.toFixed(3)}]`,
      );
    }

    const gamesPlayedBySeason = new Map<number, Map<number, number>>();
    const gameSeason = new Map<number, number>();
    for (const season of [2023, 2024, 2025]) {
      const m = await getCombinedGamesPlayedByGame("cfb", season);
      gamesPlayedBySeason.set(season, m);
      for (const gameId of m.keys()) gameSeason.set(gameId, season);
    }
    function combinedGamesPlayed(gameId: number): number | null {
      for (const map of gamesPlayedBySeason.values()) {
        const v = map.get(gameId);
        if (v !== undefined) return v;
      }
      return null;
    }
    const buckets: { label: string; min: number; max: number }[] = [
      { label: "0-1", min: 0, max: 1 },
      { label: "2-3", min: 2, max: 3 },
      { label: "4-5", min: 4, max: 5 },
      { label: "6-7", min: 6, max: 7 },
      { label: "8-9", min: 8, max: 9 },
      { label: "10-13", min: 10, max: 13 },
      { label: "14-17", min: 14, max: 17 },
      { label: "18+", min: 18, max: Infinity },
    ];

    function logBuckets(details: Awaited<ReturnType<typeof getBacktestGameDetails>>, only2024_25: boolean): void {
      for (const bucket of buckets) {
        let n = 0;
        let coveredCount = 0;
        let coveredN = 0;
        let clvSum = 0;
        let clvN = 0;
        for (const [id, d] of details) {
          if (only2024_25 && gameSeason.get(id) === 2023) continue;
          const cgp = combinedGamesPlayed(id);
          if (cgp === null || cgp < bucket.min || cgp > bucket.max) continue;
          n += 1;
          if (d.covered !== null) {
            coveredN += 1;
            coveredCount += d.covered ? 1 : 0;
          }
          if (d.clv !== null) {
            clvN += 1;
            clvSum += d.clv;
          }
        }
        log(
          job,
          `  ${bucket.label}: ${n} games -- cover=${coveredN > 0 ? ((coveredCount / coveredN) * 100).toFixed(1) + "%" : "n/a"} avgClv=${clvN > 0 ? (clvSum / clvN).toFixed(3) : "n/a"}`,
        );
      }
    }

    const runsByWeight = new Map<number, { runId: number; details: Awaited<ReturnType<typeof getBacktestGameDetails>> }>();

    for (const weight of weightGrid) {
      const result = await runBacktest({
        name: `cfb-returning-production-sweep-w${weight}`,
        sport: "cfb",
        seasonStart: 2023,
        seasonEnd: 2025,
        paramsOverride: { ...base, returningProductionPoints: weight },
      });
      const overall = await getOverallReport(result.backtestRunId);
      const opening = await getOpeningCoverRate(result.backtestRunId);
      const details = await getBacktestGameDetails(result.backtestRunId);
      runsByWeight.set(weight, { runId: result.backtestRunId, details });
      const tag = weight === BASELINE_WEIGHT ? " [current default -- no-op]" : "";
      log(
        job,
        `\nreturningProductionPoints=${weight}${tag}: ${result.scored} games, overall cover=${fmtPct(overall.coverRate)} avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(3)}, cover vs open=${fmtPct(opening.coverRateVsOpening)} (run ${result.backtestRunId})`,
      );
      log(job, " pooled (2023-2025):");
      logBuckets(details, false);
      log(job, " 2024-2025 only:");
      logBuckets(details, true);
    }

    const baselineRun = runsByWeight.get(BASELINE_WEIGHT)!;
    log(job, `\npaired tests vs. returningProductionPoints=${BASELINE_WEIGHT} (current default), identical game sets:`);
    for (const weight of weightGrid) {
      if (weight === BASELINE_WEIGHT) continue;
      const variant = runsByWeight.get(weight)!;
      for (const restrictTo2024_25 of [false, true]) {
        const label = restrictTo2024_25 ? "2024-2025 only" : "pooled";
        const commonGameIds = [...baselineRun.details.keys()].filter(
          (id) => variant.details.has(id) && (!restrictTo2024_25 || gameSeason.get(id) !== 2023),
        );
        const clvGameIds = commonGameIds.filter(
          (id) => baselineRun.details.get(id)!.clv !== null && variant.details.get(id)!.clv !== null,
        );
        if (clvGameIds.length >= 2) {
          const baseClv = clvGameIds.map((id) => baselineRun.details.get(id)!.clv!);
          const varClv = clvGameIds.map((id) => variant.details.get(id)!.clv!);
          const paired = pairedTTest(baseClv, varClv);
          log(
            job,
            `  returningProductionPoints=${weight} (${label}): CLV (variant - baseline) on ${paired.n} games: mean diff=${paired.meanDiff.toFixed(4)}, t=${paired.tStatistic.toFixed(3)}, p=${paired.pValueTwoSided.toFixed(4)}`,
          );
        }
        const coveredGameIds = commonGameIds.filter(
          (id) => baselineRun.details.get(id)!.covered !== null && variant.details.get(id)!.covered !== null,
        );
        if (coveredGameIds.length >= 2) {
          const baseCovered = coveredGameIds.map((id) => (baselineRun.details.get(id)!.covered ? 1 : 0));
          const varCovered = coveredGameIds.map((id) => (variant.details.get(id)!.covered ? 1 : 0));
          const paired = pairedTTest(baseCovered, varCovered);
          log(
            job,
            `  returningProductionPoints=${weight} (${label}): covered-as-0/1 (variant - baseline) on ${paired.n} games: mean diff=${paired.meanDiff.toFixed(4)}, t=${paired.tStatistic.toFixed(3)}, p=${paired.pValueTwoSided.toFixed(4)} -- ${
              paired.pValueTwoSided < 0.05 ? "statistically significant at p<0.05." : "NOT statistically significant."
            }`,
          );
        }
      }
    }

    log(
      job,
      "\nWhat would make this an implementation artifact, and what was checked: (1) the seed must be applied once, never re-referenced in-season -- true by construction, this reuses the exact code path cfb-seed-strategy-sweep validated for seasonCarryover, now extended with the same discipline for returningProductionPoints (see computeInitialRating's doc). (2) 2023 must NOT be silently treated as seed-invariant the way it was for seasonCarryover -- confirmed above it has real coverage and a real league average, and pooled vs. 2024-2025-only numbers are reported separately rather than assuming they'd match. (3) the late-games-played bucket should still wash out to the same value across every weight in this sweep, same non-artifact signature the carryover sweep showed at its 22+ bucket -- check the 18+ row above for that. Do not chase a non-significant delta into adopting a nonzero weight -- this project's convention throughout has been to leave defaults alone absent significance.",
    );
  });
}

/**
 * Step 4 (the actual deliverable) of
 * docs/prompts/returning-production-seed-adjustment.md: a week-0 2025 seed
 * table with the returning-production adjustment applied, for eyeballing
 * -- independent of whether returningProductionPoints calibrates to
 * anything significant (per cfb-returning-production-sweep, it doesn't:
 * every paired test came back non-significant across the whole 0-50 grid,
 * pooled and 2024-2025-only alike). Uses an illustrative nonzero weight
 * (20, mid-grid) purely to make the adjustment's DIRECTION and MAGNITUDE
 * visible per team, not as a calibration recommendation -- the sweep
 * result says leave returningProductionPoints at its actual default (0).
 * Sorted by delta (descending) so the biggest movers in both directions
 * are easy to scan from either end of the table.
 */
export function startCfbReturningProductionWeek1TableJob(): Promise<JobStatus> {
  return runJob("cfb-returning-production-week1-table", async (job) => {
    const ILLUSTRATIVE_WEIGHT = 20;
    const season = 2025;
    const base = getRatingParams("cfb");
    const illustrativeParams = { ...base, returningProductionPoints: ILLUSTRATIVE_WEIGHT };

    const teamNameToId = await getTeamNameToIdMap("cfb");
    const teamIdToName = new Map([...teamNameToId.entries()].map(([name, id]) => [id, name]));

    const returningProduction = await getReturningProductionDistribution("cfb", season);
    const rpValues = [...returningProduction.values()];
    const leagueAverage = rpValues.length > 0 ? rpValues.reduce((s, v) => s + v, 0) / rpValues.length : undefined;
    log(job, `${season} returning-production league average percentPPA=${leagueAverage === null ? "n/a" : leagueAverage!.toFixed(3)}, ${returningProduction.size} teams covered`);

    interface Row {
      team: string;
      priorRating: number | undefined;
      returningProduction: number | undefined;
      baseSeed: number;
      adjustedSeed: number;
      delta: number;
    }
    const rows: Row[] = [];
    for (const [teamId, rpValue] of returningProduction) {
      const priorRating = await getPriorSeasonFinalRating(teamId, "cfb", season - 1, "elo");
      const priorSp = await getPriorSeasonSpRating(teamId, season - 1);
      const deviation = leagueAverage !== undefined ? rpValue - leagueAverage : undefined;
      const baseSeed = computeInitialRating(priorRating, priorSp, undefined, base);
      const adjustedSeed = computeInitialRating(priorRating, priorSp, deviation, illustrativeParams);
      rows.push({
        team: teamIdToName.get(teamId) ?? `team_${teamId}`,
        priorRating,
        returningProduction: rpValue,
        baseSeed,
        adjustedSeed,
        delta: adjustedSeed - baseSeed,
      });
    }
    rows.sort((a, b) => b.delta - a.delta);

    log(job, `\nweek-0 ${season} seed table, illustrative returningProductionPoints=${ILLUSTRATIVE_WEIGHT} -- sorted by delta, biggest positive movers first:`);
    log(job, "team                 priorRating  percentPPA  baseSeed  adjustedSeed  delta");
    for (const r of rows) {
      log(
        job,
        [
          r.team.padEnd(20).slice(0, 20),
          (r.priorRating === undefined ? "n/a" : r.priorRating.toFixed(2)).padStart(11),
          r.returningProduction!.toFixed(3).padStart(10),
          r.baseSeed.toFixed(2).padStart(8),
          r.adjustedSeed.toFixed(2).padStart(12),
          (r.delta >= 0 ? "+" : "") + r.delta.toFixed(2),
        ].join("  "),
      );
    }

    log(
      job,
      "\nEyeball check: for the teams with the LARGEST NEGATIVE delta (bottom of the table -- lowest returning production relative to league average), are any of them known 2024 portal-reload programs (heavy transfer-IN activity that offset heavy departures)? Returning production only measures who's LEAVING -- it's structurally blind to who's arriving via the portal. A team that looks wrong here (large negative delta despite being a known strong 2025 roster on public preseason rankings) is the concrete signal that portal ingestion is worth building next, rather than an a priori argument for it.",
    );
  });
}

/**
 * Ingests turnover-play PPA sums + counts for CFB 2023-2025 via CFBD's
 * /plays endpoint -- a different endpoint than every other ingestion job
 * here, requiring one call per week rather than per season (see
 * client.ts's getPlays doc), so this is ~15 calls per year (~45 total) vs.
 * the usual 1. Run this BEFORE cfb-turnover-sweep or cfb-turnover-
 * walkforward; without it, RatingParams.turnoverLuckWeight is a silent
 * per-field no-op (every game falls back to raw EPA). Regular season only
 * (weeks 1-15) -- postseason bowls aren't covered yet, same gap as
 * cfb-garbage-time-ingest.
 */
export function startCfbTurnoverIngestJob(): Promise<JobStatus> {
  return runJob("cfb-turnover-ingest", async (job) => {
    for (const year of [2023, 2024, 2025]) {
      log(job, `${year}: turnover-play stats (weeks 1-15)`);
      const result = await syncCfbdTurnoverStats(year);
      log(job, `${year}: synced ${result.synced}, skipped ${result.skipped}`);
    }
  });
}

/**
 * Sweeps turnoverLuckWeight -- turnover-play PPA stripped out of each
 * side's EPA average (see backtest/sweep.ts's runTurnoverLuckSweep and
 * RatingParams doc). Requires cfb-turnover-ingest to have run first.
 */
export function startCfbTurnoverLuckSweepJob(): Promise<JobStatus> {
  return runJob("cfb-turnoverluck-sweep", async (job) => {
    log(job, "sweeping cfb turnoverLuckWeight, 2023-2025");
    const results = await runTurnoverLuckSweep("cfb", 2023, 2025);
    for (const r of results) {
      log(job, `turnoverLuckWeight=${r.turnoverLuckWeight}: ${r.games} games, cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)} (run ${r.runId})`);
    }
  });
}

/**
 * Walk-forward validation for turnoverLuckWeight, same discipline as every
 * other rating-param change this session: train (sweep) on 2023-2024 only,
 * then score the winning weight on the untouched 2025 season. Requires
 * cfb-turnover-ingest to have run first.
 */
export function startCfbTurnoverLuckWalkforwardJob(): Promise<JobStatus> {
  return runJob("cfb-turnoverluck-walkforward", async (job) => {
    log(job, "training: sweeping turnoverLuckWeight on 2023-2024 only");
    const trainResults = await runTurnoverLuckSweep("cfb", 2023, 2024);
    for (const r of trainResults) {
      log(job, `train: turnoverLuckWeight=${r.turnoverLuckWeight}: cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)} (run ${r.runId})`);
    }
    const best = trainResults[0]!; // runTurnoverLuckSweep sorts desc by coverRate
    log(job, `best training weight: turnoverLuckWeight=${best.turnoverLuckWeight} (train cover ${fmtPct(best.coverRate)})`);

    log(job, "holdout: running 2025-only backtest with training-selected weight");
    const base = getRatingParams("cfb");
    const paramsOverride = { ...base, turnoverLuckWeight: best.turnoverLuckWeight };
    const holdout = await runBacktest({
      name: "cfb-turnoverluck-walkforward-holdout-2025",
      sport: "cfb",
      seasonStart: 2025,
      seasonEnd: 2025,
      paramsOverride,
    });
    const overall = await getOverallReport(holdout.backtestRunId);
    const openingCover = await getOpeningCoverRate(holdout.backtestRunId);
    log(
      job,
      `holdout 2025: ${holdout.scored} games, cover vs close=${fmtPct(overall.coverRate)}, ` +
        `cover vs open=${fmtPct(openingCover.coverRateVsOpening)} (${openingCover.games} games w/ opening line), ` +
        `avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(2)} (run ${holdout.backtestRunId})`,
    );
    log(job, "compare against cfb-successrate-walkforward's holdout for the equivalent number without this signal: cover vs close=48.7%, cover vs open=50.7%, avgClv=0.87.");
  });
}

/**
 * Answers a different question than every sweep tonight: not "does a new
 * signal beat the baseline overall," but "does the model already make
 * money on the subset of picks it's most confident about" — using
 * TODAY's default cfb params (successRateWeight=0.75 adopted;
 * opponentAdjustWeight/pointsPerRestDay/turnoverLuckWeight all swept flat
 * and left at 0), not a param override. Reports BOTH getConfidenceReport
 * (cover vs. CLOSING line — diagnostic, what the earlier bigSpreadShrinkRef
 * investigation already looked at, see README) and the new
 * getConfidenceReportVsOpening (cover vs. OPENING line — the actual
 * "would this have made money" question, which nothing before tonight
 * checked broken out by confidence). In-sample only; see
 * cfb-confidence-walkforward for the real test.
 */
export function startCfbConfidenceReportJob(): Promise<JobStatus> {
  return runJob("cfb-confidence-report", async (job) => {
    log(job, "running cfb 2023-2025 backtest with today's default params");
    const holdout = await runBacktest({ name: "cfb-confidence-report-2023-2025", sport: "cfb", seasonStart: 2023, seasonEnd: 2025 });
    log(job, `${holdout.scored} games scored (run ${holdout.backtestRunId})`);

    const closing = await getConfidenceReport(holdout.backtestRunId);
    for (const c of closing) {
      log(job, `[vs close] confidence<=${c.maxConfidence}: ${c.games} games, cover=${fmtPct(c.coverRate)}, avgClv=${c.avgClv === null ? "n/a" : c.avgClv.toFixed(2)}`);
    }

    const opening = await getConfidenceReportVsOpening(holdout.backtestRunId);
    for (const c of opening) {
      log(job, `[vs open, the real question] confidence<=${c.maxConfidence}: ${c.games} games, cover=${fmtPct(c.coverRateVsOpening)}`);
    }
    log(job, "breakeven vs. standard -110 vig is ~52.4% — that's the bar the [vs open] numbers need to clear, and only trust a bucket with a real sample (30+ games).");
  });
}

/**
 * Walk-forward validation for the confidence-filter idea above, same
 * discipline as every other rating-param change tonight: pick the best
 * confidence ceiling on 2023-2024 (restricted to buckets with >=30 games,
 * so a tiny high-confidence sample can't win on noise alone), then check
 * that EXACT ceiling against the untouched 2025 season.
 *
 * RESULT (run 2026-08-21): the in-sample trend looked real and monotonic
 * -- cover vs open climbed from 52.7% (confidence<=8, near-unfiltered) to
 * 54.9% (confidence<=2.5, 436 games) across the full 2023-2025 sample
 * (cfb-confidence-report). Training on 2023-2024 alone picked
 * confidence<=2.5 as best (57.6% train cover, 273 games) -- but that exact
 * ceiling scored only 50.3% on the untouched 2025 holdout (163 games),
 * WORSE than the unfiltered 2025 baseline (50.7%) and well under the
 * ~52.4% breakeven. Did not survive walk-forward -- same conclusion as
 * opponentAdjustWeight/pointsPerRestDay/turnoverLuckWeight tonight: the
 * in-sample trend was very likely overfit noise (best-of-6-ceilings on a
 * modest 273-game training sample is exactly the kind of multiple-
 * comparisons risk this project's whole walk-forward discipline exists to
 * catch), not a real, robust "the model already makes money on its most
 * confident picks" edge. No RatingParams change to make here (this is a
 * reporting lens, not a model input) -- just a finding: confidence, as
 * currently computed (games-played + market-spread-size), isn't a
 * profitable filter on its own.
 */
export function startCfbConfidenceWalkforwardJob(): Promise<JobStatus> {
  return runJob("cfb-confidence-walkforward", async (job) => {
    log(job, "training: sweeping confidence ceilings (vs. opening line) on 2023-2024 only");
    const train = await runBacktest({ name: "cfb-confidence-walkforward-train-2023-2024", sport: "cfb", seasonStart: 2023, seasonEnd: 2024 });
    const trainReport = await getConfidenceReportVsOpening(train.backtestRunId);
    for (const c of trainReport) {
      log(job, `train: confidence<=${c.maxConfidence}: ${c.games} games, cover=${fmtPct(c.coverRateVsOpening)}`);
    }
    const eligible = trainReport.filter((c) => c.games >= 30);
    if (eligible.length === 0) {
      log(job, "no confidence ceiling had >=30 games in the training set -- stopping, nothing trustworthy to hold out");
      return;
    }
    const best = eligible.reduce((a, b) => ((b.coverRateVsOpening ?? -1) > (a.coverRateVsOpening ?? -1) ? b : a));
    log(job, `best training ceiling: confidence<=${best.maxConfidence} (train cover vs open ${fmtPct(best.coverRateVsOpening)}, ${best.games} games)`);

    log(job, "holdout: checking that exact ceiling against the untouched 2025 season");
    const holdout = await runBacktest({ name: "cfb-confidence-walkforward-holdout-2025", sport: "cfb", seasonStart: 2025, seasonEnd: 2025 });
    const holdoutReport = await getConfidenceReportVsOpening(holdout.backtestRunId, [best.maxConfidence]);
    const holdoutStat = holdoutReport[0]!;
    log(
      job,
      `holdout 2025 at confidence<=${best.maxConfidence}: ${holdoutStat.games} games, cover vs open=${fmtPct(holdoutStat.coverRateVsOpening)} ` +
        `(compare: unfiltered 2025 holdout was 50.7% vs open on cfb-successrate-walkforward; breakeven vs. -110 vig is ~52.4%)`,
    );
  });
}


/**
 * Re-runs the CFB baseline excluding week 14+ (rivalry week / conference
 * championships — NOT real bowl games, this project has never ingested
 * postseason data, see README "Segment breakdowns") and reports overall
 * stats for direct comparison against run 152 (the all-weeks-included
 * baseline: 49.9% cover vs. close, 52.8% vs. open, 2051 games w/ opening
 * line, avgClv 0.62).
 */
export function startCfbNoRivalryWeekJob(): Promise<JobStatus> {
  return runJob("cfb-no-rivalry-week", async (job) => {
    log(job, "running CFB backtest 2023-2025, excluding week 14+");
    const summary = await runBacktest({
      name: "cfb-exclude-week14plus",
      sport: "cfb",
      seasonStart: 2023,
      seasonEnd: 2025,
      excludeFromWeek: 14,
    });
    const runId = summary.backtestRunId;
    log(job, `scored ${summary.scored}, skipped ${summary.skippedNoOdds}, run id ${runId}`);
    const overall = await getOverallReport(runId);
    const openingCover = await getOpeningCoverRate(runId);
    log(
      job,
      `excluding week 14+: cover vs close=${fmtPct(overall.coverRate)}, cover vs open=${fmtPct(openingCover.coverRateVsOpening)} ` +
        `(${openingCover.games} games w/ opening line), avgClv=${overall.avgClv === null ? "n/a" : overall.avgClv.toFixed(2)}`,
    );
    log(job, "compare against run 152 (all weeks): cover vs close=49.9%, cover vs open=52.8% (2051 games), avgClv=0.62");
  });
}

/**
 * Historical weather backfill for both sports (NFL via team-to-stadium map,
 * CFB via CFBD's own venue_id per game — see ingest/weather/syncWeather.ts
 * and ingest/cfbd/syncHistoricalWeather.ts docs). Both UNVERIFIED — check
 * ingested temp/wind/precip values land in a plausible range before
 * trusting the weather segment reports. Needed before cfb-weather-segments
 * or an NFL equivalent will show anything (weather table starts empty for
 * historical games — the live sync only ever covered upcoming games).
 */
export function startWeatherBackfillJob(): Promise<JobStatus> {
  return runJob("weather-backfill", async (job) => {
    log(job, "NFL: historical weather 2023-2025");
    const nfl = await syncNflHistoricalWeather(2023, 2025);
    log(job, `NFL: synced ${nfl.synced}, skipped ${nfl.skipped}`);
    for (const year of [2023, 2024, 2025]) {
      log(job, `CFB ${year}: historical weather`);
      const cfb = await syncCfbdHistoricalWeather(year);
      log(job, `CFB ${year}: synced ${cfb.synced}, skipped ${cfb.skipped}`);
    }
  });
}

/**
 * Key-number and weather/precipitation breakdowns against a fresh CFB
 * backtest with today's validated defaults. Weather buckets will be empty
 * (0 games) until weather-backfill has actually run — key numbers don't
 * need any new data, they're computed from odds already ingested.
 */
export function startCfbMoreSegmentsJob(): Promise<JobStatus> {
  return runJob("cfb-more-segments", async (job) => {
    log(job, "running fresh CFB backtest 2023-2025 with validated defaults");
    const summary = await runBacktest({ name: "cfb-more-segments-baseline", sport: "cfb", seasonStart: 2023, seasonEnd: 2025 });
    const runId = summary.backtestRunId;
    log(job, `scored ${summary.scored}, skipped ${summary.skippedNoOdds}, run id ${runId}`);

    log(job, "--- by key number ---");
    for (const r of await getKeyNumberReport(runId)) {
      log(job, `${r.keyNumberBucket}: ${r.games} games, cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)}`);
    }

    log(job, "--- by wind ---");
    for (const r of await getWeatherReport(runId)) {
      log(job, `${r.weatherBucket}: ${r.games} games, cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)}`);
    }

    log(job, "--- by precipitation ---");
    for (const r of await getPrecipitationReport(runId)) {
      log(job, `${r.weatherBucket}: ${r.games} games, cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)}`);
    }
  });
}

export const JOB_STARTERS: Record<string, () => Promise<JobStatus>> = {
  "nfl-backtest-refresh": startNflBacktestJob,
  "cfb-pipeline": startCfbPipelineJob,
  "nfl-sweep": startNflSweepJob,
  "cfb-sweep": startCfbSweepJob,
  "cfb-external-ratings": startCfbExternalRatingsJob,
  "cfb-returning-production-ingest": startCfbReturningProductionIngestJob,
  "cfb-external-sweep": startCfbExternalSweepJob,
  "cfb-walkforward": startCfbWalkforwardJob,
  "cfb-walkforward-no-rivalry": startCfbWalkforwardNoRivalryJob,
  "cfb-segments": startCfbSegmentsJob,
  "cfb-sos-sweep": startCfbSosSweepJob,
  "cfb-spsignal-sweep": startCfbSpSignalSweepJob,
  "cfb-successrate-sweep": startCfbSuccessRateSweepJob,
  "cfb-successrate-walkforward": startCfbSuccessRateWalkforwardJob,
  "cfb-garbage-time-ingest": startCfbGarbageTimeIngestJob,
  "cfb-garbagetime-sweep": startCfbGarbageTimeSweepJob,
  "cfb-garbagetime-walkforward": startCfbGarbageTimeWalkforwardJob,
  "cfb-garbagetime-holdout-paired-test": startCfbGarbageTimeHoldoutPairedTestJob,
  "cfb-team-rating-delta-diagnostic": startCfbTeamRatingDeltaDiagnosticJob,
  "cfb-pennstate-rating-delta-diagnostic": startCfbPennStateRatingDeltaDiagnosticJob,
  "cfb-clemson-rating-delta-diagnostic": startCfbClemsonRatingDeltaDiagnosticJob,
  "cfb-oppadjust-sweep": startCfbOpponentAdjustSweepJob,
  "cfb-oppadjust-walkforward": startCfbOpponentAdjustWalkforwardJob,
  "cfb-restday-sweep": startCfbRestDaySweepJob,
  "cfb-restday-walkforward": startCfbRestDayWalkforwardJob,
  "cfb-turnover-ingest": startCfbTurnoverIngestJob,
  "cfb-turnoverluck-sweep": startCfbTurnoverLuckSweepJob,
  "cfb-turnoverluck-walkforward": startCfbTurnoverLuckWalkforwardJob,
  "cfb-manual-sp-ingest": startCfbManualSpIngestJob,
  "cfb-weeklyspsignal-sweep": startCfbWeeklySpSignalSweepJob,
  "cfb-component-ingest": startCfbComponentIngestJob,
  "cfb-component-sweep-explosiveness": startCfbComponentSweepExplosivenessJob,
  "cfb-component-sweep-standarddowns": startCfbComponentSweepStandardDownsJob,
  "cfb-component-sweep-passingdowns": startCfbComponentSweepPassingDownsJob,
  "cfb-component-sweep-sackrate": startCfbComponentSweepSackRateJob,
  "cfb-finishingdrives-ingest": startCfbFinishingDrivesIngestJob,
  "cfb-finishingdrives-diagnose": startCfbFinishingDrivesDiagnoseJob,
  "cfb-component-sweep-finishingdrives": startCfbComponentSweepFinishingDrivesJob,
  "cfb-specialteams-ingest": startCfbSpecialTeamsIngestJob,
  "cfb-opponentadjusted-ingest": startCfbOpponentAdjustedIngestJob,
  "cfb-rawplays-ingest": startCfbRawPlaysIngestJob,
  "cfb-component-sweep-fieldposition": startCfbComponentSweepFieldPositionJob,
  "cfb-component-sweep-fgmakerate": startCfbComponentSweepFgMakeRateJob,
  "cfb-component-sweep-opponentadj": startCfbComponentSweepOpponentAdjJob,
  "cfb-component-sweep-errorcap": startCfbComponentSweepErrorCapJob,
  "cfb-errorcap-paired-test": startCfbErrorCapPairedTestJob,
  "cfb-component-sweep-varianceshrink": startCfbComponentSweepVarianceShrinkJob,
  "cfb-varianceshrink-paired-test": startCfbVarianceShrinkPairedTestJob,
  "cfb-variance-facevalidity": startCfbVarianceFaceValidityJob,
  "cfb-recompute-ratings": startCfbRecomputeRatingsJob,
  "cfb-opponentadj-paired-test": startCfbOpponentAdjPairedTestJob,
  "cfb-walkforward-allcomponents": startCfbWalkforwardAllComponentsJob,
  "cfb-jointrefit-holdout": startCfbJointRefitHoldoutJob,
  "cfb-jointrefit-predictive-holdout": startCfbJointRefitPredictiveHoldoutJob,
  "cfb-jointrefit-conditional-epa": startCfbJointRefitConditionalEpaJob,
  "cfb-clv-naive-baseline": startCfbClvNaiveBaselineJob,
  "cfb-clv-frozen-ratings": startCfbClvFrozenRatingsJob,
  "cfb-unanchored-rebaseline": startCfbUnanchoredRebaselineJob,
  "cfb-anchor-removal-breakdown": startCfbAnchorRemovalBreakdownJob,
  "cfb-seed-strategy-sweep": startCfbSeedStrategySweepJob,
  "cfb-returning-production-sweep": startCfbReturningProductionSweepJob,
  "cfb-returning-production-week1-table": startCfbReturningProductionWeek1TableJob,
  "cfb-clv-placebo": startCfbClvPlaceboJob,
  "cfb-2025-check": startCfb2025CheckJob,
  "cfb-confidence-report": startCfbConfidenceReportJob,
  "cfb-confidence-walkforward": startCfbConfidenceWalkforwardJob,
  "cfb-no-rivalry-week": startCfbNoRivalryWeekJob,
  "weather-backfill": startWeatherBackfillJob,
  "cfb-more-segments": startCfbMoreSegmentsJob,
  "cfb-playtype-discover": startCfbPlayTypeDiscoverJob,
  "cfb-verify-plays": startCfbVerifyPlaysJob,
  "cfb-verify-returning-production": startCfbVerifyReturningProductionJob,
  "cfb-opponent-adjust-snapshot": startCfbOpponentAdjustSnapshotJob,
  "cfb-solve-vs-elo-vs-sp-diagnostic": startSolveVsEloVsSpDiagnosticJob,
  "cfb-solve-vs-elo-vs-sp-widened-diagnostic": startSolveVsEloVsSpWidenedDiagnosticJob,
  "cfb-solve-coldstart-test": startSolveColdStartTestJob,
  "cfb-solve-epa-hypothesis-test": startSolveEpaHypothesisTestJob,
  "cfb-solve-prior-weight-test": startSolvePriorWeightTestJob,
  "cfb-solve-prior-weight-full-checkpoint-test": startSolvePriorWeightFullCheckpointTestJob,
  "cfb-persist-epa-solve-2023": startCfbPersistFinalEpaSolveJob(2023),
  "cfb-persist-epa-solve-2024": startCfbPersistFinalEpaSolveJob(2024),
  "cfb-persist-epa-solve-2025": startCfbPersistFinalEpaSolveJob(2025),
};

/**
 * One-off diagnostic: pulls a single real week of CFB play-by-play and
 * tabulates distinct play_type values by count, so the turnover-luck
 * feature's play-type filter can be built against what CFBD ACTUALLY
 * returns rather than a guessed list -- CFBD's play types are a lookup
 * table in their own database, not a fixed enum in any client library, and
 * this sandbox has no route to their docs site or a live API response to
 * check against otherwise. Delete this job once the real filter is known
 * and built into the turnover ingestion -- it's throwaway, not part of the
 * permanent architecture.
 */
export function startCfbPlayTypeDiscoverJob(): Promise<JobStatus> {
  return runJob("cfb-playtype-discover", async (job) => {
    log(job, "pulling 2024 week 8 plays to inspect real play_type values");
    const plays = await getPlays(2024, 8);
    log(job, `${plays.length} total plays returned`);

    const counts = new Map<string, number>();
    for (const play of plays) {
      counts.set(play.playType, (counts.get(play.playType) ?? 0) + 1);
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [playType, count] of sorted) {
      log(job, `${count}x  "${playType}"`);
    }

    // Also surface a few sample plays whose type LOOKS turnover-related
    // (case-insensitive substring match on common football terms), with
    // their full text, as a sanity check on the exact wording before
    // committing to a filter.
    const candidates = plays.filter((p) => /fumble|intercept/i.test(p.playType));
    log(job, `${candidates.length} plays with a play_type matching /fumble|intercept/i`);
    for (const p of candidates.slice(0, 10)) {
      log(job, `  sample: playType="${p.playType}" offense=${p.offense} defense=${p.defense} ppa=${p.ppa}`);
    }
  });
}

/**
 * One-off diagnostic (throwaway, same spirit as cfb-playtype-discover):
 * pulls one real game's box score (/games), raw plays (/plays), and win
 * probability (/metrics/wp) and logs them side by side so a human can
 * hand-verify CFBD's actual data contract against a real box score/
 * broadcast before trusting the `plays` table (migration 0012) for
 * anything downstream -- playSuccess.ts, garbageTime.ts, and
 * opponentAdjust.ts were all built and unit-tested against synthetic
 * fixtures only, never against a real CFBD response (this sandbox has no
 * network route to CFBD's API). Local equivalent with a caller-chosen
 * game: src/ingest/cfbd/verifyRawPlays.ts.
 *
 * Job triggers take no params (see server.ts's POST /admin/jobs/:name),
 * so the game is picked deterministically rather than passed in: 2024
 * week 8's highest-combined-score completed FBS game -- pick one you can
 * independently verify the final score of (e.g. via a search engine) to
 * confirm /games itself is trustworthy before checking /plays against it.
 * Delete this job once the plays table has been trusted and built on.
 */
export function startCfbVerifyPlaysJob(): Promise<JobStatus> {
  return runJob("cfb-verify-plays", async (job) => {
    const year = 2024;
    const week = 8;

    // getGames's `division: "fbs"` param does NOT actually filter
    // server-side (confirmed against a real response the first time this
    // job ran: it returned 306 "completed" week-8 games spanning FBS down
    // to D3/NAIA). This is the exact same gotcha syncTeams.ts's comment
    // already documents for /teams -- the real ingestion path
    // (syncGames.ts) is unaffected because it resolves teams by ID
    // against the FBS-only `teams` table and drops anything that doesn't
    // resolve, but this diagnostic picks a game directly from the raw
    // response, so it needs the same client-side FBS filter.
    log(job, `fetching ${year} teams to build an FBS name filter`);
    const teams = await getTeams(year);
    const fbsNames = new Set(teams.filter((t) => t.classification === "fbs").map((t) => t.school));
    log(job, `${fbsNames.size} FBS teams found`);

    log(job, `fetching ${year} games to find week ${week}'s slate`);
    const games = await getGames(year);
    const weekGames = games.filter((g) => g.week === week && g.completed && fbsNames.has(g.homeTeam) && fbsNames.has(g.awayTeam));
    log(job, `${weekGames.length} completed FBS-vs-FBS games in week ${week}`);
    for (const g of weekGames) {
      log(job, `  ${g.awayTeam} ${g.awayPoints} @ ${g.homeTeam} ${g.homePoints}  (gameId=${g.id})`);
    }

    const target = [...weekGames].sort(
      (a, b) => (b.homePoints ?? 0) + (b.awayPoints ?? 0) - ((a.homePoints ?? 0) + (a.awayPoints ?? 0)),
    )[0];
    if (!target) {
      log(job, "no completed games found for this week -- nothing to verify");
      return;
    }
    log(job, `\ndeep-diving the highest-combined-score game: ${target.awayTeam} @ ${target.homeTeam} (gameId=${target.id})`);
    log(job, `Google/verify this final score independently before trusting anything below: ${target.awayTeam} ${target.awayPoints} @ ${target.homeTeam} ${target.homePoints}`);

    const allPlays = await getPlays(year, week);
    const gamePlays = allPlays.filter((p) => p.gameId === target.id);
    log(job, `${gamePlays.length} total plays found for this game`);

    // Join key is playId (wp) <-> id (play), NOT playNumber on either side
    // -- confirmed real (cfb-verify-plays run #4, 2026-08-21): wp.playId
    // matched play.id exactly with matching down/distance on every pair
    // checked, while wp.playNumber turned out to be the WP model's own
    // unrelated internal sequential index. Types differ across endpoints
    // (playId: number vs CfbdPlay.id: string), so key on the string form.
    let wpByPlayId = new Map<string, CfbdPlayWinProbability>();
    let wpRows: CfbdPlayWinProbability[] = [];
    try {
      wpRows = await getWinProbabilityData(target.id);
      wpByPlayId = new Map(wpRows.map((row) => [String(row.playId), row]));
      log(job, `${wpRows.length} win-probability rows found`);
    } catch (err) {
      log(job, `could not fetch win probability data: ${(err as Error).message} -- continuing without it`);
    }

    const maxPlays = 20;
    const shown = gamePlays.slice(0, maxPlays);
    log(job, `\nfirst ${shown.length} of ${gamePlays.length} plays -- hand-check against the real box score/broadcast:`);
    log(job, "period clock  off        def        down-dist yards playType                  score(off-def) ppa     scoring wp(home) wp-down-dist wp-score(h-a)");
    for (const play of shown) {
      const clock = play.clock ? `${play.clock.minutes}:${String(play.clock.seconds ?? 0).padStart(2, "0")}` : "?";
      const wpRow = wpByPlayId.get(play.id);
      const wpStr = wpRow ? (wpRow.homeWinProb == null ? "null" : wpRow.homeWinProb.toFixed(3)) : "(none)";
      log(
        job,
        [
          String(play.period).padEnd(6),
          clock.padEnd(6),
          play.offense.padEnd(10).slice(0, 10),
          play.defense.padEnd(10).slice(0, 10),
          `${play.down}-${play.distance}`.padEnd(9),
          String(play.yardsGained).padEnd(5),
          play.playType.padEnd(25).slice(0, 25),
          `${play.offenseScore}-${play.defenseScore}`.padEnd(14),
          String(play.ppa ?? "null").padEnd(7),
          String(play.scoring).padEnd(7),
          wpStr.padEnd(8),
          wpRow ? `${wpRow.down}-${wpRow.distance}`.padEnd(12) : "(none)".padEnd(12),
          wpRow ? `${wpRow.homeScore}-${wpRow.awayScore}` : "(none)",
        ].join(" "),
      );
    }

    log(job, "\nCheck, against the real game:");
    log(job, "  1. Does offenseScore/defenseScore match the real running score at each play?");
    log(job, "  2. On a turnover play (interception/fumble), is \"offense\" still the team that HAD the ball, not the recovering team?");
    log(job, "  3. Does ppa's sign make sense (positive on a good gain/TD, negative on a sack/turnover/loss)?");
    log(job, "  4. If wp(home) printed: does it look like a PRE-play or POST-play probability relative to the down/distance/score on the same row?");
    log(job, "  5. Does playType match a value in playSuccess.ts's SCRIMMAGE_PLAY_TYPES where it should (and NOT where it's actually a punt/kickoff/penalty/etc.)?");
  });
}

/**
 * Hand-verification pass for CFBD's /player/returning (see
 * getReturningProduction's doc in client.ts for the field list, sourced
 * from CFBD's official Python client since this sandbox has no network
 * route to CFBD's own API) -- same standard as cfb-verify-plays, run
 * before Step 2 (wiring returning production into the week-0 seed) per
 * docs/prompts/returning-production-seed-adjustment.md. Checks: real
 * values for a few known teams (hand-check against public reporting),
 * team-name resolution against our own teams table, per-season coverage
 * count, and a basic scale/range sanity check on percentPPA/usage.
 */
export function startCfbVerifyReturningProductionJob(): Promise<JobStatus> {
  return runJob("cfb-verify-returning-production", async (job) => {
    const teamNameToId = await getTeamNameToIdMap("cfb");
    log(job, `${teamNameToId.size} CFB teams in our own teams table`);

    for (const season of [2024, 2025]) {
      log(job, `\nfetching ${season} returning production`);
      const rows = await getReturningProduction(season);
      log(job, `${rows.length} rows returned for ${season}`);

      const resolved = rows.filter((r) => teamNameToId.has(r.team));
      log(
        job,
        `team-name resolution: ${resolved.length}/${rows.length} (${((resolved.length / rows.length) * 100).toFixed(1)}%) match a name in our teams table -- unresolved names logged below if any.`,
      );
      const unresolved = rows.filter((r) => !teamNameToId.has(r.team));
      for (const r of unresolved.slice(0, 15)) {
        log(job, `  unresolved: "${r.team}" (conference=${r.conference})`);
      }
      if (unresolved.length > 15) log(job, `  ...and ${unresolved.length - 15} more`);

      const percentPpaValues = rows.map((r) => r.percentPPA);
      const usageValues = rows.map((r) => r.usage);
      log(
        job,
        `percentPPA range: [${Math.min(...percentPpaValues).toFixed(3)}, ${Math.max(...percentPpaValues).toFixed(3)}] -- expect roughly 0-1 if this is a fraction, hand-check against the raw numbers below if it looks like a 0-100 scale instead.`,
      );
      log(job, `usage range: [${Math.min(...usageValues).toFixed(3)}, ${Math.max(...usageValues).toFixed(3)}]`);

      // A handful of known programs to hand-check against public reporting
      // (e.g. a Google search for "<team> <season> returning production")
      // -- deliberately a mix of "known high returning production" and
      // "known heavy roster turnover" programs so a real signal should be
      // visible in the printed numbers, not just plausible-looking noise.
      const spotCheckTeams = ["Georgia", "Alabama", "Ohio State", "Michigan", "Texas", "Colorado"];
      log(job, `\nspot-check rows -- hand-verify these against public reporting for ${season}:`);
      log(job, "team                 conf       totalPPA totPass totRecv totRush  %PPA  %Pass  %Recv  %Rush  usage  useP  useR  useRu");
      for (const teamName of spotCheckTeams) {
        const row = rows.find((r) => r.team === teamName);
        if (!row) {
          log(job, `  ${teamName}: NOT FOUND in ${season} response`);
          continue;
        }
        log(
          job,
          [
            row.team.padEnd(20).slice(0, 20),
            (row.conference ?? "?").padEnd(10).slice(0, 10),
            row.totalPPA.toFixed(1).padStart(8),
            row.totalPassingPPA.toFixed(1).padStart(7),
            row.totalReceivingPPA.toFixed(1).padStart(7),
            row.totalRushingPPA.toFixed(1).padStart(7),
            row.percentPPA.toFixed(3).padStart(6),
            row.percentPassingPPA.toFixed(3).padStart(6),
            row.percentReceivingPPA.toFixed(3).padStart(6),
            row.percentRushingPPA.toFixed(3).padStart(6),
            row.usage.toFixed(3).padStart(6),
            row.passingUsage.toFixed(3).padStart(6),
            row.receivingUsage.toFixed(3).padStart(6),
            row.rushingUsage.toFixed(3).padStart(6),
          ].join(" "),
        );
      }
    }

    log(
      job,
      "\nCheck, against real public reporting for these teams/seasons:\n" +
        "  1. Do percentPPA values look like the 'returning production %' numbers reported in preseason CFB media (roughly 40-95% range, teams known for heavy portal/draft losses near the low end, teams known for a veteran roster near the high end)?\n" +
        "  2. Is percentPPA a 0-1 fraction or a 0-100 percentage -- this determines the exact centering math in Step 2.\n" +
        "  3. Does a team missing entirely from a season's response (e.g. a first-year FBS transition) make sense, or does it suggest a resolution bug?\n" +
        "  4. Confirmed already, not something to re-check: there is NO offense/defense split in this endpoint -- only passing/receiving/rushing (all offensive). Any downstream design assuming an offense/defense split is wrong.",
    );
  });
}

/**
 * First real-data sanity check of the full opponent-adjustment pipeline
 * built this session (playSuccess.ts -> garbageTime.ts -> gamePerformance.ts
 * -> opponentAdjust.ts), now that cfb-rawplays-ingest has actually run.
 * Computes ONE full-season snapshot (not per-week/as-of-week -- that's the
 * real integration, still to come) for 2024, so the output can be
 * eyeballed for sanity before deciding how it feeds into
 * computeSeasonRatings. Throwaway-ish diagnostic, not wired into any
 * rating computation.
 */
export function startCfbOpponentAdjustSnapshotJob(): Promise<JobStatus> {
  return runJob("cfb-opponent-adjust-snapshot", async (job) => {
    const season = 2024;

    log(job, `fetching ${season} team name map`);
    const teamNameToId = await getTeamNameToIdMap("cfb");
    const teamIdToName = new Map<number, string>();
    for (const [name, id] of teamNameToId) teamIdToName.set(id, name);

    log(job, `fetching all ${season} completed games' plays (full-season snapshot, no as-of-week cut)`);
    const plays = await getPlaysForSeasonThroughWeek("cfb", season);
    log(job, `${plays.length} plays fetched`);

    const gamesById = new Map<number, GamePlaysGroup>();
    for (const p of plays) {
      let g = gamesById.get(p.gameId);
      if (!g) {
        g = { gameId: p.gameId, homeTeamId: p.homeTeamId, awayTeamId: p.awayTeamId, plays: [] };
        gamesById.set(p.gameId, g);
      }
      g.plays.push({
        offenseTeamId: p.offenseTeamId,
        defenseTeamId: p.defenseTeamId,
        down: p.down,
        distance: p.distance,
        yardsGained: p.yardsGained,
        playType: p.playType,
        offenseScore: p.offenseScore,
        defenseScore: p.defenseScore,
        period: p.period,
        clockMinutes: p.clockMinutes,
        clockSeconds: p.clockSeconds,
        ppa: p.ppa,
      });
    }
    const games = [...gamesById.values()];
    log(job, `${games.length} distinct games`);

    const performances = buildTeamPerformances(games);
    log(job, `${performances.length} team-game performances built (garbage-time-weighted success rate)`);

    const result = computeOpponentAdjustedRatings(performances);
    log(job, `solve: converged=${result.converged} iterations=${result.iterations} teams=${result.off.size}`);

    const ranked = [...result.off.keys()]
      .map((teamId) => ({
        teamId,
        name: teamIdToName.get(teamId) ?? `#${teamId}`,
        off: result.off.get(teamId)!,
        def: result.def.get(teamId)!,
        games: result.teamDiagnostics.get(teamId)?.gamesPlayed ?? 0,
      }))
      .filter((t) => t.games >= 6); // drop tiny-sample teams from the leaderboards (still included in the solve itself)

    const byOffDesc = [...ranked].sort((a, b) => b.off - a.off);
    log(job, "\ntop 15 offenses (opponent-adjusted, garbage-time-weighted success rate):");
    for (const t of byOffDesc.slice(0, 15)) log(job, `  ${t.name}: off=${t.off.toFixed(4)} def=${t.def.toFixed(4)}`);
    log(job, "bottom 15 offenses:");
    for (const t of byOffDesc.slice(-15).reverse()) log(job, `  ${t.name}: off=${t.off.toFixed(4)} def=${t.def.toFixed(4)}`);

    const byDefAsc = [...ranked].sort((a, b) => a.def - b.def); // lower def = better defense
    log(job, "\ntop 15 defenses (lowest allowed, opponent-adjusted):");
    for (const t of byDefAsc.slice(0, 15)) log(job, `  ${t.name}: def=${t.def.toFixed(4)} off=${t.off.toFixed(4)}`);
    log(job, "bottom 15 defenses (highest allowed):");
    for (const t of byDefAsc.slice(-15).reverse()) log(job, `  ${t.name}: def=${t.def.toFixed(4)} off=${t.off.toFixed(4)}`);

    const lowConnectivity = identifyLowConnectivityTeams(result.teamDiagnostics, 6);
    log(job, `\n${lowConnectivity.length} teams flagged low-connectivity (< 6 games played, per teamDiagnostics):`);
    for (const teamId of lowConnectivity.slice(0, 25)) {
      const diag = result.teamDiagnostics.get(teamId)!;
      log(job, `  ${teamIdToName.get(teamId) ?? `#${teamId}`}: gamesPlayed=${diag.gamesPlayed} lastDelta=${diag.lastDelta.toFixed(6)}`);
    }
  });
}

/**
 * Step 1 of the iterative-solve-replaces-incremental-Elo plan -- gates
 * everything else. Runs the EXISTING success-rate-based iterative solve
 * (opponentAdjust.ts + gamePerformance.ts, the exact same machinery
 * syncOpponentAdjustedStats.ts already runs in production, as-of-week)
 * standalone over CFB 2025 through week 14, alongside the CURRENT
 * incremental-Elo rating and the real manually-archived week-14 2025 SP+
 * snapshot (ingest/manual/syncManualSpWeekly.ts -- NOT a live CFBD pull;
 * CFBD's own /ratings/sp has no week param, see that file's doc for why
 * this manual archive is the only real in-season SP+ source available).
 *
 * Hypothesis under test: the iterative solve tracks SP+ substantially
 * better than the incremental Elo loop does. If it doesn't, the
 * diagnosis (an incremental update bakes in credit permanently; an
 * iterative solve re-prices it at current opponent values) is wrong and
 * the rebuild isn't justified -- report either way, don't treat this as
 * a formality.
 *
 * Solve composite = off - def (both success-rate-scale, off_adj/def_adj's
 * own units, per opponentAdjust.ts's sign convention) -- NOT rescaled to
 * points. Correlation/rank agreement with SP+ doesn't require matching
 * absolute scale. This deliberately uses the SUCCESS-RATE solve that
 * already exists and already runs as-of-week in production, not an
 * EPA-based solve (which doesn't exist yet, see Step 0 report) --
 * testing whether iterative opponent-adjustment beats incremental Elo at
 * tracking SP+ doesn't require the metric generalization first.
 *
 * "Through week 14" here means INCLUDING week 14's own games for both
 * Elo and the solve -- this is a retrospective diagnostic snapshot, not
 * a no-lookahead prediction, so that's correct (not a leak).
 */
export function startSolveVsEloVsSpDiagnosticJob(): Promise<JobStatus> {
  return runJob("cfb-solve-vs-elo-vs-sp-diagnostic", async (job) => {
    const season = 2025;
    const week = 14;

    const teamNameToId = await getTeamNameToIdMap("cfb");
    const idToName = new Map<number, string>();
    for (const [name, id] of teamNameToId) idToName.set(id, name);

    log(job, "computing current incremental-Elo rating (default config)...");
    const eloState = await computeRatings("cfb", season, week);

    log(job, "computing standalone iterative solve over all plays through week 14...");
    const plays = await getPlaysForSeasonThroughWeek("cfb", season, week);
    const gamesById = new Map<number, GamePlaysGroup>();
    for (const p of plays) {
      let g = gamesById.get(p.gameId);
      if (!g) {
        g = { gameId: p.gameId, homeTeamId: p.homeTeamId, awayTeamId: p.awayTeamId, plays: [] };
        gamesById.set(p.gameId, g);
      }
      g.plays.push({
        offenseTeamId: p.offenseTeamId,
        defenseTeamId: p.defenseTeamId,
        down: p.down,
        distance: p.distance,
        yardsGained: p.yardsGained,
        playType: p.playType,
        offenseScore: p.offenseScore,
        defenseScore: p.defenseScore,
        period: p.period,
        clockMinutes: p.clockMinutes,
        clockSeconds: p.clockSeconds,
        ppa: p.ppa,
      });
    }
    const performances = buildTeamPerformances([...gamesById.values()]);
    const solve = computeOpponentAdjustedRatings(performances);
    log(
      job,
      `solve: ${solve.iterations} iterations, converged=${solve.converged}, ${performances.length} team-performance rows over ${gamesById.size} games.`,
    );
    const lowConnectivity = identifyLowConnectivityTeams(solve.teamDiagnostics, 6);
    if (lowConnectivity.length > 0) {
      log(
        job,
        `low-connectivity teams (< 6 total off+def appearances): ${lowConnectivity.map((id) => idToName.get(id) ?? `#${id}`).join(", ")}`,
      );
    }

    const spDistribution = await getManualSpWeeklyDistributionForWeek("cfb", season, week);
    log(job, `manual SP+ week ${week}, ${season}: ${spDistribution.size} teams.`);

    interface Row {
      teamId: number;
      name: string;
      elo: number;
      solve: number;
      sp: number;
    }
    const rows: Row[] = [];
    for (const [teamId, sp] of spDistribution) {
      const eloRating = eloState.get(teamId)?.rating;
      const off = solve.off.get(teamId);
      const def = solve.def.get(teamId);
      if (eloRating === undefined || off === undefined || def === undefined) continue;
      rows.push({ teamId, name: idToName.get(teamId) ?? `team ${teamId}`, elo: eloRating, solve: off - def, sp });
    }
    log(job, `${rows.length} teams present in all three sources (Elo, solve, manual SP+).`);
    if (rows.length < 20) {
      log(job, "Too few teams in common to trust a correlation or rank comparison -- stopping here. Check week alignment / manual archive coverage before re-running.");
      return;
    }

    function pearson(xs: number[], ys: number[]): number {
      const n = xs.length;
      const meanX = xs.reduce((a, b) => a + b, 0) / n;
      const meanY = ys.reduce((a, b) => a + b, 0) / n;
      let cov = 0;
      let varX = 0;
      let varY = 0;
      for (let i = 0; i < n; i++) {
        cov += (xs[i]! - meanX) * (ys[i]! - meanY);
        varX += (xs[i]! - meanX) ** 2;
        varY += (ys[i]! - meanY) ** 2;
      }
      return cov / Math.sqrt(varX * varY);
    }
    const eloCorr = pearson(
      rows.map((r) => r.elo),
      rows.map((r) => r.sp),
    );
    const solveCorr = pearson(
      rows.map((r) => r.solve),
      rows.map((r) => r.sp),
    );
    log(job, `\nPearson correlation with SP+: Elo=${eloCorr.toFixed(3)}, solve=${solveCorr.toFixed(3)}.`);
    log(
      job,
      solveCorr > eloCorr
        ? "Solve tracks SP+ MORE closely than Elo -- hypothesis SUPPORTED so far."
        : "Solve does NOT track SP+ more closely than Elo -- hypothesis NOT supported. Stop and reconsider before Step 2.",
    );

    function rankOf(key: "elo" | "solve" | "sp"): Map<number, number> {
      const sorted = [...rows].sort((a, b) => b[key] - a[key]);
      const rank = new Map<number, number>();
      sorted.forEach((r, i) => rank.set(r.teamId, i + 1));
      return rank;
    }
    const eloRank = rankOf("elo");
    const solveRank = rankOf("solve");
    const spRank = rankOf("sp");

    function largestDisagreements(rankA: Map<number, number>, label: string): void {
      const diffs = rows
        .map((r) => ({ r, diff: Math.abs(rankA.get(r.teamId)! - spRank.get(r.teamId)!) }))
        .sort((a, b) => b.diff - a.diff)
        .slice(0, 15);
      log(job, `\n15 largest ${label}-vs-SP+ rank disagreements (of ${rows.length} teams):`);
      for (const { r, diff } of diffs) {
        log(job, `  ${r.name.padEnd(20)} ${label}_rank=${rankA.get(r.teamId)}  sp_rank=${spRank.get(r.teamId)}  diff=${diff}`);
      }
    }
    largestDisagreements(eloRank, "elo");
    largestDisagreements(solveRank, "solve");

    log(job, "\nCalled-out teams:");
    for (const name of ["Old Dominion", "Penn State", "Clemson"]) {
      const row = rows.find((r) => r.name === name);
      if (!row) {
        log(job, `  ${name}: not in the combined table (missing from one of the three sources).`);
        continue;
      }
      log(
        job,
        `  ${name}: Elo rank ${eloRank.get(row.teamId)} (${row.elo.toFixed(2)}), solve rank ${solveRank.get(row.teamId)} (${row.solve.toFixed(4)}), SP+ rank ${spRank.get(row.teamId)} (${row.sp.toFixed(1)})`,
      );
    }
  });
}

/**
 * Widened version of cfb-solve-vs-elo-vs-sp-diagnostic -- that single
 * week-14-2025 snapshot showed an essentially-tied aggregate correlation
 * (Elo=0.909, solve=0.912, well inside a single point estimate's noise:
 * SE(r) ~ sqrt((1-r^2)/(n-2)) ~ 0.037 for n=130, an order of magnitude
 * bigger than the observed delta) despite a real face-validity win on
 * the specific motivating teams (Old Dominion, Clemson; Penn State did
 * NOT improve). This checks whether that's a general pattern across the
 * season and across years, or a one-snapshot coincidence.
 *
 * Part A: within CFB 2025, six checkpoints across the season (weeks 4,
 * 6, 8, 10, 12, 14), each using the REAL as-of-that-week manual SP+
 * archive (no lookahead). Correlations are reported PER WEEK, not
 * pooled across weeks -- pooling raw rating values across weeks with
 * different rating spreads (ratings separate more as the season goes on)
 * would conflate within-week accuracy with between-week rating growth
 * and isn't a clean test. Also tracks the three named teams'
 * |rank - SP+ rank| week by week for both methods.
 *
 * Part B: cross-season check using CFBD's final-season SP+ snapshot
 * (external_ratings source='cfbd_sp', week IS NULL) against each
 * season's own final week's Elo/solve, for 2023 and 2024 -- coarser (one
 * point per season, real CFBD data since the manual archive only covers
 * 2025) but tests generalization across different years' team pools.
 */
export function startSolveVsEloVsSpWidenedDiagnosticJob(): Promise<JobStatus> {
  return runJob("cfb-solve-vs-elo-vs-sp-widened-diagnostic", async (job) => {
    const teamNameToId = await getTeamNameToIdMap("cfb");
    const idToName = new Map<number, string>();
    for (const [name, id] of teamNameToId) idToName.set(id, name);

    function pearson(xs: number[], ys: number[]): number {
      const n = xs.length;
      const meanX = xs.reduce((a, b) => a + b, 0) / n;
      const meanY = ys.reduce((a, b) => a + b, 0) / n;
      let cov = 0;
      let varX = 0;
      let varY = 0;
      for (let i = 0; i < n; i++) {
        cov += (xs[i]! - meanX) * (ys[i]! - meanY);
        varX += (xs[i]! - meanX) ** 2;
        varY += (ys[i]! - meanY) ** 2;
      }
      return cov / Math.sqrt(varX * varY);
    }

    async function computeSolveComposite(season: number, week: number): Promise<Map<number, number>> {
      const plays = await getPlaysForSeasonThroughWeek("cfb", season, week);
      const gamesById = new Map<number, GamePlaysGroup>();
      for (const p of plays) {
        let g = gamesById.get(p.gameId);
        if (!g) {
          g = { gameId: p.gameId, homeTeamId: p.homeTeamId, awayTeamId: p.awayTeamId, plays: [] };
          gamesById.set(p.gameId, g);
        }
        g.plays.push({
          offenseTeamId: p.offenseTeamId,
          defenseTeamId: p.defenseTeamId,
          down: p.down,
          distance: p.distance,
          yardsGained: p.yardsGained,
          playType: p.playType,
          offenseScore: p.offenseScore,
          defenseScore: p.defenseScore,
          period: p.period,
          clockMinutes: p.clockMinutes,
          clockSeconds: p.clockSeconds,
          ppa: p.ppa,
        });
      }
      const performances = buildTeamPerformances([...gamesById.values()]);
      const solve = computeOpponentAdjustedRatings(performances);
      const composite = new Map<number, number>();
      for (const teamId of solve.off.keys()) {
        composite.set(teamId, solve.off.get(teamId)! - solve.def.get(teamId)!);
      }
      return composite;
    }

    log(job, "=== Part A: CFB 2025, checkpoints across the season (real weekly SP+, no lookahead) ===");
    const season2025 = 2025;
    const weeks = [4, 6, 8, 10, 12, 14];
    let solveWins = 0;
    let eloWins = 0;
    const trackedNames = ["Old Dominion", "Penn State", "Clemson"];
    const trackedTrajectory = new Map<string, { week: number; eloDiff: number; solveDiff: number }[]>();
    for (const name of trackedNames) trackedTrajectory.set(name, []);

    for (const week of weeks) {
      const eloState = await computeRatings("cfb", season2025, week);
      const solveComposite = await computeSolveComposite(season2025, week);
      const spDistribution = await getManualSpWeeklyDistributionForWeek("cfb", season2025, week);

      const rows: { teamId: number; name: string; elo: number; solve: number; sp: number }[] = [];
      for (const [teamId, sp] of spDistribution) {
        const eloRating = eloState.get(teamId)?.rating;
        const solve = solveComposite.get(teamId);
        if (eloRating === undefined || solve === undefined) continue;
        rows.push({ teamId, name: idToName.get(teamId) ?? `team ${teamId}`, elo: eloRating, solve, sp });
      }
      if (rows.length < 20) {
        log(job, `week ${week}: only ${rows.length} teams in common -- skipping.`);
        continue;
      }
      const eloCorr = pearson(
        rows.map((r) => r.elo),
        rows.map((r) => r.sp),
      );
      const solveCorr = pearson(
        rows.map((r) => r.solve),
        rows.map((r) => r.sp),
      );
      if (solveCorr > eloCorr) solveWins += 1;
      else eloWins += 1;
      log(
        job,
        `week ${week}: n=${rows.length}, Elo corr=${eloCorr.toFixed(3)}, solve corr=${solveCorr.toFixed(3)}, delta=${(solveCorr - eloCorr).toFixed(4)} (${solveCorr > eloCorr ? "solve" : "elo"} better)`,
      );

      function rankOf(key: "elo" | "solve" | "sp"): Map<number, number> {
        const sorted = [...rows].sort((a, b) => b[key] - a[key]);
        const rank = new Map<number, number>();
        sorted.forEach((r, i) => rank.set(r.teamId, i + 1));
        return rank;
      }
      const eloRank = rankOf("elo");
      const solveRank = rankOf("solve");
      const spRank = rankOf("sp");
      for (const name of trackedNames) {
        const row = rows.find((r) => r.name === name);
        if (!row) continue;
        trackedTrajectory.get(name)!.push({
          week,
          eloDiff: Math.abs(eloRank.get(row.teamId)! - spRank.get(row.teamId)!),
          solveDiff: Math.abs(solveRank.get(row.teamId)! - spRank.get(row.teamId)!),
        });
      }
    }
    log(job, `\nAcross ${solveWins + eloWins} checkpoints: solve had the higher correlation in ${solveWins}, Elo in ${eloWins}.`);

    log(job, "\nTracked teams' |rank - SP+ rank| across the season (lower = better; elo=X/solve=Y per week):");
    for (const name of trackedNames) {
      const traj = trackedTrajectory.get(name)!;
      if (traj.length === 0) {
        log(job, `  ${name}: not present in any checkpoint week (missing from Elo, solve, or that week's manual SP+).`);
        continue;
      }
      log(job, `  ${name}: ` + traj.map((t) => `wk${t.week} elo=${t.eloDiff}/solve=${t.solveDiff}`).join("  "));
    }

    log(job, "\n=== Part B: cross-season final-snapshot check (CFBD final SP+, 2023 and 2024) ===");
    for (const season of [2023, 2024]) {
      const seasonWeeks = await getDistinctWeeks("cfb", season);
      if (seasonWeeks.length === 0) {
        log(job, `${season}: no games found -- skipping.`);
        continue;
      }
      const lastWeek = Math.max(...seasonWeeks);
      const eloState = await computeRatings("cfb", season, lastWeek);
      const solveComposite = await computeSolveComposite(season, lastWeek);
      const spDistribution = await getCfbdSpDistributionForSeason("cfb", season);

      const rows: { teamId: number; elo: number; solve: number; sp: number }[] = [];
      for (const [teamId, sp] of spDistribution) {
        const eloRating = eloState.get(teamId)?.rating;
        const solve = solveComposite.get(teamId);
        if (eloRating === undefined || solve === undefined) continue;
        rows.push({ teamId, elo: eloRating, solve, sp });
      }
      if (rows.length < 20) {
        log(job, `${season} (final week ${lastWeek}): only ${rows.length} teams in common -- skipping.`);
        continue;
      }
      const eloCorr = pearson(
        rows.map((r) => r.elo),
        rows.map((r) => r.sp),
      );
      const solveCorr = pearson(
        rows.map((r) => r.solve),
        rows.map((r) => r.sp),
      );
      log(
        job,
        `${season} (final week ${lastWeek}, n=${rows.length}): Elo corr=${eloCorr.toFixed(3)}, solve corr=${solveCorr.toFixed(3)}, delta=${(solveCorr - eloCorr).toFixed(4)}`,
      );
    }
  });
}

/**
 * Tests the cold-start explanation for weeks 4/6 losing to Elo in the
 * widened diagnostic above, rather than assuming it: the raw solve starts
 * every team at OFF=DEF=0 with no preseason information at all, while Elo
 * gets seasonCarryover + SP+ as a head start. Seeds the 2025 week-4/week-6
 * solve with 2024's own final-season solve output, shrunk toward 0 by the
 * SAME seasonCarryover factor RatingParams uses for Elo -- if that flips
 * those two weeks to favor the solve, the cold-start explanation is
 * confirmed (and this is a real preview of Step 2's preseason-seeding
 * need); if it doesn't, something else is going on early-season and that
 * needs to be understood before building on top of it.
 *
 * The 2024 solve output is safe to seed with directly (not an arbitrary
 * prior) -- see opponentAdjust.ts's initialOff/initialDef doc: seeding
 * with a prior that was ITSELF produced by this same function under the
 * same default anchor doesn't introduce a fresh, arbitrary offset the way
 * an unrelated/arbitrary prior would.
 */
export function startSolveColdStartTestJob(): Promise<JobStatus> {
  return runJob("cfb-solve-coldstart-test", async (job) => {
    const teamNameToId = await getTeamNameToIdMap("cfb");
    const idToName = new Map<number, string>();
    for (const [name, id] of teamNameToId) idToName.set(id, name);

    function pearson(xs: number[], ys: number[]): number {
      const n = xs.length;
      const meanX = xs.reduce((a, b) => a + b, 0) / n;
      const meanY = ys.reduce((a, b) => a + b, 0) / n;
      let cov = 0;
      let varX = 0;
      let varY = 0;
      for (let i = 0; i < n; i++) {
        cov += (xs[i]! - meanX) * (ys[i]! - meanY);
        varX += (xs[i]! - meanX) ** 2;
        varY += (ys[i]! - meanY) ** 2;
      }
      return cov / Math.sqrt(varX * varY);
    }

    async function computeSolve(season: number, week: number, seed?: { initialOff: Map<number, number>; initialDef: Map<number, number> }) {
      const plays = await getPlaysForSeasonThroughWeek("cfb", season, week);
      const gamesById = new Map<number, GamePlaysGroup>();
      for (const p of plays) {
        let g = gamesById.get(p.gameId);
        if (!g) {
          g = { gameId: p.gameId, homeTeamId: p.homeTeamId, awayTeamId: p.awayTeamId, plays: [] };
          gamesById.set(p.gameId, g);
        }
        g.plays.push({
          offenseTeamId: p.offenseTeamId,
          defenseTeamId: p.defenseTeamId,
          down: p.down,
          distance: p.distance,
          yardsGained: p.yardsGained,
          playType: p.playType,
          offenseScore: p.offenseScore,
          defenseScore: p.defenseScore,
          period: p.period,
          clockMinutes: p.clockMinutes,
          clockSeconds: p.clockSeconds,
          ppa: p.ppa,
        });
      }
      const performances = buildTeamPerformances([...gamesById.values()]);
      return computeOpponentAdjustedRatings(performances, seed ? { initialOff: seed.initialOff, initialDef: seed.initialDef } : {});
    }

    const carryover = getRatingParams("cfb").seasonCarryover;
    log(job, `computing 2024 final-season solve (seed source), seasonCarryover=${carryover}...`);
    const seasonWeeks2024 = await getDistinctWeeks("cfb", 2024);
    const lastWeek2024 = Math.max(...seasonWeeks2024);
    const solve2024 = await computeSolve(2024, lastWeek2024);
    const initialOff = new Map<number, number>();
    const initialDef = new Map<number, number>();
    for (const [teamId, off] of solve2024.off) initialOff.set(teamId, off * carryover);
    for (const [teamId, def] of solve2024.def) initialDef.set(teamId, def * carryover);
    log(job, `2024 solve: ${solve2024.off.size} teams, seeded ${initialOff.size} into 2025's prior.`);

    for (const week of [4, 6]) {
      const eloState = await computeRatings("cfb", 2025, week);
      const unseeded = await computeSolve(2025, week);
      const seeded = await computeSolve(2025, week, { initialOff, initialDef });
      const spDistribution = await getManualSpWeeklyDistributionForWeek("cfb", 2025, week);

      function composite(result: typeof unseeded, teamId: number): number | undefined {
        const off = result.off.get(teamId);
        const def = result.def.get(teamId);
        if (off === undefined || def === undefined) return undefined;
        return off - def;
      }

      const rows: { teamId: number; elo: number; unseeded: number; seeded: number; sp: number }[] = [];
      for (const [teamId, sp] of spDistribution) {
        const eloRating = eloState.get(teamId)?.rating;
        const u = composite(unseeded, teamId);
        const s = composite(seeded, teamId);
        if (eloRating === undefined || u === undefined || s === undefined) continue;
        rows.push({ teamId, elo: eloRating, unseeded: u, seeded: s, sp });
      }
      if (rows.length < 20) {
        log(job, `week ${week}: only ${rows.length} teams in common -- skipping.`);
        continue;
      }
      const eloCorr = pearson(
        rows.map((r) => r.elo),
        rows.map((r) => r.sp),
      );
      const unseededCorr = pearson(
        rows.map((r) => r.unseeded),
        rows.map((r) => r.sp),
      );
      const seededCorr = pearson(
        rows.map((r) => r.seeded),
        rows.map((r) => r.sp),
      );
      log(
        job,
        `week ${week}: n=${rows.length} -- Elo corr=${eloCorr.toFixed(3)}, unseeded solve corr=${unseededCorr.toFixed(3)}, seeded solve corr=${seededCorr.toFixed(3)}`,
      );
      log(
        job,
        `  seeded solve ${seededCorr > eloCorr ? "NOW BEATS" : "still trails"} Elo (was ${unseededCorr > eloCorr ? "beating" : "trailing"} unseeded) -- cold-start explanation ${seededCorr > eloCorr && seededCorr > unseededCorr ? "CONFIRMED for this week" : "NOT confirmed for this week"}.`,
      );
    }
  });
}

/**
 * Tests EPA (instead of success rate) as the solve's raw metric, across
 * ALL EIGHT checkpoints the widened diagnostic used (2025 weeks 4-14 +
 * 2023/2024 final), not just the two early weeks -- reporting only 4/6
 * would conflate two different findings: EPA being a less noisy small-
 * sample signal (gain concentrated early) vs. EPA simply being a better
 * signal at every week (uniform gain). Those have different implications
 * for Step 2, so all eight get reported the same way.
 *
 * Note on the cold-start explanation status: the prior-seeding test above
 * falsified seeding-as-initial-condition as a FIX, but that doesn't mean
 * the solve doesn't have less information in week 4 than Elo (which
 * carries a real prior via seasonCarryover) -- only that the specific
 * remedy tried doesn't work on a connected graph. This job tests a
 * DIFFERENT candidate explanation (raw-metric noise), not a re-test of
 * the same one.
 */
export function startSolveEpaHypothesisTestJob(): Promise<JobStatus> {
  return runJob("cfb-solve-epa-hypothesis-test", async (job) => {
    const teamNameToId = await getTeamNameToIdMap("cfb");

    function pearson(xs: number[], ys: number[]): number {
      const n = xs.length;
      const meanX = xs.reduce((a, b) => a + b, 0) / n;
      const meanY = ys.reduce((a, b) => a + b, 0) / n;
      let cov = 0;
      let varX = 0;
      let varY = 0;
      for (let i = 0; i < n; i++) {
        cov += (xs[i]! - meanX) * (ys[i]! - meanY);
        varX += (xs[i]! - meanX) ** 2;
        varY += (ys[i]! - meanY) ** 2;
      }
      return cov / Math.sqrt(varX * varY);
    }

    /** metric="success" uses the existing garbage-time-weighted success-rate builder; metric="epa" uses the EPA one. Same solve, same as-of-week cut, only the raw input differs. */
    async function computeSolveComposite(season: number, week: number, metric: "success" | "epa"): Promise<Map<number, number>> {
      const plays = await getPlaysForSeasonThroughWeek("cfb", season, week);
      const gamesById = new Map<number, GamePlaysGroup>();
      for (const p of plays) {
        let g = gamesById.get(p.gameId);
        if (!g) {
          g = { gameId: p.gameId, homeTeamId: p.homeTeamId, awayTeamId: p.awayTeamId, plays: [] };
          gamesById.set(p.gameId, g);
        }
        g.plays.push({
          offenseTeamId: p.offenseTeamId,
          defenseTeamId: p.defenseTeamId,
          down: p.down,
          distance: p.distance,
          yardsGained: p.yardsGained,
          playType: p.playType,
          offenseScore: p.offenseScore,
          defenseScore: p.defenseScore,
          period: p.period,
          clockMinutes: p.clockMinutes,
          clockSeconds: p.clockSeconds,
          ppa: p.ppa,
        });
      }
      const games = [...gamesById.values()];
      const performances = metric === "epa" ? buildTeamPerformancesEpa(games) : buildTeamPerformances(games);
      const solve = computeOpponentAdjustedRatings(performances);
      const composite = new Map<number, number>();
      for (const teamId of solve.off.keys()) {
        composite.set(teamId, solve.off.get(teamId)! - solve.def.get(teamId)!);
      }
      return composite;
    }

    log(job, "=== CFB 2025, all 6 checkpoints -- Elo vs. success-rate solve vs. EPA solve, each vs. real weekly SP+ ===");
    const weeks = [4, 6, 8, 10, 12, 14];
    let epaBeatsSuccessCount = 0;
    let epaBeatsEloCount = 0;
    for (const week of weeks) {
      const eloState = await computeRatings("cfb", 2025, week);
      const successComposite = await computeSolveComposite(2025, week, "success");
      const epaComposite = await computeSolveComposite(2025, week, "epa");
      const spDistribution = await getManualSpWeeklyDistributionForWeek("cfb", 2025, week);

      const rows: { teamId: number; elo: number; success: number; epa: number; sp: number }[] = [];
      for (const [teamId, sp] of spDistribution) {
        const eloRating = eloState.get(teamId)?.rating;
        const success = successComposite.get(teamId);
        const epa = epaComposite.get(teamId);
        if (eloRating === undefined || success === undefined || epa === undefined) continue;
        rows.push({ teamId, elo: eloRating, success, epa, sp });
      }
      if (rows.length < 20) {
        log(job, `week ${week}: only ${rows.length} teams in common -- skipping.`);
        continue;
      }
      const eloCorr = pearson(rows.map((r) => r.elo), rows.map((r) => r.sp));
      const successCorr = pearson(rows.map((r) => r.success), rows.map((r) => r.sp));
      const epaCorr = pearson(rows.map((r) => r.epa), rows.map((r) => r.sp));
      if (epaCorr > successCorr) epaBeatsSuccessCount += 1;
      if (epaCorr > eloCorr) epaBeatsEloCount += 1;
      log(
        job,
        `week ${week}: n=${rows.length} -- Elo=${eloCorr.toFixed(3)}, success-rate solve=${successCorr.toFixed(3)}, EPA solve=${epaCorr.toFixed(3)} (EPA-vs-success delta=${(epaCorr - successCorr).toFixed(4)}, EPA-vs-Elo delta=${(epaCorr - eloCorr).toFixed(4)})`,
      );
    }
    log(
      job,
      `\nEPA solve beat the success-rate solve in ${epaBeatsSuccessCount}/${weeks.length} weeks, and beat Elo in ${epaBeatsEloCount}/${weeks.length} weeks.`,
    );
    log(
      job,
      "If the EPA-vs-success gain concentrates in the early weeks (4, 6) rather than being roughly uniform across all six, that supports the small-sample-noise explanation specifically; a roughly uniform gain across all six means EPA is just a better signal generally, not an early-season fix.",
    );

    log(job, "\n=== Cross-season final-snapshot check (CFBD final SP+), 2023 and 2024 -- same three-way comparison ===");
    for (const season of [2023, 2024]) {
      const seasonWeeks = await getDistinctWeeks("cfb", season);
      if (seasonWeeks.length === 0) {
        log(job, `${season}: no games found -- skipping.`);
        continue;
      }
      const lastWeek = Math.max(...seasonWeeks);
      const eloState = await computeRatings("cfb", season, lastWeek);
      const successComposite = await computeSolveComposite(season, lastWeek, "success");
      const epaComposite = await computeSolveComposite(season, lastWeek, "epa");
      const spDistribution = await getCfbdSpDistributionForSeason("cfb", season);

      const rows: { teamId: number; elo: number; success: number; epa: number; sp: number }[] = [];
      for (const [teamId, sp] of spDistribution) {
        const eloRating = eloState.get(teamId)?.rating;
        const success = successComposite.get(teamId);
        const epa = epaComposite.get(teamId);
        if (eloRating === undefined || success === undefined || epa === undefined) continue;
        rows.push({ teamId, elo: eloRating, success, epa, sp });
      }
      if (rows.length < 20) {
        log(job, `${season} (final week ${lastWeek}): only ${rows.length} teams in common -- skipping.`);
        continue;
      }
      const eloCorr = pearson(rows.map((r) => r.elo), rows.map((r) => r.sp));
      const successCorr = pearson(rows.map((r) => r.success), rows.map((r) => r.sp));
      const epaCorr = pearson(rows.map((r) => r.epa), rows.map((r) => r.sp));
      log(
        job,
        `${season} (final week ${lastWeek}, n=${rows.length}): Elo=${eloCorr.toFixed(3)}, success-rate solve=${successCorr.toFixed(3)}, EPA solve=${epaCorr.toFixed(3)}`,
      );
    }

    log(job, "\nCalled-out teams (week 14, 2025):");
    const eloState14 = await computeRatings("cfb", 2025, 14);
    const successComposite14 = await computeSolveComposite(2025, 14, "success");
    const epaComposite14 = await computeSolveComposite(2025, 14, "epa");
    const spDistribution14 = await getManualSpWeeklyDistributionForWeek("cfb", 2025, 14);
    for (const name of ["Old Dominion", "Penn State", "Clemson"]) {
      const teamId = teamNameToId.get(name);
      if (!teamId) continue;
      const sp = spDistribution14.get(teamId);
      const success = successComposite14.get(teamId);
      const epa = epaComposite14.get(teamId);
      const elo = eloState14.get(teamId)?.rating;
      if (sp === undefined || success === undefined || epa === undefined || elo === undefined) {
        log(job, `  ${name}: missing from one of the sources.`);
        continue;
      }
      log(job, `  ${name}: sp=${sp.toFixed(1)}, elo=${elo.toFixed(2)}, success-rate solve composite=${success.toFixed(4)}, EPA solve composite=${epa.toFixed(4)}`);
    }
  });
}

/**
 * Tests whether the pseudo-game prior mechanism (opponentAdjust.ts's
 * options.priors, NOT the falsified initialOff/initialDef seeding)
 * actually closes the residual early-week gap the EPA hypothesis test
 * left open: EPA solve still trailed Elo at weeks 4 (-0.175) and 6
 * (-0.043), consistent with the solve genuinely having less information
 * early than Elo's carried-over prior.
 *
 * Prior source: 2024's own final-season EPA solve output, used directly
 * (not shrunk toward 0 the way seasonCarryover shrinks a value) -- under
 * this mechanism the SHRINKAGE comes from the weight itself (how many
 * pseudo-games of confidence), not from scaling the prior value down
 * first, which is the more principled parameterization the earlier
 * (falsified) seeding approach couldn't offer at all.
 *
 * Sweeps weight across a small grid on weeks 4 and 6 specifically (the
 * two that still trail) to see whether any value flips them, and by how
 * much -- this is a diagnostic, not a calibration; a real sweep/paired
 * test against CLV or the eventual RMSE metric (Step 4) comes after a
 * weight looks promising here.
 */
export function startSolvePriorWeightTestJob(): Promise<JobStatus> {
  return runJob("cfb-solve-prior-weight-test", async (job) => {
    function pearson(xs: number[], ys: number[]): number {
      const n = xs.length;
      const meanX = xs.reduce((a, b) => a + b, 0) / n;
      const meanY = ys.reduce((a, b) => a + b, 0) / n;
      let cov = 0;
      let varX = 0;
      let varY = 0;
      for (let i = 0; i < n; i++) {
        cov += (xs[i]! - meanX) * (ys[i]! - meanY);
        varX += (xs[i]! - meanX) ** 2;
        varY += (ys[i]! - meanY) ** 2;
      }
      return cov / Math.sqrt(varX * varY);
    }

    async function buildEpaPerformances(season: number, week: number): Promise<TeamPerformance[]> {
      const plays = await getPlaysForSeasonThroughWeek("cfb", season, week);
      const gamesById = new Map<number, GamePlaysGroup>();
      for (const p of plays) {
        let g = gamesById.get(p.gameId);
        if (!g) {
          g = { gameId: p.gameId, homeTeamId: p.homeTeamId, awayTeamId: p.awayTeamId, plays: [] };
          gamesById.set(p.gameId, g);
        }
        g.plays.push({
          offenseTeamId: p.offenseTeamId,
          defenseTeamId: p.defenseTeamId,
          down: p.down,
          distance: p.distance,
          yardsGained: p.yardsGained,
          playType: p.playType,
          offenseScore: p.offenseScore,
          defenseScore: p.defenseScore,
          period: p.period,
          clockMinutes: p.clockMinutes,
          clockSeconds: p.clockSeconds,
          ppa: p.ppa,
        });
      }
      return buildTeamPerformancesEpa([...gamesById.values()]);
    }

    log(job, "computing 2024 final-season EPA solve (prior source)...");
    const seasonWeeks2024 = await getDistinctWeeks("cfb", 2024);
    const lastWeek2024 = Math.max(...seasonWeeks2024);
    const performances2024 = await buildEpaPerformances(2024, lastWeek2024);
    const solve2024 = computeOpponentAdjustedRatings(performances2024);
    log(job, `2024 EPA solve: ${solve2024.off.size} teams, converged=${solve2024.converged}.`);

    const weightGrid = [0, 2, 5, 10, 20, 40];
    for (const week of [4, 6]) {
      const eloState = await computeRatings("cfb", 2025, week);
      const spDistribution = await getManualSpWeeklyDistributionForWeek("cfb", 2025, week);
      const performances2025 = await buildEpaPerformances(2025, week);

      log(job, `\nweek ${week}:`);
      for (const weight of weightGrid) {
        let priors: Map<number, { off: number; def: number; weight: number }> | undefined;
        if (weight > 0) {
          priors = new Map();
          for (const [teamId, off] of solve2024.off) {
            priors.set(teamId, { off, def: solve2024.def.get(teamId) ?? 0, weight });
          }
        }
        const solve = computeOpponentAdjustedRatings(performances2025, { priors });
        const composite = new Map<number, number>();
        for (const teamId of solve.off.keys()) {
          composite.set(teamId, solve.off.get(teamId)! - solve.def.get(teamId)!);
        }

        const rows: { elo: number; solve: number; sp: number }[] = [];
        for (const [teamId, sp] of spDistribution) {
          const eloRating = eloState.get(teamId)?.rating;
          const solveVal = composite.get(teamId);
          if (eloRating === undefined || solveVal === undefined) continue;
          rows.push({ elo: eloRating, solve: solveVal, sp });
        }
        if (rows.length < 20) {
          log(job, `  weight=${weight}: only ${rows.length} teams in common -- skipping.`);
          continue;
        }
        const eloCorr = pearson(rows.map((r) => r.elo), rows.map((r) => r.sp));
        const solveCorr = pearson(rows.map((r) => r.solve), rows.map((r) => r.sp));
        log(
          job,
          `  weight=${weight}: n=${rows.length}, converged=${solve.converged} -- Elo=${eloCorr.toFixed(3)}, EPA solve=${solveCorr.toFixed(3)} (delta=${(solveCorr - eloCorr).toFixed(4)}) -- ${solveCorr > eloCorr ? "SOLVE NOW BEATS ELO" : "still trails"}`,
        );
      }
    }
  });
}

/**
 * Checks weight=2/5 (the two candidates that flipped weeks 4/6 in
 * cfb-solve-prior-weight-test) across ALL checkpoints, not just the two
 * that were losing -- a prior that helps early could plausibly hurt
 * weeks 8-14, where the EPA solve was already beating Elo with no prior
 * at all. The weight is fixed (not decayed per week), so its RELATIVE
 * influence should shrink naturally as real games accumulate -- this
 * checks that's actually true rather than assuming it.
 *
 * Prior sources, to avoid any circularity (never a season's own final
 * solve as its own prior):
 *  - 2025 weeks 4-14: prior = 2024's final-season EPA solve (same as the
 *    weeks-4/6 test).
 *  - 2024's own final week: prior = 2023's final-season EPA solve --
 *    genuinely new coverage, not in the earlier test.
 *  - 2023's own final week: no valid prior source exists (no 2022 raw
 *    play data ingested) -- reported at weight=0 only, for reference.
 */
export function startSolvePriorWeightFullCheckpointTestJob(): Promise<JobStatus> {
  return runJob("cfb-solve-prior-weight-full-checkpoint-test", async (job) => {
    function pearson(xs: number[], ys: number[]): number {
      const n = xs.length;
      const meanX = xs.reduce((a, b) => a + b, 0) / n;
      const meanY = ys.reduce((a, b) => a + b, 0) / n;
      let cov = 0;
      let varX = 0;
      let varY = 0;
      for (let i = 0; i < n; i++) {
        cov += (xs[i]! - meanX) * (ys[i]! - meanY);
        varX += (xs[i]! - meanX) ** 2;
        varY += (ys[i]! - meanY) ** 2;
      }
      return cov / Math.sqrt(varX * varY);
    }

    async function buildEpaPerformances(season: number, week: number): Promise<TeamPerformance[]> {
      const plays = await getPlaysForSeasonThroughWeek("cfb", season, week);
      const gamesById = new Map<number, GamePlaysGroup>();
      for (const p of plays) {
        let g = gamesById.get(p.gameId);
        if (!g) {
          g = { gameId: p.gameId, homeTeamId: p.homeTeamId, awayTeamId: p.awayTeamId, plays: [] };
          gamesById.set(p.gameId, g);
        }
        g.plays.push({
          offenseTeamId: p.offenseTeamId,
          defenseTeamId: p.defenseTeamId,
          down: p.down,
          distance: p.distance,
          yardsGained: p.yardsGained,
          playType: p.playType,
          offenseScore: p.offenseScore,
          defenseScore: p.defenseScore,
          period: p.period,
          clockMinutes: p.clockMinutes,
          clockSeconds: p.clockSeconds,
          ppa: p.ppa,
        });
      }
      return buildTeamPerformancesEpa([...gamesById.values()]);
    }

    function priorsFrom(solve: OpponentAdjustedRatings, weight: number): Map<number, { off: number; def: number; weight: number }> {
      const priors = new Map<number, { off: number; def: number; weight: number }>();
      for (const [teamId, off] of solve.off) {
        priors.set(teamId, { off, def: solve.def.get(teamId) ?? 0, weight });
      }
      return priors;
    }

    async function checkpoint(
      label: string,
      season: number,
      week: number,
      eloState: Map<number, { rating: number }>,
      spDistribution: Map<number, number>,
      priorSolve: OpponentAdjustedRatings | null,
      weights: number[],
    ): Promise<void> {
      const performances = await buildEpaPerformances(season, week);
      log(job, `\n${label}:`);
      for (const weight of weights) {
        const priors = weight > 0 && priorSolve ? priorsFrom(priorSolve, weight) : undefined;
        const solve = computeOpponentAdjustedRatings(performances, { priors });
        const composite = new Map<number, number>();
        for (const teamId of solve.off.keys()) {
          composite.set(teamId, solve.off.get(teamId)! - solve.def.get(teamId)!);
        }
        const rows: { elo: number; solve: number; sp: number }[] = [];
        for (const [teamId, sp] of spDistribution) {
          const eloRating = eloState.get(teamId)?.rating;
          const solveVal = composite.get(teamId);
          if (eloRating === undefined || solveVal === undefined) continue;
          rows.push({ elo: eloRating, solve: solveVal, sp });
        }
        if (rows.length < 20) {
          log(job, `  weight=${weight}: only ${rows.length} teams in common -- skipping.`);
          continue;
        }
        const eloCorr = pearson(rows.map((r) => r.elo), rows.map((r) => r.sp));
        const solveCorr = pearson(rows.map((r) => r.solve), rows.map((r) => r.sp));
        log(
          job,
          `  weight=${weight}: n=${rows.length}, converged=${solve.converged} -- Elo=${eloCorr.toFixed(3)}, EPA solve=${solveCorr.toFixed(3)} (delta=${(solveCorr - eloCorr).toFixed(4)}) -- ${solveCorr > eloCorr ? "SOLVE BEATS ELO" : "trails"}`,
        );
      }
    }

    log(job, "computing 2023 and 2024 final-season EPA solves (prior sources)...");
    const weeks2023 = await getDistinctWeeks("cfb", 2023);
    const lastWeek2023 = Math.max(...weeks2023);
    const performances2023 = await buildEpaPerformances(2023, lastWeek2023);
    const solve2023 = computeOpponentAdjustedRatings(performances2023);

    const weeks2024 = await getDistinctWeeks("cfb", 2024);
    const lastWeek2024 = Math.max(...weeks2024);
    const performances2024 = await buildEpaPerformances(2024, lastWeek2024);
    const solve2024 = computeOpponentAdjustedRatings(performances2024);
    log(job, `2023 solve: ${solve2023.off.size} teams, converged=${solve2023.converged}. 2024 solve: ${solve2024.off.size} teams, converged=${solve2024.converged}.`);

    const weights = [0, 2, 5];

    for (const week of [4, 6, 8, 10, 12, 14]) {
      const eloState = await computeRatings("cfb", 2025, week);
      const spDistribution = await getManualSpWeeklyDistributionForWeek("cfb", 2025, week);
      await checkpoint(`2025 week ${week}`, 2025, week, eloState, spDistribution, solve2024, weights);
    }

    const eloState2024 = await computeRatings("cfb", 2024, lastWeek2024);
    const spDistribution2024 = await getCfbdSpDistributionForSeason("cfb", 2024);
    await checkpoint(`2024 final (week ${lastWeek2024}) -- prior = 2023 solve`, 2024, lastWeek2024, eloState2024, spDistribution2024, solve2023, weights);

    const eloState2023 = await computeRatings("cfb", 2023, lastWeek2023);
    const spDistribution2023 = await getCfbdSpDistributionForSeason("cfb", 2023);
    await checkpoint(`2023 final (week ${lastWeek2023}) -- no valid prior source, weight=0 only`, 2023, lastWeek2023, eloState2023, spDistribution2023, null, [0]);
  });
}

/**
 * LOAD-BEARING, not diagnostic: persists a season's final-week EPA solve
 * (external_ratings, own_epa_solve_off/def, migration 0016) so the NEXT
 * season's computeRatings("cfb", ...) call (service.ts, now the primary
 * CFB engine) has a real prior to blend in via weight=2 pseudo-games,
 * instead of silently falling back to cold-start behavior because
 * getPriorSeasonEpaSolve found nothing. Must be run for a season BEFORE
 * that season is usable as a prior for the next one -- run for 2023 and
 * 2024 to bootstrap 2024's and 2025's priors respectively (2025 itself
 * can be persisted too, harmless, just not needed until a 2026 season
 * exists). Computes fresh via computeOpponentAdjustedRatings directly
 * (NOT via computeRatings, which now IS this same solve for CFB --
 * calling it here would be circular).
 */
export function startCfbPersistFinalEpaSolveJob(season: number): () => Promise<JobStatus> {
  return () =>
    runJob(`cfb-persist-epa-solve-${season}`, async (job) => {
      const seasonWeeks = await getDistinctWeeks("cfb", season);
      if (seasonWeeks.length === 0) {
        log(job, `${season}: no games found -- nothing to persist.`);
        return;
      }
      const lastWeek = Math.max(...seasonWeeks);
      const plays = await getPlaysForSeasonThroughWeek("cfb", season, lastWeek);
      const gamesById = new Map<number, GamePlaysGroup>();
      for (const p of plays) {
        let g = gamesById.get(p.gameId);
        if (!g) {
          g = { gameId: p.gameId, homeTeamId: p.homeTeamId, awayTeamId: p.awayTeamId, plays: [] };
          gamesById.set(p.gameId, g);
        }
        g.plays.push({
          offenseTeamId: p.offenseTeamId,
          defenseTeamId: p.defenseTeamId,
          down: p.down,
          distance: p.distance,
          yardsGained: p.yardsGained,
          playType: p.playType,
          offenseScore: p.offenseScore,
          defenseScore: p.defenseScore,
          period: p.period,
          clockMinutes: p.clockMinutes,
          clockSeconds: p.clockSeconds,
          ppa: p.ppa,
        });
      }
      const performances = buildTeamPerformancesEpa([...gamesById.values()]);
      const solve = computeOpponentAdjustedRatings(performances);
      log(job, `${season} final week ${lastWeek}: ${solve.off.size} teams, converged=${solve.converged}, ${solve.iterations} iterations.`);

      let written = 0;
      for (const [teamId, off] of solve.off) {
        const def = solve.def.get(teamId)!;
        await upsertExternalRating({ teamId, season, week: null, source: "own_epa_solve_off", rating: off });
        await upsertExternalRating({ teamId, season, week: null, source: "own_epa_solve_def", rating: def });
        written += 1;
      }
      log(job, `persisted ${written} teams' off/def to external_ratings.`);
    });
}
