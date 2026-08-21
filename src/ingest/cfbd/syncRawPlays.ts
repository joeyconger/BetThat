import { getPlays } from "./client.js";
import { getTeamNameToIdMap, getGameSourceIdToIdMap, insertPlaysBatch } from "../../db/repo.js";
import type { InsertPlayInput } from "../../db/repo.js";

/**
 * Ingests raw play-by-play into the new `plays` table (migration 0012) --
 * the foundation for the SP+-style rebuild: our own success-rate/
 * situational-split definitions and weighted garbage-time both need
 * individual play rows, not CFBD's pre-aggregated /stats/game/advanced
 * numbers this project has relied on up to this point.
 *
 * Uses bulk name/game lookups (getTeamNameToIdMap, getGameSourceIdToIdMap)
 * instead of per-play queries -- a full season is ~150k+ plays, so N
 * individual lookups would be far too slow. Weeks 1-15 only (regular
 * season), same scope as syncTurnoverStats.ts/syncSackRateStats.ts.
 *
 * A play whose game doesn't resolve is skipped entirely (can't be
 * attributed to a week/season). A play whose offense/defense team name
 * doesn't resolve is still STORED, with that side's team_id left null --
 * unlike the team-game-level aggregation modules, a play is worth keeping
 * even with one side unresolved (e.g. an FCS opponent), since downstream
 * per-team computations filter on whichever side they need.
 */
export async function syncCfbdRawPlays(
  year: number,
  seasonType: "regular" | "postseason" = "regular",
  weeks: number[] = Array.from({ length: 15 }, (_, i) => i + 1),
): Promise<{ synced: number; skippedNoGame: number; playsFetched: number }> {
  const teamMap = await getTeamNameToIdMap("cfb");
  const gameMap = await getGameSourceIdToIdMap("cfb", year);

  let playsFetched = 0;
  let synced = 0;
  let skippedNoGame = 0;

  for (const week of weeks) {
    const plays = await getPlays(year, week, seasonType);
    playsFetched += plays.length;

    const toInsert: InsertPlayInput[] = [];
    for (const play of plays) {
      const gameId = gameMap.get(String(play.gameId));
      if (!gameId) {
        skippedNoGame += 1;
        continue;
      }
      toInsert.push({
        cfbdPlayId: play.id,
        gameId,
        offenseTeamId: teamMap.get(play.offense) ?? null,
        defenseTeamId: teamMap.get(play.defense) ?? null,
        driveId: play.driveId ?? null,
        driveNumber: play.driveNumber ?? null,
        playNumber: play.playNumber ?? null,
        period: play.period,
        clockMinutes: play.clock?.minutes ?? null,
        clockSeconds: play.clock?.seconds ?? null,
        offenseScore: play.offenseScore ?? null,
        defenseScore: play.defenseScore ?? null,
        yardLine: play.yardLine ?? null,
        yardsToGoal: play.yardsToGoal ?? null,
        down: play.down ?? null,
        distance: play.distance ?? null,
        yardsGained: play.yardsGained ?? null,
        playType: play.playType,
        scoring: play.scoring ?? false,
        ppa: play.ppa,
      });
    }
    const insertedThisWeek = await insertPlaysBatch(toInsert);
    synced += insertedThisWeek;
  }

  return { synced, skippedNoGame, playsFetched };
}
