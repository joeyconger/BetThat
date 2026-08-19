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
      // Either team isn't FBS (syncCfbdTeams only syncs FBS teams) or
      // teams haven't been synced yet for this year — run that first.
      // This also means an FBS-vs-FCS game is intentionally dropped here:
      // the FCS side never resolves, so the game never gets a home+away
      // pair. Deliberate — this project only rates FBS-vs-FBS games.
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
