import { getLines } from "./client.js";
import { findGameId, getGameDate, insertOddsSnapshot } from "../../db/repo.js";

/**
 * UNVERIFIED against a real CFBD response (see client.ts's getLines doc) —
 * this is CFB's only candidate for a *both* opening-and-closing odds
 * source (nflverse, used for NFL, is closing-only). Run this once for real
 * and check the `odds_snapshots` rows it produces before trusting them for
 * anything, same as the ESPN injuries client's UNVERIFIED status.
 *
 * CFBD doesn't give real per-line timestamps, so captured_at is a rough
 * proxy: kickoff for closing, kickoff minus 6 days for opening. Only
 * matters as a NOT NULL placeholder here — getOpeningLine/getClosingLine
 * filter by snapshot_type first and this only ever inserts one row per
 * type per game, so the exact timestamp doesn't affect which row a lookup
 * returns.
 */
export async function syncCfbdHistoricalOdds(
  year: number,
  seasonType: "regular" | "postseason" = "regular",
): Promise<{ synced: number; skipped: number }> {
  const games = await getLines(year, seasonType);
  let synced = 0;
  let skipped = 0;

  for (const game of games) {
    const gameId = await findGameId("cfb", String(game.id));
    const line = game.lines?.find((l) => l.spread !== null && l.spread !== undefined);
    if (!gameId || !line) {
      skipped += 1;
      continue;
    }

    const gameDate = (await getGameDate(gameId)) ?? new Date(`${year}-09-01`);
    const closingAt = gameDate.toISOString();
    const openingAt = new Date(gameDate.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString();

    await insertOddsSnapshot({
      gameId,
      book: line.provider ?? "cfbd_consensus",
      capturedAt: closingAt,
      snapshotType: "closing",
      spreadHome: line.spread,
      spreadHomePrice: null,
      spreadAwayPrice: null,
      moneylineHome: line.homeMoneyline ?? null,
      moneylineAway: line.awayMoneyline ?? null,
      total: line.overUnder ?? null,
      totalOverPrice: null,
      totalUnderPrice: null,
      source: "cfbd",
    });

    if (line.spreadOpen !== null && line.spreadOpen !== undefined) {
      await insertOddsSnapshot({
        gameId,
        book: line.provider ?? "cfbd_consensus",
        capturedAt: openingAt,
        snapshotType: "opening",
        spreadHome: line.spreadOpen,
        spreadHomePrice: null,
        spreadAwayPrice: null,
        moneylineHome: null,
        moneylineAway: null,
        total: line.overUnderOpen ?? null,
        totalOverPrice: null,
        totalUnderPrice: null,
        source: "cfbd",
      });
    }

    synced += 1;
  }

  return { synced, skipped };
}
