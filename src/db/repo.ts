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
  /** Actual precipitation (not a probability) — only ever set by historical/archive weather, never the live forecast path. See migration 0004. */
  precipitationActual?: number | null;
  isDome: boolean;
  source: string;
}

export async function upsertWeather(input: UpsertWeatherInput): Promise<void> {
  await pool.query(
    `INSERT INTO weather (game_id, forecast_at, temp_f, wind_mph, precipitation_probability, precipitation_actual, is_dome, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (game_id)
     DO UPDATE SET forecast_at = EXCLUDED.forecast_at, temp_f = EXCLUDED.temp_f,
       wind_mph = EXCLUDED.wind_mph, precipitation_probability = EXCLUDED.precipitation_probability,
       precipitation_actual = EXCLUDED.precipitation_actual,
       is_dome = EXCLUDED.is_dome, source = EXCLUDED.source`,
    [
      input.gameId,
      input.forecastAt,
      input.tempF,
      input.windMph,
      input.precipitationProbability,
      input.precipitationActual ?? null,
      input.isDome,
      input.source,
    ],
  );
}

export interface CompletedGameForWeather {
  id: number;
  gameDate: Date;
  homeTeamSourceId: string;
  /** This game's own CFBD/nflverse source_id — used to re-look-up CFBD venue data for CFB. */
  sourceId: string;
}

