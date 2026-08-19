import { parseArgs, requireFlag } from "../cliArgs.js";
import { syncCfbdTeams } from "./syncTeams.js";
import { syncCfbdGames } from "./syncGames.js";
import { syncCfbdGameStats } from "./syncStats.js";
import { syncCfbdHistoricalOdds } from "./syncHistoricalOdds.js";
import { pool } from "../../db/pool.js";

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const year = Number(requireFlag(flags, "year"));
  const seasonType = (flags.seasonType as "regular" | "postseason" | undefined) ?? "regular";

  switch (command) {
    case "teams": {
      const count = await syncCfbdTeams(year);
      console.log(`synced ${count} CFB teams for ${year}`);
      break;
    }
    case "games": {
      const { synced, skipped } = await syncCfbdGames(year, seasonType);
      console.log(`synced ${synced} CFB games for ${year} (${seasonType}), skipped ${skipped} (run 'teams' first if this is high)`);
      break;
    }
    case "stats": {
      const { synced, skipped } = await syncCfbdGameStats(year, seasonType);
      console.log(`synced ${synced} CFB team-game stat rows for ${year} (${seasonType}), skipped ${skipped} (run 'games' first if this is high)`);
      break;
    }
    case "historicalOdds": {
      const { synced, skipped } = await syncCfbdHistoricalOdds(year, seasonType);
      console.log(`synced ${synced} CFB odds rows for ${year} (${seasonType}), skipped ${skipped} — UNVERIFIED, check real values before trusting`);
      break;
    }
    default:
      console.error("usage: tsx src/ingest/cfbd/index.ts <teams|games|stats|historicalOdds> --year 2023 [--seasonType regular|postseason]");
      process.exitCode = 1;
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
