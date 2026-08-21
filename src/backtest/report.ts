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

export interface OpeningCoverStats {
  games: number;
  coverRateVsOpening: number | null;
}

/**
 * Would the model's pick have won money if bet AT THE OPENING LINE, using
 * the real final score — distinct from `coverRate` (vs. the closing line)
 * and `avgClv` (price movement only, independent of who wins). This is the
 * metric that actually answers "if I could get a bet down at open, would I
 * profit" — see README "Backtest results" for how this compares against
 * the closing-line cover rate and why the gap between them matters.
 * Restricted to games with a real opening line (same subset getThresholdReport
 * and computeClv use); a game with only a closing line has no opening price
 * to test against.
 */
export async function getOpeningCoverRate(backtestRunId: number): Promise<OpeningCoverStats> {
  const rows = await query<{ games: string; cover_rate_vs_opening: string | null }>(
    `SELECT count(*) AS games,
       avg(
         CASE
           WHEN open_cover_margin = 0 THEN NULL
           WHEN pick_side = 'home' AND open_cover_margin > 0 THEN 1
           WHEN pick_side = 'away' AND open_cover_margin < 0 THEN 1
           ELSE 0
         END
       ) AS cover_rate_vs_opening
     FROM (
       SELECT
         CASE WHEN (br.opening_spread_home - br.model_spread_home) >= 0 THEN 'home' ELSE 'away' END AS pick_side,
         (br.actual_margin_home + br.opening_spread_home) AS open_cover_margin
       FROM backtest_results br
       WHERE br.backtest_run_id = $1 AND br.opening_spread_home IS NOT NULL
     ) picks`,
    [backtestRunId],
  );
  const row = rows[0]!;
  return {
    games: Number(row.games),
    coverRateVsOpening: row.cover_rate_vs_opening === null ? null : Number(row.cover_rate_vs_opening),
  };
}

export interface ConfidenceOpeningStats {
  maxConfidence: number;
  games: number;
  coverRateVsOpening: number | null;
}

/**
 * getOpeningCoverRate, but restricted to predictions at or under a
 * confidence ceiling — the actual "would betting only the model's most
 * confident picks have made money" question, which getConfidenceReport
 * alone can't answer since it only reports cover rate vs. the CLOSING
 * line (diagnostic) and CLV (price movement only), not vs. the opening
 * line (see getOpeningCoverRate's doc for why that distinction matters).
 * Same games-with-a-real-opening-line restriction as getOpeningCoverRate.
 */
export async function getConfidenceReportVsOpening(
  backtestRunId: number,
  confidenceCeilings: number[] = DEFAULT_CONFIDENCE_CEILINGS,
): Promise<ConfidenceOpeningStats[]> {
  const results: ConfidenceOpeningStats[] = [];
  for (const maxConfidence of confidenceCeilings) {
    const rows = await query<{ games: string; cover_rate_vs_opening: string | null }>(
      `SELECT count(*) AS games,
         avg(
           CASE
             WHEN open_cover_margin = 0 THEN NULL
             WHEN pick_side = 'home' AND open_cover_margin > 0 THEN 1
             WHEN pick_side = 'away' AND open_cover_margin < 0 THEN 1
             ELSE 0
           END
         ) AS cover_rate_vs_opening
       FROM (
         SELECT
           CASE WHEN (br.opening_spread_home - br.model_spread_home) >= 0 THEN 'home' ELSE 'away' END AS pick_side,
           (br.actual_margin_home + br.opening_spread_home) AS open_cover_margin
         FROM backtest_results br
         WHERE br.backtest_run_id = $1 AND br.opening_spread_home IS NOT NULL
           AND br.confidence IS NOT NULL AND br.confidence <= $2
       ) picks`,
      [backtestRunId, maxConfidence],
    );
    const row = rows[0]!;
    results.push({
      maxConfidence,
      games: Number(row.games),
      coverRateVsOpening: row.cover_rate_vs_opening === null ? null : Number(row.cover_rate_vs_opening),
    });
  }
  return results;
}

