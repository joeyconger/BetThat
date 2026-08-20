import { runBacktest } from "./backtest/run.js";
import { syncCfbdTeams } from "./ingest/cfbd/syncTeams.js";
import { syncCfbdGames } from "./ingest/cfbd/syncGames.js";
import { syncCfbdGameStats, syncCfbdGarbageTimeStats } from "./ingest/cfbd/syncStats.js";
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
} from "./backtest/sweep.js";
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
  "cfb-no-rivalry-week": startCfbNoRivalryWeekJob,
  "weather-backfill": startWeatherBackfillJob,
  "cfb-more-segments": startCfbMoreSegmentsJob,
};
