import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import { parse } from "csv-parse";

// nflverse-data publishes nflfastR's play-by-play (with EPA/success rate
// already computed) and schedules as flat files on GitHub Releases — no API
// key, no rate limit, no R runtime needed. This is an undocumented-but-stable
// convention (same "unofficial source" tradeoff as the ESPN endpoints used
// elsewhere in this project) rather than a versioned API contract; if
// nflverse restructures release asset names, these URLs need updating.
const RELEASES_BASE = "https://github.com/nflverse/nflverse-data/releases/download";

export const SCHEDULES_URL = `${RELEASES_BASE}/schedules/games.csv`;

export function playByPlayUrl(season: number): string {
  return `${RELEASES_BASE}/pbp/play_by_play_${season}.csv.gz`;
}

async function openStream(url: string): Promise<Readable> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`fetch failed: ${url}: ${res.status} ${res.statusText}`);
  }
  return Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
}

/** Streams a plain CSV file row by row as objects keyed by header. */
export async function* streamCsv(url: string): AsyncGenerator<Record<string, string>> {
  const source = await openStream(url);
  const parser = parse({ columns: true, relax_column_count: true, skip_empty_lines: true });
  for await (const record of source.pipe(parser)) {
    yield record as Record<string, string>;
  }
}

/** Streams a gzipped CSV file row by row as objects keyed by header. */
export async function* streamCsvGz(url: string): AsyncGenerator<Record<string, string>> {
  const source = await openStream(url);
  const parser = parse({ columns: true, relax_column_count: true, skip_empty_lines: true });
  for await (const record of source.pipe(createGunzip()).pipe(parser)) {
    yield record as Record<string, string>;
  }
}