/** Overall stats for every run at once — one query instead of N, for a run-list page. */
export async function getOverallStatsByRun(): Promise<Map<number, AggregateStats>> {
  const rows = await query<AggregateRow & { backtest_run_id: number }>(
    `SELECT backtest_run_id, ${AGGREGATE_SELECT} FROM backtest_results GROUP BY backtest_run_id`,
  );
  return new Map(rows.map((row) => [row.backtest_run_id, toAggregateStats(row)]));
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

/** Which side the model picked — deviation from opening line where one exists, closing otherwise. Reused across every segment report below. */
const PICK_SIDE_EXPR = `CASE WHEN (coalesce(br.opening_spread_home, br.closing_spread_home) - br.model_spread_home) >= 0 THEN 'home' ELSE 'away' END`;

export interface ConferenceStats extends AggregateStats {
  conference: string;
}

/**
 * Cover rate/CLV grouped by the CONFERENCE OF THE PICKED TEAM (not the
 * game's own conference matchup — see getInOutConferenceReport for that).
 * Answers "does the model do better picking teams from some conferences
 * than others" — real risk of overfitting to noise here given how many
 * conferences there are relative to games per conference, so treat any
 * single standout conference as a hypothesis to walk-forward test, not a
 * proven edge (see README "Backtest results" for why that caveat matters).
 */
export async function getConferenceReport(backtestRunId: number): Promise<ConferenceStats[]> {
  const rows = await query<AggregateRow & { picked_conference: string | null }>(
    `SELECT
       CASE WHEN ${PICK_SIDE_EXPR} = 'home' THEN ht.conference ELSE at.conference END AS picked_conference,
       ${AGGREGATE_SELECT}
     FROM backtest_results br
     JOIN games g ON g.id = br.game_id
     JOIN teams ht ON ht.id = g.home_team_id
     JOIN teams at ON at.id = g.away_team_id
     WHERE br.backtest_run_id = $1
     GROUP BY picked_conference
     ORDER BY cover_rate DESC NULLS LAST`,
    [backtestRunId],
  );
  return rows.map((row) => ({ conference: row.picked_conference ?? "(unknown)", ...toAggregateStats(row) }));
}

export interface InOutConferenceStats extends AggregateStats {
  matchupType: "in-conference" | "out-of-conference";
}

/** In-conference (rivalry-heavy, more familiar matchups) vs. cross-conference games — a different question than which conference the pick came from. */
export async function getInOutConferenceReport(backtestRunId: number): Promise<InOutConferenceStats[]> {
  const rows = await query<AggregateRow & { matchup_type: string }>(
    `SELECT
       CASE WHEN ht.conference = at.conference THEN 'in-conference' ELSE 'out-of-conference' END AS matchup_type,
       ${AGGREGATE_SELECT}
     FROM backtest_results br
     JOIN games g ON g.id = br.game_id
     JOIN teams ht ON ht.id = g.home_team_id
     JOIN teams at ON at.id = g.away_team_id
     WHERE br.backtest_run_id = $1 AND ht.conference IS NOT NULL AND at.conference IS NOT NULL
     GROUP BY matchup_type`,
    [backtestRunId],
  );
  return rows.map((row) => ({
    matchupType: row.matchup_type as InOutConferenceStats["matchupType"],
    ...toAggregateStats(row),
  }));
}

export interface WeekBucketStats extends AggregateStats {
  weekBucket: string;
}

const WEEK_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "weeks 1-2 (early, thin data)", min: 1, max: 2 },
  { label: "weeks 3-4", min: 3, max: 4 },
  { label: "weeks 5-8 (mid-season)", min: 5, max: 8 },
  { label: "weeks 9-13 (late regular)", min: 9, max: 13 },
  { label: "week 14+ (bowls/postseason)", min: 14, max: 99 },
];

/**
 * Buckets by week number — the literal test of "early season, before the
 * model has seen enough games, should be worse." Complements
 * getConfidenceReport (which uses the model's own error estimate as a
 * data-availability proxy) with the more direct, literal signal.
 */
