import type { Sport } from "../db/repo.js";
import { pool } from "../db/pool.js";
import { parseFlags, requireFlag } from "../ingest/cliArgs.js";
import { runSweep } from "./sweep.js";

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const sport = requireFlag(flags, "sport") as Sport;
  const seasonStart = Number(requireFlag(flags, "seasonStart"));
  const seasonEnd = Number(requireFlag(flags, "seasonEnd"));

  const results = await runSweep(sport, seasonStart, seasonEnd);

  console.log("\n--- best combos by cover rate ---");
  for (const r of results.slice(0, 5)) {
    console.log(JSON.stringify(r));
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
