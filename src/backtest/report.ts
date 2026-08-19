import { query } from "../db/pool.js";

interface AggregateRow extends Record<string, unknown> {
  games: string;
  avg_clv: string | null;
  beat_close_rate: string | null;
  cover_rate: string | null;
}

export interface AggregateStats {
  games: number;
  avgClv: number | null;
  beatCloseRate: number | null;
  coverRate: number | null;
}

function toAggregateStats(row: AggregateRow): AggregateStats {
  return {
    games: Number(row.games),
    avgClv: row.avg_clv === null ? null : Number(row.avg_clv),
    beatCloseRate: row.beat_close_rate === null ? null : Number(row.beat_close_rate),
    coverRate: row.cover_rate === null ? null : Number(row.cover_rate),
  };
}

const AGGREGATE_SELECT = `
  count(*) AS games,
  avg(clv) AS avg_clv,
  avg(beat_close::int) AS beat_close_rate,
  avg(covered::int) FILTER (WHERE covered IS NOT NULL) AS cover_rate
`;

/** Are model lines beating closing lines on average, across every scored game in the run? */
export async function getOverallReport(backtestRunId: number): Promise<AggregateStats> {
  const rows = await query<AggregateRow>(
    `SELECT ${AGGREGATE_SELECT} FROM backtest_results WHERE backtest_run_id = $1`,
    [backtestRunId],
  );
  return toAggregateStats(rows[0]!);
}

export interface ThresholdStats extends AggregateStats {
  threshold: number;
}

const DEFAULT_THRESHOLDS = [0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 5];

/**
 * CLV performance when only "betting" games where the model deviated from
 * the opening line by at least `threshold` points — this is how a sane
 * betting threshold gets picked, by comparing across the sweep.
 */
export async function getThresholdReport(
  backtestRunId: number,
  thresholds: number[] = DEFAULT_THRESHOLDS,
): Promise<ThresholdStats[]> {
  const results: ThresholdStats[] = [];
  for (const threshold of thresholds) {
    const rows = await query<AggregateRow>(
      `SELECT ${AGGREGATE_SELECT} FROM backtest_results
       WHERE backtest_run_id = $1 AND abs(model_spread_home - opening_spread_home) >= $2`,
      [backtestRunId, threshold],
    );
    results.push({ threshold, ...toAggregateStats(rows[0]!) });
  }
  return results;
}

export interface SportWeekStats extends AggregateStats {
  sport: string;
  week: number;
}

/** Breaks CLV down by sport and week, to spot where the model is weak rather than just an overall average. */
export async function getSportWeekReport(backtestRunId: number): Promise<SportWeekStats[]> {
  const rows = await query<AggregateRow & { sport: string; week: number }>(
    `SELECT g.sport, g.week, ${AGGREGATE_SELECT}
     FROM backtest_results br JOIN games g ON g.id = br.game_id
     WHERE br.backtest_run_id = $1
     GROUP BY g.sport, g.week
     ORDER BY g.sport, g.week`,
    [backtestRunId],
  );
  return rows.map((row) => ({ sport: row.sport, week: row.week, ...toAggregateStats(row) }));
}
