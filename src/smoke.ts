import { syncNflSchedules } from "./ingest/nflverse/syncSchedules.js";
import { syncNflPbpStats } from "./ingest/nflverse/syncPbpStats.js";
import { syncCfbdTeams } from "./ingest/cfbd/syncTeams.js";
import { syncCfbdGames } from "./ingest/cfbd/syncGames.js";
import { syncCfbdGameStats } from "./ingest/cfbd/syncStats.js";
import { pool } from "./db/pool.js";

// One-off sanity check that real ingestion lands real rows in a real
// database — not a permanent part of the app. Run once via a temporary
// Railway startCommand, then revert (see railway.json history).
const SEASON = 2025;

async function main() {
  console.log(`--- NFL ${SEASON} schedules ---`);
  console.log(await syncNflSchedules(SEASON));

  console.log(`--- NFL ${SEASON} play-by-play stats ---`);
  console.log(await syncNflPbpStats(SEASON));

  console.log(`--- CFB ${SEASON} teams ---`);
  console.log(await syncCfbdTeams(SEASON));

  console.log(`--- CFB ${SEASON} games ---`);
  console.log(await syncCfbdGames(SEASON));

  console.log(`--- CFB ${SEASON} advanced stats ---`);
  console.log(await syncCfbdGameStats(SEASON));

  console.log("smoke test complete");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
