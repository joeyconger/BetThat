import { parseArgs, requireFlag } from "../cliArgs.js";
import { syncNflSchedules } from "./syncSchedules.js";
import { syncNflPbpStats } from "./syncPbpStats.js";
import { pool } from "../../db/pool.js";

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const season = Number(requireFlag(flags, "season"));

  switch (command) {
    case "schedules": {
      const { synced } = await syncNflSchedules(season);
      console.log(`synced ${synced} NFL games for ${season}`);
      break;
    }
    case "stats": {
      const { synced, skipped } = await syncNflPbpStats(season);
      console.log(`synced ${synced} NFL team-game stat rows for ${season}, skipped ${skipped} (run 'schedules' first if this is high)`);
      break;
    }
    default:
      console.error("usage: tsx src/ingest/nflverse/index.ts <schedules|stats> --season 2023");
      process.exitCode = 1;
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
