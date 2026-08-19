import { requireOddsApiKey } from "../../config.js";

const BASE_URL = "https://api.the-odds-api.com/v4";

// The Odds API's `sport` keys for the two leagues this project cares about.
export const ODDS_API_SPORT_KEYS = {
  nfl: "americanfootball_nfl",
  cfb: "americanfootball_ncaaf",
} as const;

export interface OddsApiOutcome {
  name: string;
  price: number;
  point?: number;
}

export interface OddsApiMarket {
  key: "h2h" | "spreads" | "totals";
  outcomes: OddsApiOutcome[];
}

export interface OddsApiBookmaker {
  key: string;
  title: string;
  last_update: string;
  markets: OddsApiMarket[];
}

export interface OddsApiEvent {
  id: string;
  sport_key: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: OddsApiBookmaker[];
}

/**
 * Live/current lines only — this is what Phase 4 (weekly picks) polls for
 * market comparison and line-movement snapshots going forward. Historical
 * backtest data (Phase 3) intentionally does NOT come from here — The Odds
 * API's historical snapshot endpoint is metered per-market/per-region/
 * per-timestamp and would be expensive across 2-3 seasons; see
 * src/ingest/odds/sbrImport.ts and the README "Odds data" section instead.
 */
export async function getCurrentOdds(
  sportKey: string,
  markets: Array<"h2h" | "spreads" | "totals"> = ["spreads", "h2h", "totals"],
): Promise<OddsApiEvent[]> {
  const apiKey = requireOddsApiKey();
  const url = new URL(`${BASE_URL}/sports/${sportKey}/odds`);
  url.searchParams.set("apiKey", apiKey);
  url.searchParams.set("regions", "us");
  url.searchParams.set("markets", markets.join(","));
  url.searchParams.set("oddsFormat", "american");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Odds API request failed: ${res.status} ${res.statusText} — ${await res.text()}`);
  }
  return (await res.json()) as OddsApiEvent[];
}
