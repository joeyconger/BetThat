import { getPlays } from "./client.js";
import { findGameId, findTeamIdByName, upsertTurnoverStats } from "../../db/repo.js";

/**
 * The CFBD play_type strings where the DEFENSE gains possession — confirmed
 * against a real 2024 week 8 /plays response (19574 plays), not guessed.
 * Deliberately excludes "Fumble Recovery (Own)" (offense recovers its own
 * fumble, not a turnover) despite matching a naive /fumble/i regex.
 * "Interception" and "Pass Interception Return" both appear as distinct,
 * non-duplicate counts within the same game in the sample data (analogous
 * to "Rush" vs. "Rushing Touchdown", not two labels for one event), so both
 * are summed — this reasoning was not independently re-verified against a
 * second sample, treat as a reasonable working assumption.
 */
const TURNOVER_PLAY_TYPES = new Set([
  "Fumble Recovery (Opponent)",
  "Fumble Return Touchdown",
  "Interception",
  "Pass Interception Return",
  "Interception Return Touchdown",
]);

interface TeamGameAgg {
  offPpaSum: number;
  offPlays: number;
  defPpaSum: number;
  defPlays: number;
}

/**
 * Aggregates turnover-play PPA sums + counts per team per game, from CFBD's
 * /plays endpoint — a different endpoint than the rest of syncStats.ts,
 * which requires looping weeks (year+week both required per call, see
 * client.ts's getPlays doc) rather than one call per season. `weeks`
 * defaults to a generous 1-15 for the regular season; pass an explicit
 * (usually shorter) range for postseason. Plays with a turnover play_type
 * but null ppa are excluded from BOTH the sum and the play count (not
 * counted as 0) — including them in the count while treating their PPA
 * contribution as 0 would corrupt the reweighted-average math in
 * ratings/elo.ts, which assumes every counted turnover play's PPA is a
 * real, known quantity.
 */
export async function syncCfbdTurnoverStats(
  year: number,
  seasonType: "regular" | "postseason" = "regular",
  weeks: number[] = Array.from({ length: 15 }, (_, i) => i + 1),
): Promise<{ synced: number; skipped: number }> {
  const agg = new Map<string, TeamGameAgg>();

  function get(gameId: number, team: string): TeamGameAgg {
    const key = `${gameId}:${team}`;
    let entry = agg.get(key);
    if (!entry) {
      entry = { offPpaSum: 0, offPlays: 0, defPpaSum: 0, defPlays: 0 };
      agg.set(key, entry);
    }
    return entry;
  }

  for (const week of weeks) {
    const plays = await getPlays(year, week, seasonType);
    for (const play of plays) {
      // Touch both sides' entries for every play, not just turnover plays,
      // so a team with zero turnovers in a game still gets an explicit
      // zero row below (see upsertTurnoverStats' doc) instead of being
      // silently skipped and left null.
      const offEntry = get(play.gameId, play.offense);
      const defEntry = get(play.gameId, play.defense);
      if (!TURNOVER_PLAY_TYPES.has(play.playType) || play.ppa === null) continue;
      offEntry.offPpaSum += play.ppa;
      offEntry.offPlays += 1;
      defEntry.defPpaSum += play.ppa;
      defEntry.defPlays += 1;
    }
  }

  let synced = 0;
  let skipped = 0;
  for (const [key, entry] of agg) {
    const sep = key.indexOf(":");
    const gameIdStr = key.slice(0, sep);
    const team = key.slice(sep + 1);
    const gameId = await findGameId("cfb", gameIdStr);
    const teamId = await findTeamIdByName("cfb", team);
    if (!gameId || !teamId) {
      skipped += 1;
      continue;
    }
    await upsertTurnoverStats({
      gameId,
      teamId,
      offTurnoverPpaSum: entry.offPpaSum,
      offTurnoverPlays: entry.offPlays,
      defTurnoverPpaSum: entry.defPpaSum,
      defTurnoverPlays: entry.defPlays,
    });
    synced += 1;
  }

  return { synced, skipped };
}