export async function getWeekBucketReport(backtestRunId: number): Promise<WeekBucketStats[]> {
  const results: WeekBucketStats[] = [];
  for (const bucket of WEEK_BUCKETS) {
    const rows = await query<AggregateRow>(
      `SELECT ${AGGREGATE_SELECT}
       FROM backtest_results br JOIN games g ON g.id = br.game_id
       WHERE br.backtest_run_id = $1 AND g.week >= $2 AND g.week <= $3`,
      [backtestRunId, bucket.min, bucket.max],
    );
    results.push({ weekBucket: bucket.label, ...toAggregateStats(rows[0]!) });
  }
  return results;
}

export interface HomeRoadSizeStats extends AggregateStats {
  pickSide: "home" | "away";
  sizeBucket: string;
}

const SPREAD_SIZE_BUCKETS: Array<{ label: string; min: number; max: number }> = [
  { label: "0-3 (close)", min: 0, max: 3 },
  { label: "3-7", min: 3, max: 7 },
  { label: "7-14", min: 7, max: 14 },
  { label: "14+ (blowout favorite)", min: 14, max: 999 },
];

/**
 * Home/road pick side crossed with the SIZE OF THE ACTUAL CLOSING SPREAD
 * (how lopsided the game itself is favored, not how much the model
 * disagrees with the market — see getHomeRoadByDeviationReport for that
 * question instead). A classic favorite/underdog-times-home/road angle.
 */
export async function getHomeRoadBySpreadSizeReport(backtestRunId: number): Promise<HomeRoadSizeStats[]> {
  const results: HomeRoadSizeStats[] = [];
  for (const pickSide of ["home", "away"] as const) {
    for (const bucket of SPREAD_SIZE_BUCKETS) {
      const rows = await query<AggregateRow>(
        `SELECT ${AGGREGATE_SELECT}
         FROM backtest_results br
         WHERE br.backtest_run_id = $1
           AND ${PICK_SIDE_EXPR} = $2
           AND abs(br.closing_spread_home) >= $3 AND abs(br.closing_spread_home) < $4`,
        [backtestRunId, pickSide, bucket.min, bucket.max],
      );
      results.push({ pickSide, sizeBucket: bucket.label, ...toAggregateStats(rows[0]!) });
    }
  }
  return results;
}

/**
 * Home/road pick side crossed with the size of the MODEL'S DEVIATION from
 * market (reuses getThresholdReport's deviation definition) — a different
 * question from spread size above: does the model's edge (when it
 * disagrees a lot) hold up the same for home picks as away picks.
 */
