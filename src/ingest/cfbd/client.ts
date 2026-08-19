import { requireCfbdApiKey } from "../../config.js";

const BASE_URL = "https://api.collegefootballdata.com";

async function cfbdGet<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
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
}

export function getGames(year: number, seasonType: "regular" | "postseason" = "regular"): Promise<CfbdGame[]> {
  return cfbdGet<CfbdGame[]>("/games", { year, seasonType, division: "fbs" });
}

interface CfbdAdvancedSplit {
  ppa: number | null;
  successRate: number | null;
}

interface CfbdAdvancedSide {
  plays: number | null;
  ppa: number | null;
  successRate: number | null;
  rushingPlays?: CfbdAdvancedSplit;
  passingPlays?: CfbdAdvancedSplit;
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
): Promise<CfbdGameAdvancedStats[]> {
  return cfbdGet<CfbdGameAdvancedStats[]>("/stats/game/advanced", { year, week, seasonType });
}

// UNVERIFIED shape — recalled from CFBD's documented /lines response, not
// confirmed against a real call (this sandbox has no CFBD_API_KEY and no
// network path to the API). Parsed defensively in syncHistoricalOdds.ts;
// treat the actual field names and spread sign convention as unconfirmed
// until a real response has been inspected (see README "Odds data").
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
