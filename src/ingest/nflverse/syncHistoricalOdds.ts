import { SCHEDULES_URL, streamCsv } from "./client.js";
import { toGameDate } from "./syncSchedules.js";
import { findGameId, insertOddsSnapshot } from "../../db/repo.js";

function toNumber(raw: string | undefined): number | null {
  return raw === undefined || raw === "" ? null : Number(raw);
}

/**
 * The same games.csv file syncNflSchedules reads also carries a single
 * closing-line number per game (spread_line/total_line/moneylines), back
 * to 1999 — free, and far deeper than SportsbookReviewsOnline's archive
 * (which stops at 2021-22). There is no opening line in this file, only
 * closing — confirmed against nflverse's own data dictionary
 * (dictionary_schedules.csv in the nflreadr repo), which also documents
 * spread_line's sign convention as the OPPOSITE of this project's
 * (positive = home favored, vs. our negative = home favored) — negated
 * below. See README "Odds data" for how the backtest handles having only
 * a closing line for most historical games.
 */
export async function syncNflHistoricalOdds(season: number): Promise<{ synced: number; skipped: number }> {
  let synced = 0;
  let skipped = 0;

  for await (const row of streamCsv(SCHEDULES_URL)) {
    if (Number(row.season) !== season) continue;
    if (!row.spread_line) {
      skipped += 1;
      continue;
    }

    const gameId = await findGameId("nfl", row.game_id ?? "");
    if (!gameId) {
      skipped += 1;
      continue;
    }

    const capturedAt = toGameDate(row.gameday ?? "", row.gametime ?? "") ?? `${season}-01-01`;

    await insertOddsSnapshot({
      gameId,
      book: "nflverse_consensus",
      capturedAt,
      snapshotType: "closing",
      spreadHome: -Number(row.spread_line),
      spreadHomePrice: toNumber(row.home_spread_odds),
      spreadAwayPrice: toNumber(row.away_spread_odds),
      moneylineHome: toNumber(row.home_moneyline),
      moneylineAway: toNumber(row.away_moneyline),
      total: toNumber(row.total_line),
      totalOverPrice: toNumber(row.over_odds),
      totalUnderPrice: toNumber(row.under_odds),
      source: "nflverse",
    });
    synced += 1;
  }

  return { synced, skipped };
}
