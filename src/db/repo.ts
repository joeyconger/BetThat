import { pool } from "./pool.js";

export type Sport = "nfl" | "cfb";

export interface UpsertTeamInput {
  sport: Sport;
  sourceId: string;
  name: string;
  conference?: string | null;
  division?: string | null;
}

export async function upsertTeam(input: UpsertTeamInput): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO teams (sport, source_id, name, conference, division)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (sport, source_id)
     DO UPDATE SET name = EXCLUDED.name, conference = EXCLUDED.conference, division = EXCLUDED.division
     RETURNING id`,
    [input.sport, input.sourceId, input.name, input.conference ?? null, input.division ?? null],
  );
  return result.rows[0]!.id;
}

export async function findTeamId(sport: Sport, sourceId: string): Promise<number | undefined> {
  const result = await pool.query<{ id: number }>(
    `SELECT id FROM teams WHERE sport = $1 AND source_id = $2`,
    [sport, sourceId],
  );
  return result.rows[0]?.id;
}

export interface UpsertGameInput {
  sport: Sport;
  season: number;
  week: number;
  seasonType: "regular" | "postseason";
  gameDate: string | null;
  homeTeamId: number;
  awayTeamId: number;
  homeScore: number | null;
  awayScore: number | null;
  status: "scheduled" | "in_progress" | "final";
  neutralSite: boolean;
  sourceId: string;
}

export async function upsertGame(input: UpsertGameInput): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO games (
       sport, season, week, season_type, game_date, home_team_id, away_team_id,
       home_score, away_score, status, neutral_site, source_id, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     ON CONFLICT (sport, source_id)
     DO UPDATE SET
       season = EXCLUDED.season, week = EXCLUDED.week, season_type = EXCLUDED.season_type,
       game_date = EXCLUDED.game_date, home_team_id = EXCLUDED.home_team_id,
       away_team_id = EXCLUDED.away_team_id, home_score = EXCLUDED.home_score,
       away_score = EXCLUDED.away_score, status = EXCLUDED.status,
       neutral_site = EXCLUDED.neutral_site, updated_at = now()
     RETURNING id`,
    [
      input.sport,
      input.season,
      input.week,
      input.seasonType,
      input.gameDate,
      input.homeTeamId,
      input.awayTeamId,
      input.homeScore,
      input.awayScore,
      input.status,
      input.neutralSite,
      input.sourceId,
    ],
  );
  return result.rows[0]!.id;
}

export async function findGameId(sport: Sport, sourceId: string): Promise<number | undefined> {
  const result = await pool.query<{ id: number }>(
    `SELECT id FROM games WHERE sport = $1 AND source_id = $2`,
    [sport, sourceId],
  );
  return result.rows[0]?.id;
}

export async function findGameByTeamsAndDate(
  sport: Sport,
  homeTeamId: number,
  awayTeamId: number,
  around: Date,
  windowHours = 36,
): Promise<number | undefined> {
  const result = await pool.query<{ id: number }>(
    `SELECT id FROM games
     WHERE sport = $1 AND home_team_id = $2 AND away_team_id = $3
       AND game_date BETWEEN $4::timestamptz - ($5 || ' hours')::interval
                          AND $4::timestamptz + ($5 || ' hours')::interval
     ORDER BY abs(extract(epoch FROM (game_date - $4::timestamptz)))
     LIMIT 1`,
    [sport, homeTeamId, awayTeamId, around.toISOString(), windowHours],
  );
  return result.rows[0]?.id;
}

export interface InsertOddsSnapshotInput {
  gameId: number;
  book: string;
  capturedAt: string;
  snapshotType: "opening" | "movement" | "closing";
  spreadHome: number | null;
  spreadHomePrice: number | null;
  spreadAwayPrice: number | null;
  moneylineHome: number | null;
  moneylineAway: number | null;
  total: number | null;
  totalOverPrice: number | null;
  totalUnderPrice: number | null;
  source: string;
}

