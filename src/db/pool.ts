import { Pool, types } from "pg";
import { config } from "../config.js";

// pg returns NUMERIC/DECIMAL columns as strings by default (to avoid float
// precision loss on values JS can't represent exactly) — every spread/EPA/
// rating column in this schema is numeric, so without this, arithmetic
// mixing a real number with a DB-sourced value silently does the wrong
// thing wherever `+` is used (string concatenation instead of addition;
// `-`, `*`, `/` happen to coerce correctly, which is exactly what made this
// easy to miss). Parsing as float here, once, globally, is the standard
// fix — safer than trusting every call site to remember to cast.
types.setTypeParser(1700, (value: string) => parseFloat(value));

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl.includes("railway") ? { rejectUnauthorized: false } : undefined,
  // A runaway query (an accidental cartesian join, or an expensive ad hoc
  // SELECT via server.ts's /query) shouldn't be able to hang a connection
  // indefinitely. 30s comfortably covers every real query in this app —
  // the slowest is the season-long backtest replay, which is many small
  // queries, not one long-running one.
  statement_timeout: 30_000,
});

export async function query<T extends Record<string, unknown> = Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}
