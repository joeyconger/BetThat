import { getCurrentOdds, ODDS_API_SPORT_KEYS, type OddsApiEvent } from "./oddsApiClient.js";
import { findGameByTeamsAndDate, findTeamIdFuzzy, insertOddsSnapshot } from "../../db/repo.js";
import type { Sport } from "../../db/repo.js";

/** Picks the first book that quotes a spread as a simple consensus proxy. */
function pickConsensusBook(event: OddsApiEvent) {
  return event.bookmakers.find((b) => b.markets.some((m) => m.key === "spreads")) ?? event.bookmakers[0];
}

/**
 * Pulls current lines and records them as a 'movement' snapshot per game.
 * Intended to be run periodically (e.g. a scheduled Railway job) once Phase
 * 4 starts polling the market — see README. Games are matched by team +
 * kickoff time since The Odds API has no shared game ID with CFBD/nflverse.
 */
export async function syncCurrentOdds(sport: Sport): Promise<{ synced: number; skipped: number }> {
  const events = await getCurrentOdds(ODDS_API_SPORT_KEYS[sport]);
  let synced = 0;
  let skipped = 0;
  const capturedAt = new Date().toISOString();

  for (const event of events) {
    const homeTeamId = await findTeamIdFuzzy(sport, event.home_team);
    const awayTeamId = await findTeamIdFuzzy(sport, event.away_team);
    if (!homeTeamId || !awayTeamId) {
      skipped += 1;
      continue;
    }
    const gameId = await findGameByTeamsAndDate(sport, homeTeamId, awayTeamId, new Date(event.commence_time));
    if (!gameId) {
      skipped += 1;
      continue;
    }

    const book = pickConsensusBook(event);
    if (!book) {
      skipped += 1;
      continue;
    }

    const spreadMarket = book.markets.find((m) => m.key === "spreads");
    const h2hMarket = book.markets.find((m) => m.key === "h2h");
    const totalsMarket = book.markets.find((m) => m.key === "totals");

    const homeSpread = spreadMarket?.outcomes.find((o) => o.name === event.home_team);
    const awaySpread = spreadMarket?.outcomes.find((o) => o.name === event.away_team);
    const homeMoneyline = h2hMarket?.outcomes.find((o) => o.name === event.home_team);
    const awayMoneyline = h2hMarket?.outcomes.find((o) => o.name === event.away_team);
    const over = totalsMarket?.outcomes.find((o) => o.name === "Over");
    const under = totalsMarket?.outcomes.find((o) => o.name === "Under");

    await insertOddsSnapshot({
      gameId,
      book: book.key,
      capturedAt,
      snapshotType: "movement",
      spreadHome: homeSpread?.point ?? null,
      spreadHomePrice: homeSpread?.price ?? null,
      spreadAwayPrice: awaySpread?.price ?? null,
      moneylineHome: homeMoneyline?.price ?? null,
      moneylineAway: awayMoneyline?.price ?? null,
      total: over?.point ?? null,
      totalOverPrice: over?.price ?? null,
      totalUnderPrice: under?.price ?? null,
      source: "odds_api",
    });
    synced += 1;
  }

  return { synced, skipped };
}
