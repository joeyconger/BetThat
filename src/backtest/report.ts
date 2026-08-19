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
 * CLV/cover-rate performance when only "betting" games where the model
 * deviated from the market by at least `threshold` points — this is how a
 * sane betting threshold gets picked, by comparing across the sweep.
 * Deviation is measured from the opening line where one exists, the
 * closing line otherwise (matches run.ts's pick-side logic — most games
 * only have a closing line; see README "Odds data").
 */
export async function getThresholdReport(
  backtestRunId: number,
  thresholds: number[] = DEFAULT_THRESHOLDS,
): Promise<ThresholdStats[]> {
  const results: ThresholdStats[] = [];
  for (const threshold of thresholds) {
    const rows = await query<AggregateRow>(
      `SELECT ${AGGREGATE_SELECT} FROM backtest_results
       WHERE backtest_run_id = $1
         AND abs(model_spread_home - coalesce(opening_spread_home, closing_spread_home)) >= $2`,
      [backtestRunId, threshold],
    );
    results.push({ threshold, ...toAggregateStats(rows[0]!) });
  }
  return results;
}

export interface SportSeasonStats extends AggregateStats {
  sport: string;
  season: number;
}

/**
 * Breaks results down by sport and season — the first thing to check
 * before trusting an aggregate number: is the pattern stable year to
 * year, or is one season driving the whole result?
 */
export async function getSportSeasonReport(backtestRunId: number): Promise<SportSeasonStats[]> {
  const rows = await query<AggregateRow & { sport: string; season: number }>(
    `SELECT g.sport, g.season, ${AGGREGATE_SELECT}
     FROM backtest_results br JOIN games g ON g.id = br.game_id
     WHERE br.backtest_run_id = $1
     GROUP BY g.sport, g.season
     ORDER BY g.sport, g.season`,
    [backtestRunId],
  );
  return rows.map((row) => ({ sport: row.sport, season: row.season, ...toAggregateStats(row) }));
}

export interface ConfidenceStats extends AggregateStats {
  maxConfidence: number;
}

const DEFAULT_CONFIDENCE_CEILINGS = [8, 6, 4, 3, 2.5, 2, 1.5];

/**
 * CLV/cover-rate performance restricted to predictions with at least a
 * given amount of certainty — distinct from getThresholdReport, which
 * filters by deviation *size*. `confidence` is an error estimate in
 * points (see ratings/elo.ts's predictSpread) — smaller means more games
 * were on the books when the prediction was made, so this answers "does
 * the model do better once it's actually seen enough of the season to
 * have a real opinion," not just "when it disagrees with the market a
 * lot." A big edge early in a season (little data) can still carry a
 * wide confidence interval; this asks a different question than that.
 */
export async function getConfidenceReport(
  backtestRunId: number,
  confidenceCeilings: number[] = DEFAULT_CONFIDENCE_CEILINGS,
): Promise<ConfidenceStats[]> {
  const results: ConfidenceStats[] = [];
  for (const maxConfidence of confidenceCeilings) {
    const rows = await query<AggregateRow>(
      `SELECT ${AGGREGATE_SELECT} FROM backtest_results
       WHERE backtest_run_id = $1 AND confidence IS NOT NULL AND confidence <= $2`,
      [backtestRunId, maxConfidence],
    );
    results.push({ maxConfidence, ...toAggregateStats(rows[0]!) });
  }
  return results;
}

export interface SportWeekStats extends AggregateStats {
  sport: string;
  season: number;
  week: number;
}

/** Breaks results down by sport/season/week, to spot where the model is weak rather than just an overall average. */
export async function getSportWeekReport(backtestRunId: number): Promise<SportWeekStats[]> {
  const rows = await query<AggregateRow & { sport: string; season: number; week: number }>(
    `SELECT g.sport, g.season, g.week, ${AGGREGATE_SELECT}
     FROM backtest_results br JOIN games g ON g.id = br.game_id
     WHERE br.backtest_run_id = $1
     GROUP BY g.sport, g.season, g.week
     ORDER BY g.sport, g.season, g.week`,
    [backtestRunId],
  );
  return rows.map((row) => ({ sport: row.sport, season: row.season, week: row.week, ...toAggregateStats(row) }));
}
