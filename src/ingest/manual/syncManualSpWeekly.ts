import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findTeamIdFuzzy, upsertExternalRating } from "../../db/repo.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ManualSpWeeklyRow {
  week: number;
  team: string;
  sp: number;
  offSp: number | null;
  defSp: number | null;
  stSp: number | null;
}

/**
 * Ingests a manually-provided archive of real week-by-week SP+ (overall
 * rating only -- offSp/defSp/stSp are extracted and present in the JSON
 * but not ingested yet, kept for a future follow-on test) for CFB 2025,
 * from a spreadsheet the user supplied -- NOT a live API pull, unlike
 * every other ingestion module in this project. See
 * RatingParams.weeklySpSignalPoints' doc for why this exists: CFBD's own
 * /ratings/sp confirmed (via their real client docs) to have no week
 * param at all, so this manual archive is the only source of real
 * in-season SP+ movement available. Weeks 1-15 only (regular season;
 * the source spreadsheet's week-0/bowls sheets weren't extracted).
 *
 * Relies on findTeamIdFuzzy for name matching, same as the injuries
 * ingestion — verified against the real 136-team file that this resolves
 * cleanly when the full CFB team roster is already synced (2040/2040
 * rows matched in a local integration test), but be alert to skip counts
 * on a real run: findTeamIdFuzzy's substring fallback can misfire when
 * the team table is thin (confirmed directly — with only 2 teams seeded,
 * a real "Ohio" row false-matched onto "Ohio State" as its only
 * candidate, since there was nothing else in the table for the
 * ambiguity check to reject against). Not a bug introduced here, just a
 * sharp edge in shared matching code worth knowing about before trusting
 * a suspiciously-round synced/skipped split.
 */
export async function syncManualSpWeekly2025(): Promise<{ synced: number; skipped: number }> {
  const jsonPath = join(__dirname, "sp_weekly_2025.json");
  const rows = JSON.parse(readFileSync(jsonPath, "utf-8")) as ManualSpWeeklyRow[];

  let synced = 0;
  let skipped = 0;
  for (const row of rows) {
    const teamId = await findTeamIdFuzzy("cfb", row.team);
    if (!teamId) {
      skipped += 1;
      continue;
    }
    await upsertExternalRating({
      teamId,
      season: 2025,
      week: row.week,
      source: "manual_sp_weekly",
      rating: row.sp,
    });
    synced += 1;
  }
  return { synced, skipped };
}