export async function insertOddsSnapshot(input: InsertOddsSnapshotInput): Promise<void> {
  await pool.query(
    `INSERT INTO odds_snapshots (
       game_id, book, captured_at, snapshot_type, spread_home, spread_home_price,
       spread_away_price, moneyline_home, moneyline_away, total, total_over_price,
       total_under_price, source
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (game_id, book, captured_at) DO NOTHING`,
    [
      input.gameId,
      input.book,
      input.capturedAt,
      input.snapshotType,
      input.spreadHome,
      input.spreadHomePrice,
      input.spreadAwayPrice,
      input.moneylineHome,
      input.moneylineAway,
      input.total,
      input.totalOverPrice,
      input.totalUnderPrice,
      input.source,
    ],
  );
}

export interface UpcomingGame {
  id: number;
  gameDate: Date;
  homeTeamSourceId: string;
}

export async function getUpcomingGames(sport: Sport, withinDays: number): Promise<UpcomingGame[]> {
  const result = await pool.query<{ id: number; game_date: Date; source_id: string }>(
    `SELECT g.id, g.game_date, t.source_id
     FROM games g JOIN teams t ON t.id = g.home_team_id
     WHERE g.sport = $1 AND g.status = 'scheduled'
       AND g.game_date BETWEEN now() AND now() + ($2 || ' days')::interval`,
    [sport, withinDays],
  );
  return result.rows.map((r) => ({ id: r.id, gameDate: r.game_date, homeTeamSourceId: r.source_id }));
}

export interface UpsertWeatherInput {
  gameId: number;
  forecastAt: string;
  tempF: number | null;
  windMph: number | null;
  precipitationProbability: number | null;
  isDome: boolean;
  source: string;
}

export async function upsertWeather(input: UpsertWeatherInput): Promise<void> {
  await pool.query(
    `INSERT INTO weather (game_id, forecast_at, temp_f, wind_mph, precipitation_probability, is_dome, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (game_id)
     DO UPDATE SET forecast_at = EXCLUDED.forecast_at, temp_f = EXCLUDED.temp_f,
       wind_mph = EXCLUDED.wind_mph, precipitation_probability = EXCLUDED.precipitation_probability,
       is_dome = EXCLUDED.is_dome, source = EXCLUDED.source`,
    [
      input.gameId,
      input.forecastAt,
      input.tempF,
      input.windMph,
      input.precipitationProbability,
      input.isDome,
      input.source,
    ],
  );
}

export interface InsertInjuryInput {
  teamId: number;
  gameId: number | null;
  playerName: string;
  position: string | null;
  status: "out" | "doubtful" | "questionable" | "probable" | "ir";
  reportDate: string;
  source: string;
  raw: unknown;
}

export async function insertInjury(input: InsertInjuryInput): Promise<void> {
  await pool.query(
    `INSERT INTO injuries (team_id, game_id, player_name, position, status, report_date, source, raw)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (team_id, player_name, report_date)
     DO UPDATE SET status = EXCLUDED.status, game_id = EXCLUDED.game_id, raw = EXCLUDED.raw`,
    [
      input.teamId,
      input.gameId,
      input.playerName,
      input.position,
      input.status,
      input.reportDate,
      input.source,
      JSON.stringify(input.raw),
    ],
  );
}

