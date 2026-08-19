import { computeAndStoreRatings, generatePredictionsForWeek } from "./ratings/service.js";
import { pool, query } from "./db/pool.js";

// One-off sanity check of the Phase 2 rating engine against real ingested
// data. Not a permanent part of the app.
const SEASON = 2025;
const WEEK = 10;

async function topRatings(sport: "nfl" | "cfb") {
  const rows = await query<{ name: string; rating: number; games: number }>(
    `SELECT t.name, tr.rating, tr.rating_error
     FROM team_ratings tr JOIN teams t ON t.id = tr.team_id
     WHERE tr.sport = $1 AND tr.season = $2 AND tr.through_week = $3 AND tr.method = 'elo'
     ORDER BY tr.rating DESC LIMIT 5`,
    [sport, SEASON, WEEK],
  );
  return rows;
}

async function main() {
  for (const sport of ["nfl", "cfb"] as const) {
    console.log(`--- ${sport} ${SEASON} ratings through week ${WEEK} ---`);
    const state = await computeAndStoreRatings(sport, SEASON, WEEK);
    console.log(`computed ratings for ${state.size} teams`);
    console.log("top 5:", JSON.stringify(await topRatings(sport)));

    console.log(`--- ${sport} ${SEASON} predictions for week ${WEEK + 1} ---`);
    const { predicted } = await generatePredictionsForWeek(sport, SEASON, WEEK + 1);
    console.log(`generated ${predicted} predictions`);

    const preds = await query(
      `SELECT g.id AS game_id, ht.name AS home, at.name AS away,
              mp.model_spread_home, mp.market_spread_home, mp.confidence
       FROM model_predictions mp
       JOIN games g ON g.id = mp.game_id
       JOIN teams ht ON ht.id = g.home_team_id
       JOIN teams at ON at.id = g.away_team_id
       WHERE g.sport = $1 AND g.season = $2 AND g.week = $3 AND mp.method = 'elo'
       ORDER BY g.id LIMIT 5`,
      [sport, SEASON, WEEK + 1],
    );
    console.log("sample predictions:", JSON.stringify(preds));
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
