import { getGames, getVenues } from "./client.js";
import { findGameId, upsertWeather } from "../../db/repo.js";
import { closestHistoricalHour, getHistoricalHourlyWeather } from "../weather/openMeteoClient.js";

/**
 * Historical weather for completed CFB games, joined via CFBD's own
 * venue_id per game (see client.ts's getVenues doc) rather than a
 * team-to-home-stadium map — correctly handles neutral-site games, which
 * the NFL historical sync (syncNflHistoricalWeather) can't. UNVERIFIED —
 * Open-Meteo's archive API hasn't been checked against a real response
 * from this sandbox (blocked), and neither has CFBD's /venues.
 */
export async function syncCfbdHistoricalWeather(
  year: number,
  seasonType: "regular" | "postseason" = "regular",
): Promise<{ synced: number; skipped: number }> {
  const [games, venues] = await Promise.all([getGames(year, seasonType), getVenues()]);
  const venueById = new Map(venues.map((v) => [v.id, v]));

  let synced = 0;
  let skipped = 0;

  for (const game of games) {
    if (!game.completed || !game.venueId) {
      skipped += 1;
      continue;
    }
    const gameId = await findGameId("cfb", String(game.id));
    const venue = venueById.get(game.venueId);
    if (!gameId || !venue || venue.latitude === null || venue.longitude === null) {
      skipped += 1;
      continue;
    }

    const gameDate = new Date(game.startDate);

    if (venue.dome) {
      await upsertWeather({
        gameId,
        forecastAt: gameDate.toISOString(),
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

    const dateIso = gameDate.toISOString().slice(0, 10);
    const hours = await getHistoricalHourlyWeather(venue.latitude, venue.longitude, dateIso);
    const hour = closestHistoricalHour(hours, gameDate);
    if (!hour) {
      skipped += 1;
      continue;
    }

    await upsertWeather({
      gameId,
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
