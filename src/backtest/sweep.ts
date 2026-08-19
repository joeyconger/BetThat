import { getRatingParams } from "../ratings/config.js";
import type { RatingParams } from "../ratings/config.js";
import type { Sport } from "../db/repo.js";
import { runBacktest } from "./run.js";
import { getOverallReport } from "./report.js";
import { pool } from "../db/pool.js";
import { parseFlags, requireFlag } from "../ingest/cliArgs.js";

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

interface SweepResult {
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

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const sport = requireFlag(flags, "sport") as Sport;
  const seasonStart = Number(requireFlag(flags, "seasonStart"));
  const seasonEnd = Number(requireFlag(flags, "seasonEnd"));

  const results = await runSweep(sport, seasonStart, seasonEnd);

  console.log("\n--- best combos by cover rate ---");
  for (const r of results.slice(0, 5)) {
    console.log(JSON.stringify(r));
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
