import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export const config = {
  databaseUrl: required("DATABASE_URL"),
  cfbdApiKey: process.env.CFBD_API_KEY ?? "",
  oddsApiKey: process.env.ODDS_API_KEY ?? "",
  openMeteoBaseUrl: process.env.OPEN_METEO_BASE_URL ?? "https://api.open-meteo.com/v1",
  nodeEnv: process.env.NODE_ENV ?? "development",
};

export function requireCfbdApiKey(): string {
  if (!config.cfbdApiKey) {
    throw new Error("CFBD_API_KEY is not set — get a free key at https://collegefootballdata.com/key");
  }
  return config.cfbdApiKey;
}

export function requireOddsApiKey(): string {
  if (!config.oddsApiKey) {
    throw new Error("ODDS_API_KEY is not set — get a key at https://the-odds-api.com");
  }
  return config.oddsApiKey;
}
