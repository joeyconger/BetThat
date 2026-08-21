import { requireCfbdApiKey } from "../../config.js";

const BASE_URL = "https://api.collegefootballdata.com";

async function cfbdGet<T>(path: string, params: Record<string, string | number | boolean | undefined>): Promise<T> {
  const apiKey = requireCfbdApiKey();
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`CFBD ${path} failed: ${res.status} ${res.statusText} — ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export interface CfbdTeam {
  id: number;
  school: string;
  conference: string | null;
  classification: string | null;
}

export function getTeams(year: number): Promise<CfbdTeam[]> {
  return cfbdGet<CfbdTeam[]>("/teams", { year });
}

export interface CfbdGame {
  id: number;
  season: number;
  week: number;
  seasonType: string;
  startDate: string;
  completed: boolean;
  neutralSite: boolean;
  homeId: number;
  homeTeam: string;
  homePoints: number | null;
  awayId: number;
  awayTeam: string;
  awayPoints: number | null;
  venueId: number | null;
}

// NOTE: `division: "fbs"` does NOT actually filter server-side -- confirmed
// against a real response (cfb-verify-plays, 2026-08-21): it still returned
// hundreds of non-FBS games for a single week. syncGames.ts is unaffected
// (it resolves teams by ID against the FBS-only `teams` table and drops
// anything that doesn't resolve), but any OTHER caller of getGames must do
// its own client-side classification filter -- see syncTeams.ts's identical
// gotcha with /teams, and cfb-verify-plays's fbsNames filter for the pattern.
export function getGames(year: number, seasonType: "regular" | "postseason" = "regular"): Promise<CfbdGame[]> {
  return cfbdGet<CfbdGame[]>("/games", { year, seasonType, division: "fbs" });
}

export interface CfbdVenue {
  id: number;
  name: string;
  latitude: number | null;
  longitude: number | null;
  dome: boolean | null;
}

/**
 * Verified field names against CFBD's own Python client docs (id, name,
 * latitude, longitude, dome) — not yet checked against a real live
 * response from this sandbox (collegefootballdata.com is blocked here,
 * same as CFBD's other endpoints). No team-linking field on Venue itself;
 * join via CfbdGame.venueId instead, which correctly handles neutral-site
 * games too (a team-to-home-stadium map, the approach used for NFL, can't).
 */
export function getVenues(): Promise<CfbdVenue[]> {
  return cfbdGet<CfbdVenue[]>("/venues", {});
}

interface CfbdAdvancedSplit {
  ppa: number | null;
  successRate: number | null;
  explosiveness?: number | null;
}

/**
 * standardDowns/passingDowns and explosiveness -- confirmed real fields on
 * this exact endpoint via CFBD's own client library docs (AdvancedGameStatOffense,
 * AdvancedGameStatOffenseStandardDowns), not guessed -- see
 * ratings/config.ts's offExplosivenessWeight-family docs for how these
 * feed the rating model. camelCase here (not the Python client's snake_case
 * doc naming) to match this project's existing successRate/rushingPlays
 * fields on the same endpoint, which are already confirmed working against
 * real production responses.
 */
interface CfbdAdvancedSide {
  plays: number | null;
  ppa: number | null;
  successRate: number | null;
  explosiveness?: number | null;
  rushingPlays?: CfbdAdvancedSplit;
  passingPlays?: CfbdAdvancedSplit;
  standardDowns?: CfbdAdvancedSplit;
  passingDowns?: CfbdAdvancedSplit;
}

export interface CfbdGameAdvancedStats {
  gameId: number;
  week: number;
  team: string;
  opponent: string;
  offense: CfbdAdvancedSide;
  defense: CfbdAdvancedSide;
}

export function getGameAdvancedStats(
  year: number,
  week?: number,
  seasonType: "regular" | "postseason" = "regular",
  excludeGarbageTime?: boolean,
): Promise<CfbdGameAdvancedStats[]> {
  return cfbdGet<CfbdGameAdvancedStats[]>("/stats/game/advanced", {
    year,
    week,
    seasonType,
    excludeGarbageTime,
  });
}

// Verified against a real CFBD response — field names and spread sign
// convention (positive = away favored, negative = home favored, same as
// this project's schema) confirmed correct via 2024 season data checked
// against known game outcomes. See syncHistoricalOdds.ts for details.
export interface CfbdLineEntry {
  provider: string;
  spread: number | null;
  spreadOpen: number | null;
  overUnder: number | null;
  overUnderOpen: number | null;
  homeMoneyline: number | null;
  awayMoneyline: number | null;
}

export interface CfbdGameLines {
  id: number;
  season: number;
  week: number;
  homeTeam: string;
  awayTeam: string;
  lines: CfbdLineEntry[];
}

export function getLines(
  year: number,
  seasonType: "regular" | "postseason" = "regular",
): Promise<CfbdGameLines[]> {
  return cfbdGet<CfbdGameLines[]>("/lines", { year, seasonType });
}

export interface CfbdTeamSp {
  year: number;
  team: string;
  conference: string | null;
  rating: number | null;
}

/**
 * CFBD's /ratings/sp takes no week param — one value per team per year, not
 * a time series. Real risk: Connelly's SP+ methodology blends a genuine
 * preseason projection (recruiting, returning production, coaching changes)
 * into the in-season number and phases it out week by week, but this
 * endpoint gives no way to tell which point in that blend a given year's
 * value reflects — most likely the final, fully-season-informed number.
 * Only safe use found so far: season Y-1's value as season Y's rating
 * prior (no lookahead risk either way, since Y-1 is fully complete before Y
 * starts) — see ratings/elo.ts's computeInitialRating. UNVERIFIED against a
 * real response; check ingested values are in a plausible range (roughly
 * -30 to +30) before trusting.
 */
export function getSpRatings(year: number): Promise<CfbdTeamSp[]> {
  return cfbdGet<CfbdTeamSp[]>("/ratings/sp", { year });
}

export interface CfbdTeamElo {
  year: number;
  team: string;
  conference: string | null;
  elo: number | null;
}

/**
 * CFBD's own Elo system, unlike SP+ this does take a week param and is a
 * real time series — the only CFBD rating source that can give an
 * as-of-a-specific-week snapshot. UNVERIFIED: exact max week per season
 * (postseason inclusive?) and whether early/preseason weeks return data at
 * all haven't been confirmed against a real response — syncExternalRatings
 * loops a generous week range and treats empty results as "not available
 * that week" rather than an error.
 */
export function getEloRatings(
  year: number,
  week: number,
  seasonType: "regular" | "postseason" = "regular",
): Promise<CfbdTeamElo[]> {
  return cfbdGet<CfbdTeamElo[]>("/ratings/elo", { year, week, seasonType });
}

export interface CfbdPlayClock {
  minutes: number | null;
  seconds: number | null;
}

export interface CfbdPlay {
  id: string;
  gameId: number;
  offense: string;
  defense: string;
  period: number;
  down: number;
  distance: number;
  yardsGained: number;
  playType: string;
  ppa: number | null;
  /**
   * Fields beyond the original turnover/sack-rate-era set, added for raw
   * play-by-play storage (see db/migrations for the `plays` table) —
   * confirmed real fields via CFBD's actual Play model docs (not guessed).
   * Confirmed NOT present on this endpoint: a first-down indicator (derive
   * via yardsGained >= distance, a standard approximation — doesn't
   * account for penalties/other edge cases) and win probability (a
   * genuinely separate endpoint, getWinProbabilityData, ONE CALL PER GAME
   * — not pulled by default given the cost, ~800+ calls/season).
   */
  driveId: number;
  driveNumber: number;
  playNumber: number;
  home: string;
  away: string;
  offenseScore: number;
  defenseScore: number;
  yardLine: number;
  yardsToGoal: number;
  scoring: boolean;
  clock: CfbdPlayClock | null;
}

/**
 * Play-by-play data — year+week are BOTH required by this endpoint
 * (confirmed against the real CFBD client source, since the docs site
 * itself wasn't reachable from this environment; see client.ts's
 * getGameAdvancedStats doc for the same pattern with excludeGarbageTime).
 * One call per week, not per season, unlike every other endpoint this
 * project uses — a full season pull is ~13 calls, not 1.
 */
export function getPlays(
  year: number,
  week: number,
  seasonType: "regular" | "postseason" = "regular",
): Promise<CfbdPlay[]> {
  return cfbdGet<CfbdPlay[]>("/plays", { year, week, seasonType });
}

export interface CfbdPlayWinProbability {
  gamesId: number;
  playId: number;
  homeId: number;
  home: string;
  awayId: number;
  away: string;
  spread: number | null;
  homeBall: boolean;
  homeScore: number;
  awayScore: number;
  timeRemaining: number;
  yardLine: number;
  down: number;
  distance: number;
  // Confirmed real (cfb-verify-plays, 2026-08-21): some rows omit this key
  // entirely rather than sending JSON null, so it comes back JS-undefined
  // at runtime despite the declared `| null` -- TypeScript can't catch
  // this since JSON.parse's result is cast, not validated. Always check
  // with `== null`, not `=== null`, for both cases at once.
  homeWinProb?: number | null;
  playNumber: number;
}

/**
 * Play-by-play win probability — confirmed real via CFBD's client docs
 * (GET /metrics/wp), joinable back to a specific /plays row via playId or
 * playNumber. UNLIKE every other endpoint this project uses, this takes a
 * single gameId, not a year/week — there is no season-wide pull at all,
 * meaning a full season needs ~800+ calls (one per FBS game), not ~15.
 * Not wired into any ingestion job yet given that cost — build a job
 * scoped to a specific week/slate first if live win-probability-based
 * garbage-time weighting is wanted, rather than a blanket full-history
 * backfill. See RatingParams' garbage-time weighting doc for how the
 * score-differential/time-remaining fields already on /plays cover most
 * of the same signal without this endpoint.
 */
export function getWinProbabilityData(gameId: number): Promise<CfbdPlayWinProbability[]> {
  return cfbdGet<CfbdPlayWinProbability[]>("/metrics/wp", { gameId });
}

export interface CfbdDrive {
  offense: string;
  defense: string;
  gameId: number;
  driveNumber: number;
  startYardsToGoal: number;
  endYardsToGoal: number;
  driveResult: string;
  startOffenseScore: number;
  startDefenseScore: number;
  endOffenseScore: number;
  endDefenseScore: number;
}

/**
 * Drive-level data — UNLIKE /plays, `week` is optional here (confirmed via
 * CFBD's real client library docs: only `year` is required) so a whole
 * season comes back in ONE call, same "omit week for the full season"
 * shape as getGameAdvancedStats — not verified against a real response in
 * this sandbox (still no network route to CFBD itself), so
 * syncFinishingDrivesStats logs a raw drive count on first use as a sanity
 * check rather than trusting this blind. Used for the "finishing drives"
 * (points per scoring opportunity) component — see
 * RatingParams.pointsPerFinishingDrives' doc.
 */
export function getDrives(year: number, seasonType: "regular" | "postseason" = "regular"): Promise<CfbdDrive[]> {
  return cfbdGet<CfbdDrive[]>("/drives", { year, seasonType });
}
