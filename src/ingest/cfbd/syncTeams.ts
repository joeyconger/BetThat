import { getTeams } from "./client.js";
import { upsertTeam } from "../../db/repo.js";

export async function syncCfbdTeams(year: number): Promise<number> {
  const teams = await getTeams(year);
  let count = 0;
  for (const team of teams) {
    if (!team.conference) continue; // skip non-FBS/independent noise with no conference
    await upsertTeam({
      sport: "cfb",
      sourceId: String(team.id),
      name: team.school,
      conference: team.conference,
      division: team.classification,
    });
    count += 1;
  }
  return count;
}
