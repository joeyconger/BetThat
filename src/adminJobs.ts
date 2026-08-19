import { runBacktest } from "./backtest/run.js";
import { syncCfbdTeams } from "./ingest/cfbd/syncTeams.js";
import { syncCfbdGames } from "./ingest/cfbd/syncGames.js";
import { syncCfbdGameStats } from "./ingest/cfbd/syncStats.js";
import { syncCfbdHistoricalOdds } from "./ingest/cfbd/syncHistoricalOdds.js";

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

export const JOB_STARTERS: Record<string, () => Promise<JobStatus>> = {
  "nfl-backtest-refresh": startNflBacktestJob,
  "cfb-pipeline": startCfbPipelineJob,
};
