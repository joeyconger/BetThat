import { getTeams } from "./client.js";
import { upsertTeam } from "../../db/repo.js";

export async function syncCfbdTeams(year: number): Promise<number> {
  const teams = await getTeams(year);
  let count = 0;
  for (const team of teams) {
    // CFBD's /teams returns every division (FBS, FCS, DII, DIII, ...), and
    // nearly all of them have a named conference — filtering on conference
    // alone (an earlier version of this function did) lets thousands of
    // non-FBS teams through. classification is the actual FBS/FCS/... field.
    if (team.classification !== "fbs") continue;
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
