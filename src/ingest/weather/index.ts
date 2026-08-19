import { syncNflWeather } from "./syncWeather.js";
import { pool } from "../../db/pool.js";

async function main() {
  const { synced, skipped } = await syncNflWeather();
  console.log(`synced ${synced} NFL weather forecasts, skipped ${skipped} (unknown stadium or no forecast yet)`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