export async function findTeamIdByName(sport: Sport, name: string): Promise<number | undefined> {
  const result = await pool.query<{ id: number }>(
    `SELECT id FROM teams WHERE sport = $1 AND name = $2`,
    [sport, name],
  );
  return result.rows[0]?.id;
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Best-effort name match for external sources (e.g. The Odds API) whose team
 * naming doesn't exactly match this project's source (CFBD school names are
 * mascot-less; NFL names are exact since teamNames.ts mirrors Odds API's
 * naming). Tries exact match, then substring match in both directions.
 * Returns undefined — never a guess — when more than one team matches.
 */
export async function findTeamIdFuzzy(sport: Sport, externalName: string): Promise<number | undefined> {
  const exact = await findTeamIdByName(sport, externalName);
  if (exact) return exact;

  const target = normalizeName(externalName);
  const rows = await pool.query<{ id: number; name: string }>(`SELECT id, name FROM teams WHERE sport = $1`, [sport]);
  const matches = rows.rows.filter((row) => {
    const candidate = normalizeName(row.name);
    return candidate.includes(target) || target.includes(candidate);
  });
  return matches.length === 1 ? matches[0]!.id : undefined;
}

export async function getGameDate(gameId: number): Promise<Date | undefined> {
  const result = await pool.query<{ game_date: Date }>(`SELECT game_date FROM games WHERE id = $1`, [gameId]);
  return result.rows[0]?.game_date;
}

export async function getGameTeamIds(gameId: number): Promise<{ homeTeamId: number; awayTeamId: number } | undefined> {
  const result = await pool.query<{ home_team_id: number; away_team_id: number }>(
    `SELECT home_team_id, away_team_id FROM games WHERE id = $1`,
    [gameId],
  );
  const row = result.rows[0];
  return row ? { homeTeamId: row.home_team_id, awayTeamId: row.away_team_id } : undefined;
}

export interface UpsertTeamGameStatsInput {
  gameId: number;
  teamId: number;
  isHome: boolean;
  offEpaPlay: number | null;
  offEpaPass: number | null;
  offEpaRush: number | null;
  defEpaPlay: number | null;
  defEpaPass: number | null;
  defEpaRush: number | null;
  offSuccessRate: number | null;
  offSuccessRatePass: number | null;
  offSuccessRateRush: number | null;
  defSuccessRate: number | null;
  defSuccessRatePass: number | null;
  defSuccessRateRush: number | null;
  playsOffense: number | null;
  playsDefense: number | null;
  source: "cfbd" | "nflverse";
}

export async function upsertTeamGameStats(input: UpsertTeamGameStatsInput): Promise<void> {
  await pool.query(
    `INSERT INTO team_game_stats (
       game_id, team_id, is_home, off_epa_play, off_epa_pass, off_epa_rush,
       def_epa_play, def_epa_pass, def_epa_rush, off_success_rate,
       off_success_rate_pass, off_success_rate_rush, def_success_rate,
       def_success_rate_pass, def_success_rate_rush, plays_offense, plays_defense, source
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (game_id, team_id)
     DO UPDATE SET
       is_home = EXCLUDED.is_home,
       off_epa_play = EXCLUDED.off_epa_play, off_epa_pass = EXCLUDED.off_epa_pass, off_epa_rush = EXCLUDED.off_epa_rush,
       def_epa_play = EXCLUDED.def_epa_play, def_epa_pass = EXCLUDED.def_epa_pass, def_epa_rush = EXCLUDED.def_epa_rush,
       off_success_rate = EXCLUDED.off_success_rate, off_success_rate_pass = EXCLUDED.off_success_rate_pass,
       off_success_rate_rush = EXCLUDED.off_success_rate_rush, def_success_rate = EXCLUDED.def_success_rate,
       def_success_rate_pass = EXCLUDED.def_success_rate_pass, def_success_rate_rush = EXCLUDED.def_success_rate_rush,
       plays_offense = EXCLUDED.plays_offense, plays_defense = EXCLUDED.plays_defense, source = EXCLUDED.source`,
    [
      input.gameId,
      input.teamId,
      input.isHome,
      input.offEpaPlay,
      input.offEpaPass,
      input.offEpaRush,
      input.defEpaPlay,
      input.defEpaPass,
      input.defEpaRush,
      input.offSuccessRate,
      input.offSuccessRatePass,
      input.offSuccessRateRush,
      input.defSuccessRate,
      input.defSuccessRatePass,
      input.defSuccessRateRush,
      input.playsOffense,
      input.playsDefense,
      input.source,
    ],
  );
}

export interface GameForRating {
  gameId: number;
  week: number;
  homeTeamId: number;
  awayTeamId: number;
  homeOffEpa: number;
  homeDefEpa: number;
  awayOffEpa: number;
  awayDefEpa: number;
}

/** Completed games with both teams' EPA/play stats present — what the rating engine consumes. */
export async function getSeasonGamesForRating(
  sport: Sport,
  season: number,
  throughWeek: number,
): Promise<GameForRating[]> {
  const result = await pool.query<{
    game_id: number;
    week: number;
    home_team_id: number;
    away_team_id: number;
    home_off_epa: number;
    home_def_epa: number;
    away_off_epa: number;
    away_def_epa: number;
  }>(
    `SELECT g.id AS game_id, g.week, g.home_team_id, g.away_team_id,
            home_stats.off_epa_play AS home_off_epa, home_stats.def_epa_play AS home_def_epa,
            away_stats.off_epa_play AS away_off_epa, away_stats.def_epa_play AS away_def_epa
     FROM games g
     JOIN team_game_stats home_stats ON home_stats.game_id = g.id AND home_stats.team_id = g.home_team_id
     JOIN team_game_stats away_stats ON away_stats.game_id = g.id AND away_stats.team_id = g.away_team_id
     WHERE g.sport = $1 AND g.season = $2 AND g.week <= $3 AND g.status = 'final'
       AND home_stats.off_epa_play IS NOT NULL AND home_stats.def_epa_play IS NOT NULL
       AND away_stats.off_epa_play IS NOT NULL AND away_stats.def_epa_play IS NOT NULL
     ORDER BY g.week ASC, g.id ASC`,
    [sport, season, throughWeek],
  );
  return result.rows.map((r) => ({
    gameId: r.game_id,
    week: r.week,
    homeTeamId: r.home_team_id,
    awayTeamId: r.away_team_id,
    homeOffEpa: r.home_off_epa,
    homeDefEpa: r.home_def_epa,
    awayOffEpa: r.away_off_epa,
    awayDefEpa: r.away_def_epa,
  }));
}

export async function getPriorSeasonFinalRating(
  teamId: number,
  sport: Sport,
  priorSeason: number,
  method: "elo" | "ridge",
): Promise<number | undefined> {
  const result = await pool.query<{ rating: number }>(
    `SELECT rating FROM team_ratings
     WHERE team_id = $1 AND sport = $2 AND season = $3 AND method = $4
     ORDER BY through_week DESC LIMIT 1`,
    [teamId, sport, priorSeason, method],
  );
  return result.rows[0]?.rating;
}

export interface UpsertTeamRatingInput {
  teamId: number;
  sport: Sport;
  season: number;
  throughWeek: number;
  rating: number;
  ratingError: number | null;
  method: "elo" | "ridge";
}

export async function upsertTeamRating(input: UpsertTeamRatingInput): Promise<void> {
  await pool.query(
    `INSERT INTO team_ratings (team_id, sport, season, through_week, rating, rating_error, method, computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,now())
     ON CONFLICT (team_id, season, through_week, method)
     DO UPDATE SET rating = EXCLUDED.rating, rating_error = EXCLUDED.rating_error, computed_at = now()`,
    [input.teamId, input.sport, input.season, input.throughWeek, input.rating, input.ratingError, input.method],
  );
}

/** Most recent line pulled for a game, any book — the "market line at run time" the model anchors to. */
export async function getLatestMarketLine(gameId: number): Promise<number | undefined> {
  const result = await pool.query<{ spread_home: number }>(
    `SELECT spread_home FROM odds_snapshots
     WHERE game_id = $1 AND spread_home IS NOT NULL
     ORDER BY captured_at DESC LIMIT 1`,
    [gameId],
  );
  return result.rows[0]?.spread_home;
}

export interface GameSummary {
  id: number;
  homeTeamId: number;
  awayTeamId: number;
  status: "scheduled" | "in_progress" | "final";
}

export async function getGamesForWeek(sport: Sport, season: number, week: number): Promise<GameSummary[]> {
  const result = await pool.query<{ id: number; home_team_id: number; away_team_id: number; status: GameSummary["status"] }>(
    `SELECT id, home_team_id, away_team_id, status FROM games
     WHERE sport = $1 AND season = $2 AND week = $3
     ORDER BY id ASC`,
    [sport, season, week],
  );
  return result.rows.map((r) => ({ id: r.id, homeTeamId: r.home_team_id, awayTeamId: r.away_team_id, status: r.status }));
}

export interface UpsertModelPredictionInput {
  gameId: number;
  method: string;
  modelSpreadHome: number;
  modelTotal: number | null;
  confidence: number | null;
  marketSpreadHome: number | null;
}

export async function insertModelPrediction(input: UpsertModelPredictionInput): Promise<void> {
  await pool.query(
    `INSERT INTO model_predictions (game_id, method, model_spread_home, model_total, confidence, market_spread_home, predicted_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (game_id, method, predicted_at) DO NOTHING`,
    [input.gameId, input.method, input.modelSpreadHome, input.modelTotal, input.confidence, input.marketSpreadHome],
  );
}

/**
 * The opening line only — deliberately separate from getLatestMarketLine
 * (which is fine for live polling, where "latest" can never be later than
 * now). A backtest must anchor to the opening line specifically: taking
 * the single latest snapshot for a historical game would frequently return
 * the closing line, silently handing the model information it wouldn't
 * have had at prediction time.
 */
export async function getOpeningLine(gameId: number): Promise<number | undefined> {
  const result = await pool.query<{ spread_home: number }>(
    `SELECT spread_home FROM odds_snapshots
     WHERE game_id = $1 AND snapshot_type = 'opening' AND spread_home IS NOT NULL
     ORDER BY captured_at ASC LIMIT 1`,
    [gameId],
  );
  return result.rows[0]?.spread_home;
}

export async function getClosingLine(gameId: number): Promise<number | undefined> {
  const result = await pool.query<{ spread_home: number }>(
    `SELECT spread_home FROM odds_snapshots
     WHERE game_id = $1 AND snapshot_type = 'closing' AND spread_home IS NOT NULL
     ORDER BY captured_at DESC LIMIT 1`,
    [gameId],
  );
  return result.rows[0]?.spread_home;
}

export async function getDistinctWeeks(sport: Sport, season: number): Promise<number[]> {
  const result = await pool.query<{ week: number }>(
    `SELECT DISTINCT week FROM games WHERE sport = $1 AND season = $2 AND status = 'final' ORDER BY week ASC`,
    [sport, season],
  );
  return result.rows.map((r) => r.week);
}

export interface FinalGame {
  id: number;
  homeTeamId: number;
  awayTeamId: number;
  homeScore: number;
  awayScore: number;
}

export async function getFinalGamesForWeek(sport: Sport, season: number, week: number): Promise<FinalGame[]> {
  const result = await pool.query<{
    id: number;
    home_team_id: number;
    away_team_id: number;
    home_score: number;
    away_score: number;
  }>(
    `SELECT id, home_team_id, away_team_id, home_score, away_score
     FROM games
     WHERE sport = $1 AND season = $2 AND week = $3 AND status = 'final'
       AND home_score IS NOT NULL AND away_score IS NOT NULL
     ORDER BY id ASC`,
    [sport, season, week],
  );
  return result.rows.map((r) => ({
    id: r.id,
    homeTeamId: r.home_team_id,
    awayTeamId: r.away_team_id,
    homeScore: r.home_score,
    awayScore: r.away_score,
  }));
}

export interface LatestPrediction {
  modelSpreadHome: number;
  confidence: number | null;
}

export async function getLatestPrediction(gameId: number, method: string): Promise<LatestPrediction | undefined> {
  const result = await pool.query<{ model_spread_home: number; confidence: number | null }>(
    `SELECT model_spread_home, confidence FROM model_predictions
     WHERE game_id = $1 AND method = $2
     ORDER BY predicted_at DESC LIMIT 1`,
    [gameId, method],
  );
  const row = result.rows[0];
  return row ? { modelSpreadHome: row.model_spread_home, confidence: row.confidence } : undefined;
}

export interface InsertBacktestRunInput {
  name: string;
  method: string;
  seasonStart: number;
  seasonEnd: number;
  params: Record<string, unknown>;
}

export async function insertBacktestRun(input: InsertBacktestRunInput): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO backtest_runs (name, method, season_start, season_end, params)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [input.name, input.method, input.seasonStart, input.seasonEnd, JSON.stringify(input.params)],
  );
  return result.rows[0]!.id;
}

