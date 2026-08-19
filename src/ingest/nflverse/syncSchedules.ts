import { SCHEDULES_URL, streamCsv } from "./client.js";
import { nflTeamName } from "./teamNames.js";
import { upsertTeam, upsertGame } from "../../db/repo.js";

function toSeasonType(gameType: string): "regular" | "postseason" {
  return gameType === "REG" ? "regular" : "postseason";
}

export function toGameDate(gameday: string, gametime: string): string | null {
  if (!gameday) return null;
  return gametime ? `${gameday}T${gametime}:00` : gameday;
}

function toScore(raw: string): number | null {
  return raw === "" || raw === undefined ? null : Number(raw);
}

export async function syncNflSchedules(season: number): Promise<{ synced: number }> {
  const seenTeams = new Set<string>();
  let synced = 0;

  for await (const row of streamCsv(SCHEDULES_URL)) {
    if (Number(row.season) !== season) continue;
    const gameId = row.game_id;
    const homeAbbr = row.home_team;
    const awayAbbr = row.away_team;
    if (!gameId || !homeAbbr || !awayAbbr) continue;

    for (const abbr of [homeAbbr, awayAbbr]) {
      if (seenTeams.has(abbr)) continue;
      seenTeams.add(abbr);
      await upsertTeam({ sport: "nfl", sourceId: abbr, name: nflTeamName(abbr) });
    }

    const homeTeamId = await upsertTeam({ sport: "nfl", sourceId: homeAbbr, name: nflTeamName(homeAbbr) });
    const awayTeamId = await upsertTeam({ sport: "nfl", sourceId: awayAbbr, name: nflTeamName(awayAbbr) });

    const homeScore = toScore(row.home_score ?? "");
    const awayScore = toScore(row.away_score ?? "");

    await upsertGame({
      sport: "nfl",
      season,
      week: Number(row.week),
      seasonType: toSeasonType(row.game_type ?? "REG"),
      gameDate: toGameDate(row.gameday ?? "", row.gametime ?? ""),
      homeTeamId,
      awayTeamId,
      homeScore,
      awayScore,
      status: homeScore !== null && awayScore !== null ? "final" : "scheduled",
      neutralSite: row.location === "Neutral",
      sourceId: gameId,
    });
    synced += 1;
  }

  return { synced };
}
