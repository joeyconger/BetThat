import { getUpcomingGames, upsertWeather } from "../../db/repo.js";
import { NFL_STADIUMS } from "./nflStadiums.js";
import { closestHour, getHourlyForecast } from "./openMeteoClient.js";

/** Only covers NFL for now — see nflStadiums.ts for the CFB follow-up note. */
export async function syncNflWeather(withinDays = 10): Promise<{ synced: number; skipped: number }> {
  const games = await getUpcomingGames("nfl", withinDays);
  let synced = 0;
  let skipped = 0;

  for (const game of games) {
    const stadium = NFL_STADIUMS[game.homeTeamSourceId];
    if (!stadium) {
      skipped += 1;
      continue;
    }

    if (stadium.isDome) {
      await upsertWeather({
        gameId: game.id,
        forecastAt: new Date().toISOString(),
        tempF: 72,
        windMph: 0,
        precipitationProbability: 0,
        isDome: true,
        source: "open-meteo",
      });
      synced += 1;
      continue;
    }

    const hours = await getHourlyForecast(stadium.lat, stadium.lon);
    const hour = closestHour(hours, game.gameDate);
    if (!hour) {
      skipped += 1;
      continue;
    }

    await upsertWeather({
      gameId: game.id,
      forecastAt: hour.time,
      tempF: hour.temperatureF,
      windMph: hour.windMph,
      precipitationProbability: hour.precipitationProbability,
      isDome: false,
      source: "open-meteo",
    });
    synced += 1;
  }

  return { synced, skipped };
}
