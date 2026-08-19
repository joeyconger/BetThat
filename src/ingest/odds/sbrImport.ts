/**
 * NOT YET IMPLEMENTED — historical odds importer for backtesting.
 *
 * SportsbookReviewsOnline (sportsbookreviewsonline.com) publishes free
 * season-by-season NFL/CFB spread + total + moneyline spreadsheets (opening
 * and closing lines), distributed as downloadable Excel files rather than
 * an API — there's nothing to poll here, only a file to import. The exact
 * column layout has drifted across seasons in the past (row-pair-per-game
 * with an "Open"/"Close" column being the common thread), so rather than
 * hard-code a column mapping no one has checked against a real file, this
 * is left as a scaffold: download a season file, inspect its header row,
 * and fill in `parseSbrWorkbook` against the real columns before relying on
 * it — same "verify against the real thing before trusting it" rule this
 * project follows for the ESPN injury endpoints (see injuries/espnClient.ts).
 *
 * Target shape once implemented: read a local .xlsx/.csv path, emit rows
 * matching db/repo.ts's InsertOddsSnapshotInput (snapshotType 'opening' /
 * 'closing'), matched to a game via team abbreviation + date the same way
 * syncCurrentOdds.ts matches Odds API events.
 */
export async function importSbrArchive(_filePath: string): Promise<{ synced: number; skipped: number }> {
  throw new Error(
    "importSbrArchive is not implemented yet — download a season file from " +
      "sportsbookreviewsonline.com, inspect its columns, and implement the mapping. See the file header comment.",
  );
}
