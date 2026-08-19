import { pool, query } from "./db/pool.js";

// One-off sanity check of real odds_snapshots rows. Not a permanent part of the app.
async function main() {
  const rows = await query(
    `SELECT ht.name AS home, at.name AS away, os.book, os.spread_home,
            os.moneyline_home, os.moneyline_away, os.total, os.captured_at
     FROM odds_snapshots os
     JOIN games g ON g.id = os.game_id
     JOIN teams ht ON ht.id = g.home_team_id
     JOIN teams at ON at.id = g.away_team_id
     WHERE g.sport = 'nfl' AND g.season = 2026
     ORDER BY g.week ASC, g.id ASC
     LIMIT 8`,
  );
  console.log("sample odds rows:", JSON.stringify(rows));

  const range = await query(
    `SELECT min(spread_home) AS min_spread, max(spread_home) AS max_spread, count(*) AS total
     FROM odds_snapshots os JOIN games g ON g.id = os.game_id
     WHERE g.sport = 'nfl' AND g.season = 2026`,
  );
  console.log("spread range across all synced games:", JSON.stringify(range));

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
