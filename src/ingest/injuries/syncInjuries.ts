import { getCurrentInjuries } from "./espnClient.js";
import { findTeamIdFuzzy, insertInjury } from "../../db/repo.js";
import type { Sport } from "../../db/repo.js";

export async function syncCurrentInjuries(sport: Sport): Promise<{ synced: number; skipped: number }> {
  const records = await getCurrentInjuries(sport);
  let synced = 0;
  let skipped = 0;

  for (const record of records) {
    const teamId = await findTeamIdFuzzy(sport, record.teamName);
    if (!teamId) {
      skipped += 1;
      continue;
    }
    await insertInjury({
      teamId,
      gameId: null,
      playerName: record.playerName,
      position: record.position,
      status: record.status,
      reportDate: record.reportDate,
      source: "espn",
      raw: record.raw,
    });
    synced += 1;
  }

  return { synced, skipped };
}
