import { getGameAdvancedStats } from "./client.js";
import { findGameId, findTeamIdByName, getGameTeamIds, upsertTeamGameStats, upsertGarbageTimeStats } from "../../db/repo.js";

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

/**
 * Second ingestion pass over the SAME endpoint (/stats/game/advanced) with
 * excludeGarbageTime=true, filling in team_game_stats' *_no_garbage
 * columns via a targeted UPDATE (upsertGarbageTimeStats) rather than a
 * fresh row — run syncCfbdGameStats first so the base row exists to update.
 * See RatingParams.excludeGarbageTime's doc in ratings/config.ts for why
 * this is a separate, optional, A/B-able pass rather than a replacement
 * for the all-plays stats.
 */
export async function syncCfbdGarbageTimeStats(
  year: number,
  seasonType: "regular" | "postseason" = "regular",
): Promise<{ synced: number; skipped: number }> {
  const rows = await getGameAdvancedStats(year, undefined, seasonType, true);
  let synced = 0;
  let skipped = 0;

  for (const row of rows) {
    const gameId = await findGameId("cfb", String(row.gameId));
    const teamId = await findTeamIdByName("cfb", row.team);
    if (!gameId || !teamId) {
      skipped += 1;
      continue;
    }

    await upsertGarbageTimeStats({
      gameId,
      teamId,
      offEpaPlayNoGarbage: row.offense.ppa,
      defEpaPlayNoGarbage: row.defense.ppa,
      offSuccessRateNoGarbage: row.offense.successRate,
      defSuccessRateNoGarbage: row.defense.successRate,
    });
    synced += 1;
  }

  return { synced, skipped };
}
