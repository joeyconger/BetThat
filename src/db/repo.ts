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
