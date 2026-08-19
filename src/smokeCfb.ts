import { syncCfbdTeams } from "./ingest/cfbd/syncTeams.js";
import { syncCfbdGames } from "./ingest/cfbd/syncGames.js";
import { syncCfbdGameStats } from "./ingest/cfbd/syncStats.js";
import { pool } from "./db/pool.js";

// CFB-only re-sync after the classification filter fix — see smoke.ts for
// the combined NFL+CFB version. Not a permanent part of the app.
const SEASON = 2025;

async function main() {
  console.log(`--- CFB ${SEASON} teams ---`);
  console.log(await syncCfbdTeams(SEASON));

  console.log(`--- CFB ${SEASON} games ---`);
  console.log(await syncCfbdGames(SEASON));

  console.log(`--- CFB ${SEASON} advanced stats ---`);
  console.log(await syncCfbdGameStats(SEASON));

  console.log("cfb smoke test complete");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
