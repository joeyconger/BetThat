import { getDrives, getPlays } from "./client.js";
import { findGameId, findTeamIdByName, upsertSpecialTeamsStats } from "../../db/repo.js";

const FG_PLAY_TYPES = new Set(["Field Goal Good", "Field Goal Missed", "Blocked Field Goal"]);

interface TeamGameAgg {
  offFieldPositionSum: number;
  offDrives: number;
  defFieldPositionSum: number;
  defDrives: number;
  offFgMade: number;
  offFgAttempts: number;
  defFgMade: number;
  defFgAttempts: number;
}

/**
 * Phase 3 of the component-model rebuild: special teams, scoped to field
 * position (from /drives, same cheap "whole season in one call" shape as
 * syncFinishingDrivesStats.ts) and field goal make rate (from /plays, same
 * per-week-call shape as syncSackRateStats.ts) -- see migration 0011 for
 * why punt/return efficiency was deliberately deferred rather than built
 * on unverified assumptions.
 */
export async function syncCfbdSpecialTeamsStats(
  year: number,
  seasonType: "regular" | "postseason" = "regular",
  weeks: number[] = Array.from({ length: 15 }, (_, i) => i + 1),
): Promise<{ synced: number; skipped: number; drivesFetched: number }> {
  const agg = new Map<string, TeamGameAgg>();
  function get(gameId: number, team: string): TeamGameAgg {
    const key = `${gameId}:${team}`;
    let entry = agg.get(key);
    if (!entry) {
      entry = { offFieldPositionSum: 0, offDrives: 0, defFieldPositionSum: 0, defDrives: 0, offFgMade: 0, offFgAttempts: 0, defFgMade: 0, defFgAttempts: 0 };
      agg.set(key, entry);
    }
    return entry;
  }

  const drives = await getDrives(year, seasonType);
  for (const drive of drives) {
    // 100 - start_yards_to_goal = distance from the offense's OWN goal
    // line -- higher means better starting field position for whoever's
    // offense that drive belongs to. See migration 0011's doc for the
    // full sign-convention reasoning.
    const fieldPositionScore = 100 - drive.startYardsToGoal;
    const offEntry = get(drive.gameId, drive.offense);
    offEntry.offFieldPositionSum += fieldPositionScore;
    offEntry.offDrives += 1;
    const defEntry = get(drive.gameId, drive.defense);
    defEntry.defFieldPositionSum += fieldPositionScore;
    defEntry.defDrives += 1;
  }

  for (const week of weeks) {
    const plays = await getPlays(year, week, seasonType);
    for (const play of plays) {
      if (!FG_PLAY_TYPES.has(play.playType)) continue;
      const made = play.playType === "Field Goal Good" ? 1 : 0;
      const offEntry = get(play.gameId, play.offense);
      offEntry.offFgMade += made;
      offEntry.offFgAttempts += 1;
      const defEntry = get(play.gameId, play.defense);
      defEntry.defFgMade += made;
      defEntry.defFgAttempts += 1;
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
    await upsertSpecialTeamsStats({
      gameId,
      teamId,
      offFieldPosition: entry.offDrives === 0 ? null : entry.offFieldPositionSum / entry.offDrives,
      defFieldPosition: entry.defDrives === 0 ? null : entry.defFieldPositionSum / entry.defDrives,
      offFgMakeRate: entry.offFgAttempts === 0 ? null : entry.offFgMade / entry.offFgAttempts,
      defFgMakeRate: entry.defFgAttempts === 0 ? null : entry.defFgMade / entry.defFgAttempts,
    });
    synced += 1;
  }

  return { synced, skipped, drivesFetched: drives.length };
}
