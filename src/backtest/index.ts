import { parseArgs, requireFlag } from "../ingest/cliArgs.js";
import { runBacktest } from "./run.js";
import { getOverallReport, getThresholdReport, getSportSeasonReport, getConfidenceReport } from "./report.js";
import { pool } from "../db/pool.js";
import type { Sport } from "../db/repo.js";

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case "run": {
      const sport = requireFlag(flags, "sport") as Sport;
      const seasonStart = Number(requireFlag(flags, "seasonStart"));
      const seasonEnd = Number(requireFlag(flags, "seasonEnd"));
      const name = flags.name ?? `${sport}-${seasonStart}-${seasonEnd}`;
      const summary = await runBacktest({ name, sport, seasonStart, seasonEnd });
      console.log(JSON.stringify(summary));
      if (summary.scored === 0) {
        console.log(
          "0 games scored — this almost certainly means there's no historical opening/closing odds data yet " +
            "(see README \"Odds data\": src/ingest/odds/sbrImport.ts needs a real downloaded SBR file to finish).",
        );
      }
      break;
    }
    case "report": {
      const runId = Number(requireFlag(flags, "runId"));
      console.log("overall:", JSON.stringify(await getOverallReport(runId)));
      console.log("by threshold:", JSON.stringify(await getThresholdReport(runId)));
      console.log("by confidence:", JSON.stringify(await getConfidenceReport(runId)));
      console.log("by sport/season:", JSON.stringify(await getSportSeasonReport(runId)));
      break;
    }
    default:
      console.error(
        "usage: tsx src/backtest/index.ts run --sport nfl|cfb --seasonStart 2022 --seasonEnd 2024 [--name label]\n" +
          "       tsx src/backtest/index.ts report --runId 1",
      );
      process.exitCode = 1;
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
