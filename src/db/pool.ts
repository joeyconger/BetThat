import { Pool } from "pg";
import { config } from "../config.js";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl.includes("railway") ? { rejectUnauthorized: false } : undefined,
});

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}
