import { getDrives } from "./client.js";
import { findGameId, findTeamIdByName, upsertFinishingDrivesStats } from "../../db/repo.js";

/** A drive that started inside this many yards of the opponent's goal line counts as a "scoring opportunity" — matches the common industry definition (also used by Connelly's own SP+ finishing-drives component) for what "finishing drives" measures. */
const SCORING_OPPORTUNITY_YARDS_TO_GOAL = 40;

interface TeamGameAgg {
  offPoints: number;
  offOpportunities: number;
  defPoints: number;
  defOpportunities: number;
}

/**
 * Aggregates "finishing drives" (points per scoring opportunity) per team
 * per game, from CFBD's /drives endpoint — a whole season in ONE call
 * (week is optional there, unlike /plays), so this is far cheaper than
 * syncTurnoverStats.ts/syncSackRateStats.ts's ~15-calls-per-year shape.
 * Logs the raw drive count as a sanity check on first use, since this
 * project has no live route to CFBD to confirm the "omit week for a full
 * season" behavior against a real response ahead of time (see
 * client.ts's getDrives doc).
 */
export async function syncCfbdFinishingDrivesStats(
  year: number,
  seasonType: "regular" | "postseason" = "regular",
): Promise<{ synced: number; skipped: number; drivesFetched: number }> {
  const drives = await getDrives(year, seasonType);

  const agg = new Map<string, TeamGameAgg>();
  function get(gameId: number, team: string): TeamGameAgg {
    const key = `${gameId}:${team}`;
    let entry = agg.get(key);
    if (!entry) {
      entry = { offPoints: 0, offOpportunities: 0, defPoints: 0, defOpportunities: 0 };
      agg.set(key, entry);
    }
    return entry;
  }

  for (const drive of drives) {
    if (drive.startYardsToGoal > SCORING_OPPORTUNITY_YARDS_TO_GOAL) continue;
    const points = drive.endOffenseScore - drive.startOffenseScore;
    const offEntry = get(drive.gameId, drive.offense);
    offEntry.offPoints += points;
    offEntry.offOpportunities += 1;
    const defEntry = get(drive.gameId, drive.defense);
    defEntry.defPoints += points;
    defEntry.defOpportunities += 1;
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
    await upsertFinishingDrivesStats({
      gameId,
      teamId,
      offFinishingDrivesPpo: entry.offOpportunities === 0 ? null : entry.offPoints / entry.offOpportunities,
      defFinishingDrivesPpo: entry.defOpportunities === 0 ? null : entry.defPoints / entry.defOpportunities,
    });
    synced += 1;
  }

  return { synced, skipped, drivesFetched: drives.length };
}
