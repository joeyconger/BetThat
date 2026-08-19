import { query, pool } from "./db/pool.js";

// One-off DB sanity check for the smoke test — confirms real row counts
// and flags any game that doesn't have exactly 2 team_game_stats rows
// (one home, one away). Not a permanent part of the app.
const SEASON = 2025;

async function main() {
  const gamesBySport = await query<{ sport: string; count: string }>(
    `SELECT sport, count(*) FROM games WHERE season = $1 GROUP BY sport`,
    [SEASON],
  );
  console.log("games by sport:", gamesBySport);

  const teamsBySport = await query<{ sport: string; count: string }>(
    `SELECT sport, count(*) FROM teams GROUP BY sport`,
  );
  console.log("teams by sport:", teamsBySport);

  const statsBySport = await query<{ sport: string; count: string }>(
    `SELECT g.sport, count(*) FROM team_game_stats tgs
     JOIN games g ON g.id = tgs.game_id
     WHERE g.season = $1
     GROUP BY g.sport`,
    [SEASON],
  );
  console.log("team_game_stats rows by sport:", statsBySport);

  const badGames = await query<{ id: number; sport: string; stat_rows: string }>(
    `SELECT g.id, g.sport, count(tgs.id) AS stat_rows
     FROM games g LEFT JOIN team_game_stats tgs ON tgs.game_id = g.id
     WHERE g.season = $1
     GROUP BY g.id, g.sport
     HAVING count(tgs.id) <> 2
     ORDER BY g.sport
     LIMIT 20`,
    [SEASON],
  );
  console.log(`games without exactly 2 stat rows (showing up to 20):`, badGames);

  const badGameTotal = await query<{ count: string }>(
    `SELECT count(*) FROM (
       SELECT g.id FROM games g LEFT JOIN team_game_stats tgs ON tgs.game_id = g.id
       WHERE g.season = $1
       GROUP BY g.id
       HAVING count(tgs.id) <> 2
     ) x`,
    [SEASON],
  );
  console.log("total games without exactly 2 stat rows:", badGameTotal[0]?.count);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
