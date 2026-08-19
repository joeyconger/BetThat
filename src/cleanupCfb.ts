import { pool } from "./db/pool.js";

// One-off cleanup for the bad first CFB sync (synced every division, not
// just FBS, before syncTeams.ts's classification filter was fixed). Deletes
// all CFB rows so the next smoke run repopulates cleanly. Not a permanent
// part of the app — safe to delete once this has been run.
async function main() {
  const stats = await pool.query(`
    DELETE FROM team_game_stats
    WHERE game_id IN (SELECT id FROM games WHERE sport = 'cfb')
  `);
  console.log("deleted cfb team_game_stats rows:", stats.rowCount);

  const games = await pool.query(`DELETE FROM games WHERE sport = 'cfb'`);
  console.log("deleted cfb games rows:", games.rowCount);

  const teams = await pool.query(`DELETE FROM teams WHERE sport = 'cfb'`);
  console.log("deleted cfb teams rows:", teams.rowCount);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
