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

export interface HistoricalHourlyWeather {
  time: string;
  temperatureF: number;
  windMph: number;
  /** An actual amount, not a probability — the past is known, not forecast. Unit: inches (see precipitation_unit param). */
  precipitationIn: number;
}

/**
 * UNVERIFIED against a real response — this sandbox can't reach
 * open-meteo.com to check (see README "Odds data" for the same posture on
 * other blocked-from-here sites). Archive-api.open-meteo.com/v1/archive is
 * a separate product/domain from the live /forecast endpoint already used
 * (getHourlyForecast above), documented (per public docs, not a live
 * check) as free/keyless, ERA5-reanalysis-backed, covering 1940-present.
 * Reports actual precipitation amount, not a probability (that's a
 * forecast-only concept) — see HistoricalHourlyWeather's doc. Check
 * ingested values land in a plausible range before trusting them.
 */
export async function getHistoricalHourlyWeather(
  lat: number,
  lon: number,
  dateIso: string,
): Promise<HistoricalHourlyWeather[]> {
  const url = new URL(`${config.openMeteoArchiveBaseUrl}/archive`);
  url.searchParams.set("latitude", String(lat));
  url.searchParams.set("longitude", String(lon));
  url.searchParams.set("start_date", dateIso);
  url.searchParams.set("end_date", dateIso);
  url.searchParams.set("hourly", "temperature_2m,wind_speed_10m,precipitation");
  url.searchParams.set("temperature_unit", "fahrenheit");
  url.searchParams.set("wind_speed_unit", "mph");
  url.searchParams.set("precipitation_unit", "inch");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Open-Meteo archive request failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as {
    hourly?: { time?: string[]; temperature_2m?: number[]; wind_speed_10m?: number[]; precipitation?: number[] };
  };
  const times = body.hourly?.time ?? [];

  return times.map((time, i) => ({
    time,
    temperatureF: body.hourly?.temperature_2m?.[i] ?? NaN,
    windMph: body.hourly?.wind_speed_10m?.[i] ?? NaN,
    precipitationIn: body.hourly?.precipitation?.[i] ?? NaN,
  }));
}

/** Same nearest-hour-to-kickoff logic as closestHour, for the historical shape. */
export function closestHistoricalHour(
  hours: HistoricalHourlyWeather[],
  kickoff: Date,
): HistoricalHourlyWeather | undefined {
  return hours.reduce<{ hour: HistoricalHourlyWeather; diff: number } | undefined>((best, hour) => {
    const diff = Math.abs(new Date(hour.time).getTime() - kickoff.getTime());
    if (!best || diff < best.diff) return { hour, diff };
    return best;
  }, undefined)?.hour;
}