export interface InsertBacktestResultInput {
  backtestRunId: number;
  gameId: number;
  modelSpreadHome: number;
  /** Null when no opening line exists for this game — see clv's doc. */
  openingSpreadHome: number | null;
  closingSpreadHome: number;
  actualMarginHome: number;
  /** Null when openingSpreadHome is null — true CLV needs an opening price to compare against. */
  clv: number | null;
  covered: boolean | null;
  beatClose: boolean | null;
  /** The prediction's own error estimate at the time it was made — see ratings/elo.ts's predictSpread. */
  confidence: number | null;
}

export async function insertBacktestResult(input: InsertBacktestResultInput): Promise<void> {
  await pool.query(
    `INSERT INTO backtest_results (
       backtest_run_id, game_id, model_spread_home, opening_spread_home, closing_spread_home,
       actual_margin_home, clv, covered, beat_close, confidence
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (backtest_run_id, game_id)
     DO UPDATE SET model_spread_home = EXCLUDED.model_spread_home, opening_spread_home = EXCLUDED.opening_spread_home,
       closing_spread_home = EXCLUDED.closing_spread_home, actual_margin_home = EXCLUDED.actual_margin_home,
       clv = EXCLUDED.clv, covered = EXCLUDED.covered, beat_close = EXCLUDED.beat_close, confidence = EXCLUDED.confidence`,
    [
      input.backtestRunId,
      input.gameId,
      input.modelSpreadHome,
      input.openingSpreadHome,
      input.closingSpreadHome,
      input.actualMarginHome,
      input.clv,
      input.covered,
      input.beatClose,
      input.confidence,
    ],
  );
}

