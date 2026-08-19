import { getGameAdvancedStats } from "./client.js";
import { findGameId, findTeamIdByName, getGameTeamIds, upsertTeamGameStats } from "../../db/repo.js";

export async function syncCfbdGameStats(
  year: number,
  seasonType: "regular" | "postseason" = "regular",
): Promise<{ synced: number; skipped: number }> {
  const rows = await getGameAdvancedStats(year, undefined, seasonType);
  let synced = 0;
  let skipped = 0;

  for (const row of rows) {
    const gameId = await findGameId("cfb", String(row.gameId));
    const teamId = await findTeamIdByName("cfb", row.team);
    if (!gameId || !teamId) {
      skipped += 1;
      continue;
    }
    const gameTeams = await getGameTeamIds(gameId);
    if (!gameTeams) {
      skipped += 1;
      continue;
    }

    await upsertTeamGameStats({
      gameId,
      teamId,
      isHome: gameTeams.homeTeamId === teamId,
      offEpaPlay: row.offense.ppa,
      offEpaPass: row.offense.passingPlays?.ppa ?? null,
      offEpaRush: row.offense.rushingPlays?.ppa ?? null,
      defEpaPlay: row.defense.ppa,
      defEpaPass: row.defense.passingPlays?.ppa ?? null,
      defEpaRush: row.defense.rushingPlays?.ppa ?? null,
      offSuccessRate: row.offense.successRate,
      offSuccessRatePass: row.offense.passingPlays?.successRate ?? null,
      offSuccessRateRush: row.offense.rushingPlays?.successRate ?? null,
      defSuccessRate: row.defense.successRate,
      defSuccessRatePass: row.defense.passingPlays?.successRate ?? null,
      defSuccessRateRush: row.defense.rushingPlays?.successRate ?? null,
      playsOffense: row.offense.plays,
      playsDefense: row.defense.plays,
      source: "cfbd",
    });
    synced += 1;
  }

  return { synced, skipped };
}
