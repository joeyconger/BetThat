import { getGames, getPlays, getWinProbabilityData } from "./client.js";
import type { CfbdPlayWinProbability } from "./client.js";

/**
 * Manual verification tool -- NOT part of any automated pipeline, not
 * called by any admin job. Prints one real game's plays (and, if
 * reachable, win-probability data) with the fields worth hand-checking
 * against a box score or broadcast before trusting raw play data for
 * anything built on top of it (playSuccess.ts, garbageTime.ts,
 * opponentAdjust.ts all assume this data is faithful):
 *
 *   1. EPA (ppa) sign convention: does a positive ppa always correspond
 *      to a play that helped the OFFENSE (a big gain, a TD), and
 *      negative to a play that hurt them (a sack, a turnover)?
 *   2. offense/defense team attribution on turnovers: on an
 *      interception or fumble-recovery play, is `offense` still the
 *      team that HAD the ball (correct for this project's schema), or
 *      does CFBD flip it to the team that recovered?
 *   3. win-probability timing: does a /metrics/wp row's homeWinProb
 *      reflect game state BEFORE the play (at snap) or AFTER it
 *      resolves? Compare the down/distance/score on a wp row against
 *      the matching /plays row (joined by playNumber) to tell which --
 *      this matters if win-probability-based garbage-time weighting is
 *      ever built (see garbageTime.ts's doc comment).
 *   4. garbage-time inputs: offenseScore/defenseScore/period/clock
 *      should match the live broadcast score at that point in the game.
 *   5. play_type coverage: does play.playType match a value in
 *      playSuccess.ts's SCRIMMAGE_PLAY_TYPES set where it should (and
 *      correctly NOT match where it's actually a punt/kickoff/penalty)?
 *
 * This project has NO network route to the live CFBD API from the
 * sandbox this was built in -- this script is written and typechecked,
 * but has never actually been run against a real response. Run it for
 * real the first time production/CFBD access is available, before
 * building anything further on top of the plays table (migration 0012).
 *
 * Usage:
 *   npx tsx src/ingest/cfbd/verifyRawPlays.ts <year> <week> <teamSchoolName> [maxPlays]
 * Example:
 *   npx tsx src/ingest/cfbd/verifyRawPlays.ts 2024 1 Georgia 20
 */

async function main(): Promise<void> {
  const [yearArg, weekArg, teamArg, maxPlaysArg] = process.argv.slice(2);
  if (!yearArg || !weekArg || !teamArg) {
    console.error("Usage: tsx src/ingest/cfbd/verifyRawPlays.ts <year> <week> <teamSchoolName> [maxPlays]");
    process.exitCode = 1;
    return;
  }
  const year = Number(yearArg);
  const week = Number(weekArg);
  const maxPlays = maxPlaysArg ? Number(maxPlaysArg) : 15;

  console.log(`Fetching games for ${year}...`);
  const games = await getGames(year);
  const game = games.find((g) => g.week === week && (g.homeTeam === teamArg || g.awayTeam === teamArg));
  if (!game) {
    console.error(`No game found for team "${teamArg}" in ${year} week ${week}. Check the exact school name CFBD uses (e.g. run getTeams first).`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n=== Box score (from /games) ===`);
  console.log(
    `${game.awayTeam} ${game.awayPoints ?? "?"} @ ${game.homeTeam} ${game.homePoints ?? "?"}  (gameId=${game.id}, completed=${game.completed})`,
  );

  console.log(`\nFetching plays for ${year} week ${week}...`);
  const allPlays = await getPlays(year, week);
  const gamePlays = allPlays.filter((p) => p.gameId === game.id);
  if (gamePlays.length === 0) {
    console.error(`No plays found for gameId=${game.id}. Either the game hasn't happened yet, or /plays didn't return it for an unexpected reason.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Found ${gamePlays.length} total plays for this game.`);

  const wpByPlayNumber = new Map<number, CfbdPlayWinProbability>();
  try {
    console.log(`\nFetching win probability data for gameId=${game.id}...`);
    const wp = await getWinProbabilityData(game.id);
    for (const row of wp) wpByPlayNumber.set(row.playNumber, row);
    console.log(`Found ${wp.length} win-probability rows.`);
  } catch (err) {
    console.log(`(Could not fetch win probability data: ${(err as Error).message} -- continuing without it.)`);
  }

  const shown = gamePlays.slice(0, maxPlays);
  console.log(`\n=== First ${shown.length} of ${gamePlays.length} plays (hand-check each against the box score / broadcast) ===`);
  console.log(
    "period clock   off        def        down-dist yards  playType                  score(off-def) ppa      scoring wp(home)",
  );
  for (const play of shown) {
    const clock = play.clock ? `${play.clock.minutes}:${String(play.clock.seconds ?? 0).padStart(2, "0")}` : "?";
    const wpRow = wpByPlayNumber.get(play.playNumber);
    const wpStr = wpRow ? (wpRow.homeWinProb === null ? "null" : wpRow.homeWinProb.toFixed(3)) : "(none)";
    console.log(
      [
        String(play.period).padEnd(6),
        clock.padEnd(7),
        play.offense.padEnd(10).slice(0, 10),
        play.defense.padEnd(10).slice(0, 10),
        `${play.down}-${play.distance}`.padEnd(9),
        String(play.yardsGained).padEnd(6),
        play.playType.padEnd(25).slice(0, 25),
        `${play.offenseScore}-${play.defenseScore}`.padEnd(14),
        String(play.ppa ?? "null").padEnd(8),
        String(play.scoring).padEnd(7),
        wpStr,
      ].join(" "),
    );
  }

  console.log(`\nCross-check against a real box score / play-by-play for ${game.awayTeam} @ ${game.homeTeam} (${year} wk ${week}):`);
  console.log(`  1. Does offenseScore/defenseScore match the real running score at each play?`);
  console.log(`  2. On a turnover play (interception/fumble), is "offense" still the team that HAD the ball, not the recovering team?`);
  console.log(`  3. Does ppa's sign make sense (positive on a good gain/TD, negative on a sack/turnover/loss)?`);
  console.log(`  4. If wp(home) printed: does it look like a PRE-play or POST-play probability relative to the down/distance/score on the same row?`);
  console.log(`  5. Does playType match a value in playSuccess.ts's SCRIMMAGE_PLAY_TYPES where it should (and NOT where it's actually a punt/kickoff/penalty/etc.)?`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
