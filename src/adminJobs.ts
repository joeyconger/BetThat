import { runBacktest } from "./backtest/run.js";
import { syncCfbdTeams } from "./ingest/cfbd/syncTeams.js";
import { getPlays, getGames, getTeams, getWinProbabilityData } from "./ingest/cfbd/client.js";
import type { CfbdPlayWinProbability } from "./ingest/cfbd/client.js";
import { syncCfbdGames } from "./ingest/cfbd/syncGames.js";
import { syncCfbdGameStats, syncCfbdGarbageTimeStats } from "./ingest/cfbd/syncStats.js";
import { syncCfbdTurnoverStats } from "./ingest/cfbd/syncTurnoverStats.js";
import { syncCfbdSackRateStats } from "./ingest/cfbd/syncSackRateStats.js";
import { syncCfbdFinishingDrivesStats } from "./ingest/cfbd/syncFinishingDrivesStats.js";
import { syncCfbdSpecialTeamsStats } from "./ingest/cfbd/syncSpecialTeamsStats.js";
import { syncCfbdRawPlays } from "./ingest/cfbd/syncRawPlays.js";
import { syncManualSpWeekly2025 } from "./ingest/manual/syncManualSpWeekly.js";
import { syncCfbdHistoricalOdds } from "./ingest/cfbd/syncHistoricalOdds.js";
import { syncCfbdSpRatings, syncCfbdEloRatings } from "./ingest/cfbd/syncExternalRatings.js";
import { syncCfbdHistoricalWeather } from "./ingest/cfbd/syncHistoricalWeather.js";
import { syncNflHistoricalWeather } from "./ingest/weather/syncWeather.js";
import {
  runSweep,
  runExternalRatingsSweep,
  runSosSweep,
  runBigSpreadShrinkSweep,
  runSpSignalSweep,
  runSuccessRateSweep,
  runGarbageTimeSweep,
  runOpponentAdjustSweep,
  runRestDaySweep,
  runTurnoverLuckSweep,
  runWeeklySpSignalSweep,
  runComponentSweep,
} from "./backtest/sweep.js";
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
 * Sweeps bigSpreadShrinkRef (see backtest/sweep.ts's runBigSpreadShrinkSweep
 * and ratings/elo.ts's predictSpread doc) — the "defer to market more on
 * extreme spreads" fix added after backtest data showed the model
 * systematically under-predicting real blowouts. ref=1000 in the grid is
 * effectively the pre-fix, no-damping baseline for direct comparison.
 */
export function startCfbBigSpreadShrinkSweepJob(): Promise<JobStatus> {
  return runJob("cfb-bigspread-sweep", async (job) => {
    log(job, "sweeping cfb bigSpreadShrinkRef, 2023-2025 (reports cover rate BY CONFIDENCE CEILING, not overall — see runBigSpreadShrinkSweep's doc for why)");
    const results = await runBigSpreadShrinkSweep("cfb", 2023, 2025);
    for (const r of results) {
      const parts = r.coverRateByConfidenceCeiling
        .map((c) => `conf<=${c.maxConfidence}: ${c.games}g ${fmtPct(c.coverRate)}`)
        .join(", ");
      log(job, `bigSpreadShrinkRef=${r.bigSpreadShrinkRef} (run ${r.runId}): ${parts}`);
    }
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
  "cfb-external-sweep": startCfbExternalSweepJob,
  "cfb-walkforward": startCfbWalkforwardJob,
  "cfb-walkforward-no-rivalry": startCfbWalkforwardNoRivalryJob,
  "cfb-segments": startCfbSegmentsJob,
  "cfb-sos-sweep": startCfbSosSweepJob,
  "cfb-bigspread-sweep": startCfbBigSpreadShrinkSweepJob,
  "cfb-spsignal-sweep": startCfbSpSignalSweepJob,
  "cfb-successrate-sweep": startCfbSuccessRateSweepJob,
  "cfb-successrate-walkforward": startCfbSuccessRateWalkforwardJob,
  "cfb-garbage-time-ingest": startCfbGarbageTimeIngestJob,
  "cfb-garbagetime-sweep": startCfbGarbageTimeSweepJob,
  "cfb-garbagetime-walkforward": startCfbGarbageTimeWalkforwardJob,
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
  "cfb-component-sweep-finishingdrives": startCfbComponentSweepFinishingDrivesJob,
  "cfb-specialteams-ingest": startCfbSpecialTeamsIngestJob,
  "cfb-rawplays-ingest": startCfbRawPlaysIngestJob,
  "cfb-component-sweep-fieldposition": startCfbComponentSweepFieldPositionJob,
  "cfb-component-sweep-fgmakerate": startCfbComponentSweepFgMakeRateJob,
  "cfb-2025-check": startCfb2025CheckJob,
  "cfb-confidence-report": startCfbConfidenceReportJob,
  "cfb-confidence-walkforward": startCfbConfidenceWalkforwardJob,
  "cfb-no-rivalry-week": startCfbNoRivalryWeekJob,
  "weather-backfill": startWeatherBackfillJob,
  "cfb-more-segments": startCfbMoreSegmentsJob,
  "cfb-playtype-discover": startCfbPlayTypeDiscoverJob,
  "cfb-verify-plays": startCfbVerifyPlaysJob,
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

    let wpByPlayNumber = new Map<number, CfbdPlayWinProbability>();
    try {
      const wp = await getWinProbabilityData(target.id);
      wpByPlayNumber = new Map(wp.map((row) => [row.playNumber, row]));
      log(job, `${wp.length} win-probability rows found`);
    } catch (err) {
      log(job, `could not fetch win probability data: ${(err as Error).message} -- continuing without it`);
    }

    const maxPlays = 20;
    const shown = gamePlays.slice(0, maxPlays);
    log(job, `\nfirst ${shown.length} of ${gamePlays.length} plays -- hand-check against the real box score/broadcast:`);
    log(job, "period clock  off        def        down-dist yards playType                  score(off-def) ppa     scoring wp(home)");
    for (const play of shown) {
      const clock = play.clock ? `${play.clock.minutes}:${String(play.clock.seconds ?? 0).padStart(2, "0")}` : "?";
      const wpRow = wpByPlayNumber.get(play.playNumber);
      const wpStr = wpRow ? (wpRow.homeWinProb === null ? "null" : wpRow.homeWinProb.toFixed(3)) : "(none)";
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
          wpStr,
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