export interface BacktestRunSummary {
  id: number;
  name: string;
  method: string;
  sport: string | null;
  seasonStart: number;
  seasonEnd: number;
  createdAt: Date;
}

export async function listBacktestRuns(): Promise<BacktestRunSummary[]> {
  const result = await pool.query<{
    id: number;
    name: string;
    method: string;
    params: { sport?: string } | null;
    season_start: number;
    season_end: number;
    created_at: Date;
  }>(`SELECT id, name, method, params, season_start, season_end, created_at FROM backtest_runs ORDER BY id DESC`);
  return result.rows.map((r) => ({
    id: r.id,
    name: r.name,
    method: r.method,
    sport: r.params?.sport ?? null,
    seasonStart: r.season_start,
    seasonEnd: r.season_end,
    createdAt: r.created_at,
  }));
}

export interface TeamRatingRow {
  teamName: string;
  rating: number;
  ratingError: number | null;
}

export async function getTeamRatingsForWeek(sport: Sport, season: number, throughWeek: number): Promise<TeamRatingRow[]> {
  const result = await pool.query<{ name: string; rating: number; rating_error: number | null }>(
    `SELECT t.name, tr.rating, tr.rating_error
     FROM team_ratings tr JOIN teams t ON t.id = tr.team_id
     WHERE tr.sport = $1 AND tr.season = $2 AND tr.through_week = $3 AND tr.method = 'elo'
     ORDER BY tr.rating DESC`,
    [sport, season, throughWeek],
  );
  return result.rows.map((r) => ({ teamName: r.name, rating: r.rating, ratingError: r.rating_error }));
}