export async function getHomeRoadByDeviationReport(backtestRunId: number): Promise<HomeRoadSizeStats[]> {
  const results: HomeRoadSizeStats[] = [];
  for (const pickSide of ["home", "away"] as const) {
    for (const bucket of SPREAD_SIZE_BUCKETS) {
      const rows = await query<AggregateRow>(
        `SELECT ${AGGREGATE_SELECT}
         FROM backtest_results br
         WHERE br.backtest_run_id = $1
           AND ${PICK_SIDE_EXPR} = $2
           AND abs(br.model_spread_home - coalesce(br.opening_spread_home, br.closing_spread_home)) >= $3
           AND abs(br.model_spread_home - coalesce(br.opening_spread_home, br.closing_spread_home)) < $4`,
        [backtestRunId, pickSide, bucket.min, bucket.max],
      );
      results.push({ pickSide, sizeBucket: bucket.label, ...toAggregateStats(rows[0]!) });
    }
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

export interface KeyNumberStats extends AggregateStats {
  keyNumberBucket: string;
}

/**
 * Points where NFL/CFB final margins cluster disproportionately (3 for a
 * field goal, 7 for a touchdown, 6/10/14/17/20/21 for common combinations)
 * — a real, well-known betting concept distinct from everything else
 * tonight, since it's about the market's OWN number, not the model.
 *
 * Buckets by DISTANCE from the nearest key number, not exact-integer match
 * after rounding — an exact-match version was tried first and caught its
 * own bug via a synthetic test: books routinely shade lines to X.5 right
 * next to a key number specifically to avoid a push (e.g. -3.5, not -3),
 * and naive rounding sends -3.5 AWAY from 3 (rounds to 4) or -10.5 away
 * from 10 (rounds to 11 under Postgres's round-half-away-from-zero), so
 * exact-match bucketing was classifying the most common real-world case
 * (a half-point shade off a key number) as "off-number" — the opposite of
 * what the bucket name means.
 */
const KEY_NUMBERS = [3, 4, 6, 7, 10, 13, 14, 17, 20, 21];

export async function getKeyNumberReport(backtestRunId: number): Promise<KeyNumberStats[]> {
  const rows = await query<AggregateRow & { key_number_bucket: string }>(
    `SELECT
       CASE
         WHEN min_dist = 0 THEN 'on a key number'
         WHEN min_dist <= 0.5 THEN 'within 0.5 of a key number'
         WHEN min_dist <= 1 THEN 'within 1 of a key number'
         ELSE 'off-number'
       END AS key_number_bucket,
       ${AGGREGATE_SELECT}
     FROM (
       SELECT br.*, (SELECT min(abs(abs(br.closing_spread_home) - k)) FROM unnest($2::int[]) AS k) AS min_dist
       FROM backtest_results br
       WHERE br.backtest_run_id = $1
     ) br
     GROUP BY key_number_bucket
     ORDER BY key_number_bucket`,
    [backtestRunId, KEY_NUMBERS],
  );
  return rows.map((row) => ({ keyNumberBucket: row.key_number_bucket, ...toAggregateStats(row) }));
}

export interface WeatherStats extends AggregateStats {
  weatherBucket: string;
}

/**
 * Cover rate/CLV broken down by wind speed and precipitation, from the
 * `weather` table (see ingest/weather and ingest/cfbd/syncHistoricalWeather
 * — both UNVERIFIED, historical backfill only, not yet run against real
 * data). Dome games are their own bucket (weather can't matter there).
 * Games with no weather row at all are excluded, not bucketed as "calm" —
 * see `weather IS NOT NULL` filters below.
 */
export async function getWeatherReport(backtestRunId: number): Promise<WeatherStats[]> {
  const rows = await query<AggregateRow & { weather_bucket: string }>(
    `SELECT
       CASE
         WHEN w.is_dome THEN 'dome'
         WHEN w.wind_mph >= 20 THEN 'wind 20+'
         WHEN w.wind_mph >= 15 THEN 'wind 15-20'
         WHEN w.wind_mph >= 10 THEN 'wind 10-15'
         ELSE 'wind <10'
       END AS weather_bucket,
       ${AGGREGATE_SELECT}
     FROM backtest_results br
     JOIN weather w ON w.game_id = br.game_id
     WHERE br.backtest_run_id = $1 AND w.wind_mph IS NOT NULL
     GROUP BY weather_bucket
     ORDER BY weather_bucket`,
    [backtestRunId],
  );
  return rows.map((row) => ({ weatherBucket: row.weather_bucket, ...toAggregateStats(row) }));
}

/** Same idea as getWeatherReport, but bucketed by precipitation instead of wind. Uses precipitation_actual (historical) — see migration 0004. */
export async function getPrecipitationReport(backtestRunId: number): Promise<WeatherStats[]> {
  const rows = await query<AggregateRow & { weather_bucket: string }>(
    `SELECT
       CASE
         WHEN w.is_dome THEN 'dome'
         WHEN w.precipitation_actual >= 0.1 THEN 'rain/snow (0.1in+)'
         WHEN w.precipitation_actual > 0 THEN 'trace precipitation'
         ELSE 'dry'
       END AS weather_bucket,
       ${AGGREGATE_SELECT}
     FROM backtest_results br
     JOIN weather w ON w.game_id = br.game_id
     WHERE br.backtest_run_id = $1 AND w.precipitation_actual IS NOT NULL
     GROUP BY weather_bucket
     ORDER BY weather_bucket`,
    [backtestRunId],
  );
  return rows.map((row) => ({ weatherBucket: row.weather_bucket, ...toAggregateStats(row) }));
}