/** Completed games needing a historical weather backfill — unlike getUpcomingGames, no date-range filter (any past completed game). */
export async function getCompletedGamesForWeather(
  sport: Sport,
  seasonStart: number,
  seasonEnd: number,
): Promise<CompletedGameForWeather[]> {
  const result = await pool.query<{ id: number; game_date: Date; source_id: string; game_source_id: string }>(
    `SELECT g.id, g.game_date, t.source_id, g.source_id AS game_source_id
     FROM games g JOIN teams t ON t.id = g.home_team_id
     WHERE g.sport = $1 AND g.season BETWEEN $2 AND $3 AND g.status = 'final' AND g.game_date IS NOT NULL`,
    [sport, seasonStart, seasonEnd],
  );
  return result.rows.map((r) => ({
    id: r.id,
    gameDate: r.game_date,
    homeTeamSourceId: r.source_id,
    sourceId: r.game_source_id,
  }));
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

export interface UpsertGarbageTimeStatsInput {
  gameId: number;
  teamId: number;
  offEpaPlayNoGarbage: number | null;
  defEpaPlayNoGarbage: number | null;
  offSuccessRateNoGarbage: number | null;
  defSuccessRateNoGarbage: number | null;
}

/**
 * A targeted UPDATE onto an existing team_game_stats row (from
 * upsertTeamGameStats's normal all-plays ingestion) with the same game's
 * garbage-time-excluded EPA/success rate, from a second CFBD call with
 * excludeGarbageTime=true. Not an upsert -- there's nothing sensible to
 * INSERT here on its own (is_home/plays/source etc. all come from the
 * all-plays row), so a game with no prior row is a no-op (0 rows
 * affected), same as any other "the base row doesn't exist yet" case in
 * this ingestion pipeline.
 */
export async function upsertGarbageTimeStats(input: UpsertGarbageTimeStatsInput): Promise<void> {
  await pool.query(
    `UPDATE team_game_stats
     SET off_epa_play_no_garbage = $3, def_epa_play_no_garbage = $4,
         off_success_rate_no_garbage = $5, def_success_rate_no_garbage = $6
     WHERE game_id = $1 AND team_id = $2`,
    [
      input.gameId,
      input.teamId,
      input.offEpaPlayNoGarbage,
      input.defEpaPlayNoGarbage,
      input.offSuccessRateNoGarbage,
      input.defSuccessRateNoGarbage,
    ],
  );
}

export interface UpsertTurnoverStatsInput {
  gameId: number;
  teamId: number;
  offTurnoverPpaSum: number;
  offTurnoverPlays: number;
  defTurnoverPpaSum: number;
  defTurnoverPlays: number;
}

/**
 * Same shape as upsertGarbageTimeStats: a targeted UPDATE onto an existing
 * team_game_stats row, not an upsert (there's nothing sensible to INSERT
 * here on its own). A game with no prior row is a no-op, same as the
 * garbage-time pass. offTurnoverPpaSum/offTurnoverPlays are turnovers this
 * team's OFFENSE committed; defTurnoverPpaSum/defTurnoverPlays are
 * turnovers this team's DEFENSE forced — see
 * ingest/cfbd/syncTurnoverStats.ts for how these are aggregated from
 * /plays. A team with zero turnovers on a side still gets a real row here
 * (sum=0, plays=0), which is a meaningfully different fact from "not yet
 * ingested" (both null) — ratings/elo.ts's turnoverLuckWeight blend treats
 * only the latter as missing data to fall back from.
 */
export async function upsertTurnoverStats(input: UpsertTurnoverStatsInput): Promise<void> {
  await pool.query(
    `UPDATE team_game_stats
     SET off_turnover_ppa_sum = $3, off_turnover_plays = $4,
         def_turnover_ppa_sum = $5, def_turnover_plays = $6
     WHERE game_id = $1 AND team_id = $2`,
    [input.gameId, input.teamId, input.offTurnoverPpaSum, input.offTurnoverPlays, input.defTurnoverPpaSum, input.defTurnoverPlays],
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
  /** Success rate alongside EPA — see ratings/elo.ts's GameForRating doc. Nullable: not required for a game to be included (only EPA is), so ratings/elo.ts's successRateWeight blend falls back to pure EPA when any of these four is missing. */
  homeOffSuccess: number | null;
  homeDefSuccess: number | null;
  awayOffSuccess: number | null;
  awayDefSuccess: number | null;
  /** Garbage-time-excluded EPA/success rate, from a second CFBD call with excludeGarbageTime=true (see ingest/cfbd/syncStats.ts's syncCfbdGarbageTimeStats). Nullable: only populated where that second ingestion pass has run; ratings/elo.ts falls back to the all-plays fields above when null, same pattern as the success-rate fields. */
  homeOffEpaNoGarbage: number | null;
  homeDefEpaNoGarbage: number | null;
  awayOffEpaNoGarbage: number | null;
  awayDefEpaNoGarbage: number | null;
  homeOffSuccessNoGarbage: number | null;
  homeDefSuccessNoGarbage: number | null;
  awayOffSuccessNoGarbage: number | null;
  awayDefSuccessNoGarbage: number | null;
  /** Total offensive/defensive plays each side's off_epa_play/def_epa_play average was computed over — needed to reweight the average when RatingParams.turnoverLuckWeight strips turnover plays out (see ratings/elo.ts's computeSeasonRatings). Nullable only in the sense that the underlying column is nullable for very old rows; treated the same as a missing turnover-stats row (falls back to raw EPA) when null. */
  homeOffPlays: number | null;
  homeDefPlays: number | null;
  awayOffPlays: number | null;
  awayDefPlays: number | null;
  /** Turnover-play PPA sums + counts, from a separate CFBD /plays ingestion pass (see ingest/cfbd/syncTurnoverStats.ts). off_* = turnovers this team's OFFENSE committed (lost the ball); def_* = turnovers this team's DEFENSE forced. Nullable: only populated where that ingestion pass has run; ratings/elo.ts falls back to raw EPA (turnoverLuckWeight has no effect) when any of these four is null for a game. */
  homeOffTurnoverPpaSum: number | null;
  homeOffTurnoverPlays: number | null;
  homeDefTurnoverPpaSum: number | null;
  homeDefTurnoverPlays: number | null;
  awayOffTurnoverPpaSum: number | null;
  awayOffTurnoverPlays: number | null;
  awayDefTurnoverPpaSum: number | null;
  awayDefTurnoverPlays: number | null;
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
    home_off_success: number | null;
    home_def_success: number | null;
    away_off_success: number | null;
    away_def_success: number | null;
    home_off_epa_no_garbage: number | null;
    home_def_epa_no_garbage: number | null;
    away_off_epa_no_garbage: number | null;
    away_def_epa_no_garbage: number | null;
    home_off_success_no_garbage: number | null;
    home_def_success_no_garbage: number | null;
    away_off_success_no_garbage: number | null;
    away_def_success_no_garbage: number | null;
    home_off_plays: number | null;
    home_def_plays: number | null;
    away_off_plays: number | null;
    away_def_plays: number | null;
    home_off_turnover_ppa_sum: number | null;
    home_off_turnover_plays: number | null;
    home_def_turnover_ppa_sum: number | null;
    home_def_turnover_plays: number | null;
    away_off_turnover_ppa_sum: number | null;
    away_off_turnover_plays: number | null;
    away_def_turnover_ppa_sum: number | null;
    away_def_turnover_plays: number | null;
  }>(
    `SELECT g.id AS game_id, g.week, g.home_team_id, g.away_team_id,
            home_stats.off_epa_play AS home_off_epa, home_stats.def_epa_play AS home_def_epa,
            away_stats.off_epa_play AS away_off_epa, away_stats.def_epa_play AS away_def_epa,
            home_stats.off_success_rate AS home_off_success, home_stats.def_success_rate AS home_def_success,
            away_stats.off_success_rate AS away_off_success, away_stats.def_success_rate AS away_def_success,
            home_stats.off_epa_play_no_garbage AS home_off_epa_no_garbage, home_stats.def_epa_play_no_garbage AS home_def_epa_no_garbage,
            away_stats.off_epa_play_no_garbage AS away_off_epa_no_garbage, away_stats.def_epa_play_no_garbage AS away_def_epa_no_garbage,
            home_stats.off_success_rate_no_garbage AS home_off_success_no_garbage, home_stats.def_success_rate_no_garbage AS home_def_success_no_garbage,
            away_stats.off_success_rate_no_garbage AS away_off_success_no_garbage, away_stats.def_success_rate_no_garbage AS away_def_success_no_garbage,
            home_stats.plays_offense AS home_off_plays, home_stats.plays_defense AS home_def_plays,
            away_stats.plays_offense AS away_off_plays, away_stats.plays_defense AS away_def_plays,
            home_stats.off_turnover_ppa_sum AS home_off_turnover_ppa_sum, home_stats.off_turnover_plays AS home_off_turnover_plays,
            home_stats.def_turnover_ppa_sum AS home_def_turnover_ppa_sum, home_stats.def_turnover_plays AS home_def_turnover_plays,
            away_stats.off_turnover_ppa_sum AS away_off_turnover_ppa_sum, away_stats.off_turnover_plays AS away_off_turnover_plays,
            away_stats.def_turnover_ppa_sum AS away_def_turnover_ppa_sum, away_stats.def_turnover_plays AS away_def_turnover_plays
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
    homeOffSuccess: r.home_off_success,
    homeDefSuccess: r.home_def_success,
    awayOffSuccess: r.away_off_success,
    awayDefSuccess: r.away_def_success,
    homeOffEpaNoGarbage: r.home_off_epa_no_garbage,
    homeDefEpaNoGarbage: r.home_def_epa_no_garbage,
    awayOffEpaNoGarbage: r.away_off_epa_no_garbage,
    awayDefEpaNoGarbage: r.away_def_epa_no_garbage,
    homeOffSuccessNoGarbage: r.home_off_success_no_garbage,
    homeDefSuccessNoGarbage: r.home_def_success_no_garbage,
    awayOffSuccessNoGarbage: r.away_off_success_no_garbage,
    awayDefSuccessNoGarbage: r.away_def_success_no_garbage,
    homeOffPlays: r.home_off_plays,
    homeDefPlays: r.home_def_plays,
    awayOffPlays: r.away_off_plays,
    awayDefPlays: r.away_def_plays,
    homeOffTurnoverPpaSum: r.home_off_turnover_ppa_sum,
    homeOffTurnoverPlays: r.home_off_turnover_plays,
    homeDefTurnoverPpaSum: r.home_def_turnover_ppa_sum,
    homeDefTurnoverPlays: r.home_def_turnover_plays,
    awayOffTurnoverPpaSum: r.away_off_turnover_ppa_sum,
    awayOffTurnoverPlays: r.away_off_turnover_plays,
    awayDefTurnoverPpaSum: r.away_def_turnover_ppa_sum,
    awayDefTurnoverPlays: r.away_def_turnover_plays,
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

export interface ExternalRatingInput {
  teamId: number;
  season: number;
  /** null = season-final value (cfbd_sp, which has no week granularity). */
  week: number | null;
  source: "cfbd_sp" | "cfbd_elo" | "manual_sp_weekly";
  rating: number;
}

/** See db/migrations/0003_external_ratings.sql for why this is two partial-index upserts, not one. */
export async function upsertExternalRating(input: ExternalRatingInput): Promise<void> {
  if (input.week === null) {
    await pool.query(
      `INSERT INTO external_ratings (team_id, season, week, source, rating)
       VALUES ($1, $2, NULL, $3, $4)
       ON CONFLICT (team_id, season, source) WHERE week IS NULL
       DO UPDATE SET rating = EXCLUDED.rating`,
      [input.teamId, input.season, input.source, input.rating],
    );
  } else {
    await pool.query(
      `INSERT INTO external_ratings (team_id, season, week, source, rating)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (team_id, season, week, source) WHERE week IS NOT NULL
       DO UPDATE SET rating = EXCLUDED.rating`,
      [input.teamId, input.season, input.week, input.source, input.rating],
    );
  }
}

/** Season Y-1's SP+ used as season Y's rating prior — see client.ts's getSpRatings doc. */
export async function getPriorSeasonSpRating(teamId: number, priorSeason: number): Promise<number | undefined> {
  const result = await pool.query<{ rating: number }>(
    `SELECT rating FROM external_ratings WHERE team_id = $1 AND season = $2 AND source = 'cfbd_sp' AND week IS NULL`,
    [teamId, priorSeason],
  );
  return result.rows[0]?.rating;
}

/**
 * Every team's CFBD SP+ (overall) for a given season — the population a
 * single team's z-score is computed against for RatingParams.spSignalPoints
 * (see ratings/elo.ts's predictSpread doc). SP+ has no week granularity
 * (see ingest/cfbd/client.ts's getSpRatings doc), so unlike
 * getCfbdEloDistributionForWeek this is one distribution per season, not
 * per week — callers pass the PRIOR season (the only "safe use" this
 * project has found for SP+, see getPriorSeasonSpRating's doc).
 */
export async function getCfbdSpDistributionForSeason(sport: Sport, season: number): Promise<Map<number, number>> {
  const result = await pool.query<{ team_id: number; rating: number }>(
    `SELECT er.team_id, er.rating
     FROM external_ratings er
     JOIN teams t ON t.id = er.team_id
     WHERE t.sport = $1 AND er.season = $2 AND er.week IS NULL AND er.source = 'cfbd_sp'`,
    [sport, season],
  );
  return new Map(result.rows.map((r) => [r.team_id, r.rating]));
}

/** Every team's CFBD Elo as of a given week — the population a single team's z-score is computed against. */
export async function getCfbdEloDistributionForWeek(
  sport: Sport,
  season: number,
  week: number,
): Promise<Map<number, number>> {
  const result = await pool.query<{ team_id: number; rating: number }>(
    `SELECT er.team_id, er.rating
     FROM external_ratings er
     JOIN teams t ON t.id = er.team_id
     WHERE t.sport = $1 AND er.season = $2 AND er.week = $3 AND er.source = 'cfbd_elo'`,
    [sport, season, week],
  );
  return new Map(result.rows.map((r) => [r.team_id, r.rating]));
}

/**
 * Same shape as getCfbdEloDistributionForWeek, but for 'manual_sp_weekly' —
 * real week-by-week SP+ from a manually-provided archive (see
 * ingest/manual/syncManualSpWeekly.ts), not a live CFBD pull. Currently
 * only populated for 2025 (the one season a real archive exists for) —
 * any other season/week returns an empty map, same "not available yet"
 * degrade as CFBD Elo's own early-season gap.
 */
export async function getManualSpWeeklyDistributionForWeek(
  sport: Sport,
  season: number,
  week: number,
): Promise<Map<number, number>> {
  const result = await pool.query<{ team_id: number; rating: number }>(
    `SELECT er.team_id, er.rating
     FROM external_ratings er
     JOIN teams t ON t.id = er.team_id
     WHERE t.sport = $1 AND er.season = $2 AND er.week = $3 AND er.source = 'manual_sp_weekly'`,
    [sport, season, week],
  );
  return new Map(result.rows.map((r) => [r.team_id, r.rating]));
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
  /**
   * (home team's days since their prior game) - (away team's days since
   * theirs), within the same sport/season — the ratings/elo.ts
   * predictSpread pointsPerRestDay input. Null when either team has no
   * prior game this season yet (week 1, or a scheduling gap the data
   * doesn't cover) rather than guessing a value — predictSpread treats
   * null as "no adjustment," not "0 days rest" for one side, since the
   * latter would read as maximally fatigued rather than unknown.
   */
  restDaysDiff: number | null;
}

export async function getGamesForWeek(sport: Sport, season: number, week: number): Promise<GameSummary[]> {
  const result = await pool.query<{
    id: number;
    home_team_id: number;
    away_team_id: number;
    status: GameSummary["status"];
    rest_days_diff: number | null;
  }>(
    `SELECT g.id, g.home_team_id, g.away_team_id, g.status,
            -- (home's days since their last game) - (away's days since theirs). g.game_date
            -- cancels algebraically ((g - home_prior) - (g - away_prior) = away_prior - home_prior),
            -- so this is computed directly rather than as two separately-truncated intervals.
            CASE WHEN home_prior.game_date IS NULL OR away_prior.game_date IS NULL THEN NULL
                 ELSE ROUND((EXTRACT(EPOCH FROM (away_prior.game_date - home_prior.game_date)) / 86400)::numeric)
            END AS rest_days_diff
     FROM games g
     LEFT JOIN LATERAL (
       SELECT g2.game_date FROM games g2
       WHERE g2.sport = g.sport AND g2.season = g.season AND g2.status = 'final'
         AND (g2.home_team_id = g.home_team_id OR g2.away_team_id = g.home_team_id)
         AND g2.game_date < g.game_date
       ORDER BY g2.game_date DESC LIMIT 1
     ) home_prior ON true
     LEFT JOIN LATERAL (
       SELECT g2.game_date FROM games g2
       WHERE g2.sport = g.sport AND g2.season = g.season AND g2.status = 'final'
         AND (g2.home_team_id = g.away_team_id OR g2.away_team_id = g.away_team_id)
         AND g2.game_date < g.game_date
       ORDER BY g2.game_date DESC LIMIT 1
     ) away_prior ON true
     WHERE g.sport = $1 AND g.season = $2 AND g.week = $3
     ORDER BY g.id ASC`,
    [sport, season, week],
  );
  return result.rows.map((r) => ({
    id: r.id,
    homeTeamId: r.home_team_id,
    awayTeamId: r.away_team_id,
    status: r.status,
    restDaysDiff: r.rest_days_diff,
  }));
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
  teamId: number;
  teamName: string;
  rating: number;
  ratingError: number | null;
}

export async function getTeamRatingsForWeek(sport: Sport, season: number, throughWeek: number): Promise<TeamRatingRow[]> {
  const result = await pool.query<{ team_id: number; name: string; rating: number; rating_error: number | null }>(
    `SELECT t.id AS team_id, t.name, tr.rating, tr.rating_error
     FROM team_ratings tr JOIN teams t ON t.id = tr.team_id
     WHERE tr.sport = $1 AND tr.season = $2 AND tr.through_week = $3 AND tr.method = 'elo'
     ORDER BY tr.rating DESC`,
    [sport, season, throughWeek],
  );
  return result.rows.map((r) => ({ teamId: r.team_id, teamName: r.name, rating: r.rating, ratingError: r.rating_error }));
}

export interface TeamInfo {
  id: number;
  name: string;
  sport: Sport;
  conference: string | null;
}

export async function getTeamById(teamId: number): Promise<TeamInfo | undefined> {
  const result = await pool.query<{ id: number; name: string; sport: Sport; conference: string | null }>(
    `SELECT id, name, sport, conference FROM teams WHERE id = $1`,
    [teamId],
  );
  return result.rows[0];
}

export interface RatingHistoryPoint {
  season: number;
  throughWeek: number;
  rating: number;
}

/** A team's full rating trajectory across every season/week checkpoint it's been rated at, oldest first. */
export async function getRatingHistoryForTeam(teamId: number, sport: Sport): Promise<RatingHistoryPoint[]> {
  const result = await pool.query<{ season: number; through_week: number; rating: number }>(
    `SELECT season, through_week, rating FROM team_ratings
     WHERE team_id = $1 AND sport = $2 AND method = 'elo'
     ORDER BY season ASC, through_week ASC`,
    [teamId, sport],
  );
  return result.rows.map((r) => ({ season: r.season, throughWeek: r.through_week, rating: r.rating }));
}

export interface GameHistoryRow {
  gameId: number;
  week: number;
  gameDate: Date | null;
  homeTeam: string;
  awayTeam: string;
  homeScore: number | null;
  awayScore: number | null;
  status: string;
  openingSpreadHome: number | null;
  closingSpreadHome: number | null;
}

/** Every game in a sport/season (any week, any status) with team names and opening/closing lines -- the raw historical-data browser behind /games. */
export async function getGameHistoryForSeason(sport: Sport, season: number): Promise<GameHistoryRow[]> {
  const result = await pool.query<{
    game_id: number;
    week: number;
    game_date: Date | null;
    home: string;
    away: string;
    home_score: number | null;
    away_score: number | null;
    status: string;
    opening_spread_home: number | null;
    closing_spread_home: number | null;
  }>(
    `SELECT g.id AS game_id, g.week, g.game_date, ht.name AS home, at.name AS away,
            g.home_score, g.away_score, g.status,
            (SELECT os.spread_home FROM odds_snapshots os
             WHERE os.game_id = g.id AND os.snapshot_type = 'opening' AND os.spread_home IS NOT NULL
             ORDER BY os.captured_at ASC LIMIT 1) AS opening_spread_home,
            (SELECT os.spread_home FROM odds_snapshots os
             WHERE os.game_id = g.id AND os.snapshot_type = 'closing' AND os.spread_home IS NOT NULL
             ORDER BY os.captured_at DESC LIMIT 1) AS closing_spread_home
     FROM games g
     JOIN teams ht ON ht.id = g.home_team_id
     JOIN teams at ON at.id = g.away_team_id
     WHERE g.sport = $1 AND g.season = $2
     ORDER BY g.week ASC, g.game_date ASC NULLS LAST, g.id ASC`,
    [sport, season],
  );
  return result.rows.map((r) => ({
    gameId: r.game_id,
    week: r.week,
    gameDate: r.game_date,
    homeTeam: r.home,
    awayTeam: r.away,
    homeScore: r.home_score,
    awayScore: r.away_score,
    status: r.status,
    openingSpreadHome: r.opening_spread_home,
    closingSpreadHome: r.closing_spread_home,
  }));
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

export interface InsertPublicBettingSplitInput {
  gameId: number;
  book: string;
  capturedAt: string;
  betPctHome: number | null;
  betPctAway: number | null;
  moneyPctHome: number | null;
  moneyPctAway: number | null;
  source: string;
}

/**
 * Schema-ready, no real source wired up yet — see migration
 * 0005_public_betting_splits.sql's doc for what was researched and why
 * nothing was confirmed free/reliable enough to ingest from tonight.
 */
export async function insertPublicBettingSplit(input: InsertPublicBettingSplitInput): Promise<void> {
  await pool.query(
    `INSERT INTO public_betting_splits (game_id, book, captured_at, bet_pct_home, bet_pct_away, money_pct_home, money_pct_away, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (game_id, book, captured_at)
     DO UPDATE SET bet_pct_home = EXCLUDED.bet_pct_home, bet_pct_away = EXCLUDED.bet_pct_away,
       money_pct_home = EXCLUDED.money_pct_home, money_pct_away = EXCLUDED.money_pct_away`,
    [
      input.gameId,
      input.book,
      input.capturedAt,
      input.betPctHome,
      input.betPctAway,
      input.moneyPctHome,
      input.moneyPctAway,
      input.source,
    ],
  );
}
