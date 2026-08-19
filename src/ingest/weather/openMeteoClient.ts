import { config } from "../../config.js";

export interface HourlyForecast {
  time: string;
  temperatureF: number;
  windMph: number;
  precipitationProbability: number;
}

interface OpenMeteoResponse {
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    wind_speed_10m?: number[];
    precipitation_probability?: number[];
  };
}

/** Free, no API key — Open-Meteo's forecast window covers roughly the next 16 days. */
export async function getHourlyForecast(lat: number, lon: number): Promise<HourlyForecast[]> {
  const url = new URL(`${config.openMeteoBaseUrl}/forecast`);
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("hourly", "temperature_2m,wind_speed_10m,precipitation_probability");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Open-Meteo request failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as OpenMeteoResponse;
  const times = body.hourly?.time ?? [];

  return times.map((time, i) => ({
    time,
    temperatureF: body.hourly?.temperature_2m?.[i] ?? NaN,
    windMph: body.hourly?.wind_speed_10m?.[i] ?? NaN,
    precipitationProbability: body.hourly?.precipitation_probability?.[i] ?? NaN,
  }));
}

/** Picks the forecast hour closest to kickoff. */
export function closestHour(hours: HourlyForecast[], kickoff: Date): HourlyForecast | undefined {
  return hours.reduce<{ hour: HourlyForecast; diff: number } | undefined>((best, hour) => {
    const diff = Math.abs(new Date(hour.time).getTime() - kickoff.getTime());
    if (!best || diff < best.diff) return { hour, diff };
    return best;
  }, undefined)?.hour;
}
