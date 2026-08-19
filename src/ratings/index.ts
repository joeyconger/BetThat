import { parseArgs, requireFlag } from "../ingest/cliArgs.js";
import { computeAndStoreRatings, generatePredictionsForWeek } from "./service.js";
import { pool } from "../db/pool.js";
import type { Sport } from "../db/repo.js";

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const sport = requireFlag(flags, "sport") as Sport;
  const season = Number(requireFlag(flags, "season"));

  switch (command) {
    case "compute": {
      const throughWeek = Number(requireFlag(flags, "week"));
      const state = await computeAndStoreRatings(sport, season, throughWeek);
      console.log(`computed ${sport} ${season} ratings through week ${throughWeek} for ${state.size} teams`);
      break;
    }
    case "predict": {
      const week = Number(requireFlag(flags, "week"));
      const { predicted } = await generatePredictionsForWeek(sport, season, week);
      console.log(`generated ${predicted} predictions for ${sport} ${season} week ${week}`);
      break;
    }
    default:
      console.error(
        "usage: tsx src/ratings/index.ts <compute|predict> --sport nfl|cfb --season 2025 --week 10",
      );
      process.exitCode = 1;
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
