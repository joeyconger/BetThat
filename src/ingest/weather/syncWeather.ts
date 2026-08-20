import { getUpcomingGames, getCompletedGamesForWeather, upsertWeather } from "../../db/repo.js";
import { NFL_STADIUMS } from "./nflStadiums.js";
import { closestHour, closestHistoricalHour, getHourlyForecast, getHistoricalHourlyWeather } from "./openMeteoClient.js";

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

/**
 * Historical backfill for already-completed NFL games (the live sync above
 * only handles upcoming games via a forecast). Uses Open-Meteo's archive
 * API — see openMeteoClient.ts's getHistoricalHourlyWeather doc for its
 * UNVERIFIED status. Correctly handles neutral-site games? No — same
 * team-to-home-stadium mapping limitation as the live NFL sync (no
 * neutral-site override), unlike the CFB version which joins by the
 * game's actual venue_id from CFBD.
 */
export async function syncNflHistoricalWeather(
  seasonStart: number,
  seasonEnd: number,
): Promise<{ synced: number; skipped: number }> {
  const games = await getCompletedGamesForWeather("nfl", seasonStart, seasonEnd);
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
        forecastAt: game.gameDate.toISOString(),
        tempF: 72,
        windMph: 0,
        precipitationProbability: null,
        precipitationActual: 0,
        isDome: true,
        source: "open-meteo-historical",
      });
      synced += 1;
      continue;
    }

    const dateIso = game.gameDate.toISOString().slice(0, 10);
    const hours = await getHistoricalHourlyWeather(stadium.lat, stadium.lon, dateIso);
    const hour = closestHistoricalHour(hours, game.gameDate);
    if (!hour) {
      skipped += 1;
      continue;
    }

    await upsertWeather({
      gameId: game.id,
      forecastAt: hour.time,
      tempF: hour.temperatureF,
      windMph: hour.windMph,
      precipitationProbability: null,
      precipitationActual: hour.precipitationIn,
      isDome: false,
      source: "open-meteo-historical",
    });
    synced += 1;
  }

  return { synced, skipped };
}
