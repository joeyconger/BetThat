import { runBacktest } from "./backtest/run.js";
import { syncCfbdTeams } from "./ingest/cfbd/syncTeams.js";
import { syncCfbdGames } from "./ingest/cfbd/syncGames.js";
import { syncCfbdGameStats } from "./ingest/cfbd/syncStats.js";
import { syncCfbdHistoricalOdds } from "./ingest/cfbd/syncHistoricalOdds.js";
import { syncCfbdSpRatings, syncCfbdEloRatings } from "./ingest/cfbd/syncExternalRatings.js";
import { runSweep, runExternalRatingsSweep, runSosSweep, runBigSpreadShrinkSweep } from "./backtest/sweep.js";
import {
  getOverallReport,
  getOpeningCoverRate,
  getConferenceReport,
  getInOutConferenceReport,
  getWeekBucketReport,
  getHomeRoadBySpreadSizeReport,
  getHomeRoadByDeviationReport,
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
 * Sweeps bigSpreadShrinkRef (see backtest/sweep.ts's runBigSpreadShrinkSweep
 * and ratings/elo.ts's predictSpread doc) — the "defer to market more on
 * extreme spreads" fix added after backtest data showed the model
 * systematically under-predicting real blowouts. ref=1000 in the grid is
 * effectively the pre-fix, no-damping baseline for direct comparison.
 */
export function startCfbBigSpreadShrinkSweepJob(): Promise<JobStatus> {
  return runJob("cfb-bigspread-sweep", async (job) => {
    log(job, "sweeping cfb bigSpreadShrinkRef, 2023-2025");
    const results = await runBigSpreadShrinkSweep("cfb", 2023, 2025);
    for (const r of results) {
      log(job, `bigSpreadShrinkRef=${r.bigSpreadShrinkRef}: ${r.games} games, cover=${fmtPct(r.coverRate)}, avgClv=${r.avgClv === null ? "n/a" : r.avgClv.toFixed(2)} (run ${r.runId})`);
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
  "cfb-no-rivalry-week": startCfbNoRivalryWeekJob,
};
