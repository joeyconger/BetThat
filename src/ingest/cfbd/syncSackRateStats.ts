import { getPlays } from "./client.js";
import { findGameId, findTeamIdByName, upsertSackRateStats } from "../../db/repo.js";

/**
 * Aggregates sack rate per team per game, from CFBD's /plays endpoint --
 * same "loop weeks, one call per week" shape as syncTurnoverStats.ts, a
 * separate /plays pass rather than reusing that module's, to keep each
 * feature independently revertable (see RatingParams.pointsPerSackRate's
 * doc). offSackRate = sacks taken by this team's OWN offense / this
 * team's offensive plays; defSackRate = sacks this team's DEFENSE forced
 * / this team's defensive plays -- an intentionally inverted sign
 * convention (getting sacked is bad for offense, forcing a sack is good
 * for defense), same as GameForRating's doc flags. Weeks 1-15 only
 * (regular season), same scope as syncTurnoverStats.ts.
 */
export async function syncCfbdSackRateStats(
  year: number,
  seasonType: "regular" | "postseason" = "regular",
  weeks: number[] = Array.from({ length: 15 }, (_, i) => i + 1),
): Promise<{ synced: number; skipped: number }> {
  interface TeamGameAgg {
    offPlays: number;
    offSacks: number;
    defPlays: number;
    defSacks: number;
  }
  const agg = new Map<string, TeamGameAgg>();

  function get(gameId: number, team: string): TeamGameAgg {
    const key = `${gameId}:${team}`;
    let entry = agg.get(key);
    if (!entry) {
      entry = { offPlays: 0, offSacks: 0, defPlays: 0, defSacks: 0 };
      agg.set(key, entry);
    }
    return entry;
  }

  for (const week of weeks) {
    const plays = await getPlays(year, week, seasonType);
    for (const play of plays) {
      const offEntry = get(play.gameId, play.offense);
      const defEntry = get(play.gameId, play.defense);
      offEntry.offPlays += 1;
      defEntry.defPlays += 1;
      if (play.playType === "Sack") {
        offEntry.offSacks += 1;
        defEntry.defSacks += 1;
      }
    }
  }

  let synced = 0;
  let skipped = 0;
  for (const [key, entry] of agg) {
    const sep = key.indexOf(":");
    const gameIdStr = key.slice(0, sep);
    const team = key.slice(sep + 1);
    const gameId = await findGameId("cfb", gameIdStr);
    const teamId = await findTeamIdByName("cfb", team);
    if (!gameId || !teamId) {
      skipped += 1;
      continue;
    }
    await upsertSackRateStats({
      gameId,
      teamId,
      offSackRate: entry.offPlays === 0 ? 0 : entry.offSacks / entry.offPlays,
      defSackRate: entry.defPlays === 0 ? 0 : entry.defSacks / entry.defPlays,
    });
    synced += 1;
  }

  return { synced, skipped };
}
