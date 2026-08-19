import { parseArgs, requireFlag } from "../cliArgs.js";
import { syncCurrentOdds } from "./syncCurrentOdds.js";
import { pool } from "../../db/pool.js";
import type { Sport } from "../../db/repo.js";

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const sport = requireFlag(flags, "sport") as Sport;

  switch (command) {
    case "current": {
      const { synced, skipped } = await syncCurrentOdds(sport);
      console.log(`synced ${synced} current-odds snapshots for ${sport}, skipped ${skipped} (unmatched game/team)`);
      break;
    }
    default:
      console.error("usage: tsx src/ingest/odds/index.ts current --sport nfl|cfb");
      process.exitCode = 1;
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