export interface PredictionRow {
  gameId: number;
  homeTeam: string;
  awayTeam: string;
  modelSpreadHome: number;
  marketSpreadHome: number | null;
  confidence: number | null;
}

export async function getPredictionsForWeek(sport: Sport, season: number, week: number): Promise<PredictionRow[]> {
  const result = await pool.query<{
    game_id: number;
    home: string;
    away: string;
    model_spread_home: number;
    market_spread_home: number | null;
    confidence: number | null;
  }>(
    `SELECT DISTINCT ON (g.id) g.id AS game_id, ht.name AS home, at.name AS away,
            mp.model_spread_home, mp.market_spread_home, mp.confidence
     FROM model_predictions mp
     JOIN games g ON g.id = mp.game_id
     JOIN teams ht ON ht.id = g.home_team_id
     JOIN teams at ON at.id = g.away_team_id
     WHERE g.sport = $1 AND g.season = $2 AND g.week = $3 AND mp.method = 'elo'
     ORDER BY g.id, mp.predicted_at DESC`,
    [sport, season, week],
  );
  return result.rows.map((r) => ({
    gameId: r.game_id,
    homeTeam: r.home,
    awayTeam: r.away,
    modelSpreadHome: r.model_spread_home,
    marketSpreadHome: r.market_spread_home,
    confidence: r.confidence,
  }));
}
