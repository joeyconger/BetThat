import { getGames } from "./client.js";
import { findTeamId, upsertGame } from "../../db/repo.js";

export async function syncCfbdGames(
  year: number,
  seasonType: "regular" | "postseason" = "regular",
): Promise<{ synced: number; skipped: number }> {
  const games = await getGames(year, seasonType);
  let synced = 0;
  let skipped = 0;

  for (const game of games) {
    const homeTeamId = await findTeamId("cfb", String(game.homeId));
    const awayTeamId = await findTeamId("cfb", String(game.awayId));
    if (!homeTeamId || !awayTeamId) {
      // team not FBS (no conference) or not yet synced — run syncCfbdTeams first
      skipped += 1;
      continue;
    }

    await upsertGame({
      sport: "cfb",
      season: game.season,
      week: game.week,
      seasonType,
      gameDate: game.startDate,
      homeTeamId,
      awayTeamId,
      homeScore: game.homePoints,
      awayScore: game.awayPoints,
      status: game.completed ? "final" : "scheduled",
      neutralSite: game.neutralSite,
      sourceId: String(game.id),
    });
    synced += 1;
  }

  return { synced, skipped };
}
