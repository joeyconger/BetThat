import type { Sport } from "../db/repo.js";

/**
 * Every constant here is a reasonable starting default, not a validated
 * value — there's no real historical CLV result yet to fit them against.
 * Phase 3's backtest harness is exactly where these get tuned: run the
 * backtest across a range of values for each and keep whatever actually
 * beats the closing line. Treat this file as "config to sweep," not
 * "settled physics."
 */
export interface RatingParams {
  /** Home-field advantage, in points added to the home side's expected margin. */
  homeFieldAdvantage: number;
  /** Converts a net-EPA/play differential into a point-margin equivalent. */
  pointsPerEpa: number;
  /** Elo-style learning rate: fraction of the prediction error absorbed into the rating each game. */
  baseK: number;
  /** How much a team's rating swings based on opponent strength. Retired for CFB (set to 0, see CFB_PARAMS) in favor of the broader pointsPerExplosiveness-family opponent-adjustment system — still active for NFL, which hasn't gone through that rebuild. */
  sosWeight: number;
  /** Rating-scale reference point the SOS multiplier is expressed against. */
  ratingScaleRef: number;
  /** Floor on the SOS multiplier so a blowout over a very weak opponent can't flip the sign of a rating update. */
  minSosMultiplier: number;
  /**
   * Ceiling on the SOS multiplier. Without this, a team's rating update is
   * amplified without bound by however strong its opponent's rating already
   * is — and that amplified rating then amplifies the next team's update
   * when they play it, chaining across the schedule graph as the season
   * progresses. Observed in practice: uncapped, this produced team ratings
   * in the millions (and eventually 1e26) by CFB week 9 of the 2024
   * backtest. Symmetric with minSosMultiplier's distance from 1.
   */
  maxSosMultiplier: number;
  /** How much of a team's final rating carries into next season (the rest regresses to league-average 0). */
  seasonCarryover: number;
  /** Points of predicted-margin uncertainty at zero games played; shrinks as sqrt(games played) grows. */
  baseErrorPoints: number;
  /** "Games worth of trust" the market line gets before the model's own signal outweighs it (see predict.ts). */
  marketShrinkageK: number;
  /** Weight (0-1) given to the prior season's CFBD SP+ rating vs. this model's own carryover, when seeding a new season's initial rating. CFB-only — SP+ doesn't exist for NFL. */
  spPriorWeight: number;
  /** Points of predicted-margin adjustment per unit z-score gap in CFBD's weekly Elo (see ratings/elo.ts's predictSpread). CFB-only — 0 for NFL, which CFBD doesn't cover. */
  eloSignalPoints: number;
  /**
   * Points of predicted-margin adjustment per unit z-score gap in the prior
   * season's CFBD SP+ (see ratings/elo.ts's predictSpread) — same mechanism
   * as eloSignalPoints, deliberately NOT the same mechanism as
   * spPriorWeight above. spPriorWeight blends SP+ into the one-time initial
   * carryover rating, where a real sweep found it consistently HURT cover
   * rate once weighted above ~0.3 (see spPriorWeight's history in
   * CFB_PARAMS below); eloSignalPoints' additive-every-week treatment of a
   * *different* external rating had "a genuine, fairly clean positive
   * effect" in the same sweep. This applies that same additive treatment
   * to SP+ instead, as a distinct hypothesis to test — not a replacement
   * for spPriorWeight, a second lever alongside it. CFB-only. Defaults to
   * 0 (no-op) — untested, needs a real sweep against production data
   * before trusting any nonzero value.
   */
  spSignalPoints: number;
  /**
   * Points added to the predicted margin per day of rest-advantage
   * differential (home team's days since their prior game minus away
   * team's) — same additive-signal shape as eloSignalPoints/spSignalPoints,
   * applied in ratings/elo.ts's predictSpread, not the rating update
   * itself (this is situational to a specific matchup, not a change in
   * either team's underlying strength). A real, well-documented effect in
   * both NFL and CFB (extra rest, especially a bye week, is a genuine
   * predictive edge) that nothing in this model used before. Both sports —
   * unlike eloSignalPoints/spSignalPoints, this doesn't depend on CFBD-only
   * data (game_date already exists for every game). Defaults to 0 (no-op)
   * — untested, needs a real sweep.
   */
  pointsPerRestDay: number;
  /**
   * Weight (0-1) given to success-rate differential vs. EPA differential
   * when computing a game's "how it went" performance signal in
   * computeSeasonRatings — 0 uses pure EPA (today's behavior), 1 uses pure
   * success rate. EPA/points-per-play is itself already closer to "the
   * result" than a box score (see computeSeasonRatings' doc), but it's
   * still dominated by a handful of explosive or garbage-time plays the
   * same way raw scoring margin is. Success rate (did this play move the
   * chains, regardless of how many yards it was worth) is the more
   * execution-focused, lower-variance signal — this is the same reasoning
   * SP+ itself uses to weight "efficiency" (success rate) and
   * "explosiveness" (a PPP/EPA-like measure) as separate components rather
   * than collapsing them into one number. Defaults to 0 (no-op, identical
   * to today's EPA-only behavior) — untested, needs a real sweep.
   */
  successRateWeight: number;
  /**
   * Scales a success-rate differential (typically -0.2 to 0.2 in practice)
   * into a point-margin equivalent, the same role pointsPerEpa plays for
   * EPA. Unlike pointsPerEpa (calibrated via a real sweep), this is a
   * first-guess placeholder — success rate differentials run roughly 3-5x
   * smaller in magnitude than the EPA differentials pointsPerEpa was tuned
   * against, so this starts at a proportionally larger multiplier, but it
   * has not itself been swept. Only takes effect when successRateWeight > 0.
   */
  pointsPerSuccessRate: number;
  /** Widens `confidence` as |marketSpreadHome| grows — a big market spread is a signal the prediction is less trustworthy (see ratings/elo.ts's predictSpread), for a confidence-based filter to screen out, NOT a lever on modelWeight (a modelWeight-only version was tried and proven to be a no-op, see predictSpread's doc). Smaller = widens confidence faster at a given spread size. */
  bigSpreadShrinkRef: number;
  /**
   * When true, computeSeasonRatings prefers each game's garbage-time-
   * excluded EPA/success rate (a second CFBD ingestion pass with
   * excludeGarbageTime=true — see ingest/cfbd/syncStats.ts) over the
   * regular all-plays value, per-field, falling back to the all-plays
   * value for any game that doesn't have the no-garbage columns ingested
   * yet. Distinct from successRateWeight: that's a SIGNAL blend (how much
   * to trust success rate vs. EPA), this is a DATA CLEANING toggle (which
   * plays count at all) — a backup mopping up 45-0 in the 4th quarter
   * inflates or deflates both EPA and success rate the same way, so this
   * is a binary switch, not something to partially blend. Defaults to
   * false (today's behavior, includes all plays) — untested, needs a
   * sweep once the no-garbage columns are actually ingested for a season.
   */
  excludeGarbageTime: boolean;
  /**
   * Opponent-adjusts each side's success rate against the opponent's
   * season-to-date tendency on the other side of the ball, before it feeds
   * the successRateWeight blend — succeeding against a defense that
   * normally suppresses success rate should count for more than the same
   * raw number against a defense that allows it to everyone (and
   * symmetrically for what a defense allows, against how good the
   * opponent's offense generally is). 0 = today's behavior (raw success
   * rate, no opponent adjustment) — a team's own rating already gets an
   * analogous adjustment via sosWeight, but that only scales the UPDATE
   * size, not the raw input number itself; this is the input-level
   * counterpart, for success rate specifically (not EPA — see
   * ratings/elo.ts's computeSeasonRatings doc). Only takes effect once a
   * team has at least MIN_SUCCESS_CONTEXT_GAMES of its own season-to-date
   * sample; before that, falls back to unadjusted raw success rate for
   * games against that team. Untested — needs a real sweep.
   */
  opponentAdjustWeight: number;
  /**
   * Weight (0-1) given to a "turnover-luck-stripped" EPA vs. raw EPA when
   * computing a game's performance signal in computeSeasonRatings — 0 uses
   * raw EPA (today's behavior, includes turnover plays' PPA), 1 uses EPA
   * with all turnover plays (interceptions, forced/lost fumbles — see
   * ingest/cfbd/syncTurnoverStats.ts for the exact CFBD play_type set)
   * removed from the average entirely. Turnovers are the most
   * variance-heavy, least repeatable events in football — a tipped pass
   * that happens to land in a defender's hands isn't a real skill signal
   * the way a sustained third-down conversion is — so this is an attempt
   * at the same "care about how the game went, not the result" goal as
   * successRateWeight, applied to a different source of noise. The
   * stripped value is NOT a flat subtraction of turnover PPA from the raw
   * average (that would ignore the play-count reweighting a true trimmed
   * average requires and over-correct) — see computeSeasonRatings for the
   * actual reweighted-average formula. Only takes effect for games with
   * turnover-stats ingested (falls back to raw EPA otherwise, same
   * degrade-don't-guess pattern as excludeGarbageTime). Defaults to 0
   * (no-op) — untested, needs ingestion + a real sweep.
   */
  turnoverLuckWeight: number;
  /**
   * Points of predicted-margin adjustment per unit z-score gap in REAL
   * week-by-week SP+ (see ratings/elo.ts's predictSpread) — same additive-
   * signal mechanism as eloSignalPoints/spSignalPoints, but sourced from
   * ingest/manual/syncManualSpWeekly.ts's manually-provided archive
   * instead of a live CFBD pull. Distinct from spSignalPoints (which
   * uses CFBD's own /ratings/sp — confirmed via their real API docs to
   * have NO week parameter at all, one frozen value per team per season)
   * — spSignalPoints tested that frozen value and it came back flat/
   * negative, plausibly because it's stale by the time it's applied
   * in-season. This is the same idea retried with genuinely fresh,
   * real in-season data, to see whether staleness (not SP+ itself) was
   * the actual problem. CFB-only, and currently only meaningful for
   * 2025 — the one season a real weekly archive exists for; any other
   * season/week has no manual_sp_weekly data, so this signal is a
   * silent no-op there regardless of the weight. Defaults to 0 (no-op)
   * — untested pending ingestion, and only single-season (2025-only)
   * validation is possible until archives for other seasons exist, so
   * even a positive in-sample 2025 result can't get the normal walk-
   * forward treatment — see README/adminJobs.ts for how that's handled.
   */
  weeklySpSignalPoints: number;
  /**
   * Points of predicted-margin adjustment per unit of net explosiveness
   * differential (home offense-minus-defense explosiveness, minus the
   * same for away — same net-differential shape as pointsPerEpa/
   * pointsPerSuccessRate, applied as an ADDITIVE term on top of the
   * existing epaMargin/successRateWeight blend in
   * ratings/elo.ts's computeSeasonRatings, not a replacement for
   * either) — part of the component-model rebuild (explosiveness,
   * down/distance splits, sack rate, finishing drives, special teams)
   * that replaced the old single SOS multiplier (see sosWeight's doc).
   * Explosiveness is CFBD's own metric (confirmed real field via their
   * client library docs, not guessed) — roughly "how big are this
   * team's successful plays," a genuinely different question from
   * successRate's "how often does a play succeed at all," which is why
   * this is additive rather than folded into the existing blend. Only
   * takes effect for a game with all four of home/away off/def
   * explosiveness present (falls back to a no-op otherwise, same
   * degrade-don't-guess pattern as every other optional signal). CFB-
   * only for now (NFL has no ingestion path yet). Defaults to 0 (no-op)
   * — untested, needs ingestion + a real sweep.
   */
  pointsPerExplosiveness: number;
  /**
   * Same additive-term shape as pointsPerExplosiveness, for the
   * standard-downs success-rate split specifically (CFBD's own down/
   * distance categorization — see client.ts's CfbdAdvancedSide doc).
   * "Standard downs" are non-obvious-passing situations (roughly: 1st
   * down, or 2nd/3rd-and-short) — this isolates efficiency specifically
   * in situations where the offense has real play-calling flexibility,
   * a different question from the OVERALL success rate already blended
   * in via successRateWeight (which mixes standard AND passing downs
   * together). CFB-only. Defaults to 0 (no-op) — untested.
   */
  pointsPerStandardDownsSplit: number;
  /**
   * Same shape as pointsPerStandardDownsSplit, for passing downs (obvious-
   * passing situations — 2nd/3rd-and-long) instead — isolates efficiency
   * when the defense knows a pass is very likely coming, a genuinely
   * different situational question than standard-downs success rate.
   * CFB-only. Defaults to 0 (no-op) — untested.
   */
  pointsPerPassingDownsSplit: number;
  /**
   * Same additive-term shape as pointsPerExplosiveness, for a team's net
   * sack advantage (def_sack_rate - off_sack_rate — see
   * ingest/cfbd/syncSackRateStats.ts's doc for why this pair is the one
   * INVERTED off/def convention in this whole rating model: off_sack_rate
   * is bad for the team that has it, def_sack_rate is good). Home net
   * advantage minus away net advantage feeds the same additive-margin
   * shape as every other pointsPer* signal. CFB-only. Defaults to 0
   * (no-op) — untested, needs ingestion (cfb-sackrate-ingest) + a real
   * sweep.
   */
  pointsPerSackRate: number;
  /**
   * Same additive-term shape as pointsPerExplosiveness, for "finishing
   * drives" (points per scoring opportunity, net home-minus-away — see
   * ingest/cfbd/syncFinishingDrivesStats.ts's doc for the exact
   * definition: avg points scored per drive that started inside the
   * opponent's 40). Phase 2 of the component-model rebuild — a genuinely
   * separate CFBD endpoint (/drives) from every other component so far,
   * capturing red-zone/short-field execution specifically, distinct from
   * general play-level efficiency (success rate, explosiveness) or
   * situational splits (down/distance). Standard off/def sign convention
   * (higher off = better, higher def = worse), unlike pointsPerSackRate.
   * CFB-only. Defaults to 0 (no-op) — untested, needs ingestion
   * (cfb-finishingdrives-ingest) + a real sweep.
   */
  pointsPerFinishingDrives: number;
  /**
   * Phase 3 (special teams) of the component-model rebuild: field position
   * — avg distance from a team's own goal line at the start of its drives
   * (own offense) vs. the same for opponents facing this team's defense
   * (kickoff/punt coverage quality) — net home-minus-away, same additive
   * shape as every other pointsPer* signal. Standard off/def sign
   * convention. See ingest/cfbd/syncSpecialTeamsStats.ts for the exact
   * definition and why punt/return efficiency specifically was deferred
   * (unverified net-punting/return-yardage attribution, and no clean
   * off/def pairing for punt distance the way field position and FG rate
   * both have). CFB-only. Defaults to 0 (no-op) — untested, needs
   * ingestion (cfb-specialteams-ingest) + a real sweep.
   */
  pointsPerFieldPosition: number;
  /**
   * Same additive shape as pointsPerFieldPosition, for field goal make
   * rate (this team's own kicker vs. the opponent's kicker when facing
   * this team's defense — see syncSpecialTeamsStats.ts). CFB-only.
   * Defaults to 0 (no-op) — untested.
   */
  pointsPerFgMakeRate: number;
  /**
   * The REAL opponent-adjustment mechanism (ratings/opponentAdjust.ts's
   * iterative solve over real play data), distinct from opponentAdjustWeight
   * above (a naive season-to-date-average approach, tested twice and found
   * negative both times — see that field's doc). Same additive shape as
   * every other pointsPerX term: diffs each team's already opponent-adjusted
   * off_adj/def_adj (computed upstream, fresh per week over PRIOR weeks
   * only — see ingest/cfbd/syncOpponentAdjustedStats.ts). CFB-only.
   * Defaults to 0 (no-op) — untested, needs the as-of-week sync job built
   * and run, then a real sweep.
   */
  pointsPerOpponentAdj: number;
}

const NFL_PARAMS: RatingParams = {
  homeFieldAdvantage: 1.5,
  pointsPerEpa: 35,
  baseK: 0.25,
  sosWeight: 0.15,
  ratingScaleRef: 10,
  minSosMultiplier: 0.2,
  maxSosMultiplier: 1.8,
  seasonCarryover: 0.6,
  baseErrorPoints: 8,
  marketShrinkageK: 8,
  spPriorWeight: 0, // no SP+ for NFL
  eloSignalPoints: 0, // no CFBD Elo for NFL
  spSignalPoints: 0, // no CFBD SP+ for NFL
  pointsPerRestDay: 0, // untested — needs a real sweep. Applies to both sports (game_date is universal), unlike the CFBD-only signals above.
  successRateWeight: 0, // untested — see RatingParams doc; 0 = today's pure-EPA behavior
  pointsPerSuccessRate: 90, // untested placeholder — see RatingParams doc
  bigSpreadShrinkRef: 40, // widens confidence at NFL's typical spread range (rarely exceeds ~20) — untested for NFL, conservative default until swept
  excludeGarbageTime: false, // untested — no-garbage columns not ingested for NFL yet (nflverse-based, not CFBD)
  opponentAdjustWeight: 0, // untested — no-op until swept
  turnoverLuckWeight: 0, // untested — turnover stats not ingested for NFL yet (would need an nflverse play-by-play source, not CFBD)
  weeklySpSignalPoints: 0, // no SP+ (weekly or otherwise) for NFL
  pointsPerExplosiveness: 0, // no explosiveness ingestion for NFL yet (nflverse-based, not CFBD)
  pointsPerStandardDownsSplit: 0, // same — no down/distance splits ingested for NFL yet
  pointsPerPassingDownsSplit: 0,
  pointsPerSackRate: 0, // no sack-rate ingestion for NFL yet (would need an nflverse play-by-play source, not CFBD)
  pointsPerFinishingDrives: 0, // no finishing-drives ingestion for NFL yet (would need an nflverse drive-level source, not CFBD)
  pointsPerFieldPosition: 0, // no special-teams ingestion for NFL yet
  pointsPerFgMakeRate: 0,
  pointsPerOpponentAdj: 0, // no raw-play ingestion for NFL yet
};

const CFB_PARAMS: RatingParams = {
  ...NFL_PARAMS,
  homeFieldAdvantage: 2.5,
  // Removed (set to 0) as of the component-model rebuild below --
  // sosWeight=0 makes homeSosMultiplier/awaySosMultiplier in elo.ts's
  // computeSeasonRatings mathematically collapse to a flat 1 every time
  // (1 + 0*rating = 1, clamped to [minSosMultiplier, maxSosMultiplier]
  // which always contains 1), a clean no-op requiring no code change.
  // Retired in favor of the new, broader opponent-adjustment system
  // (Phase 4) being built to cover every new component stat at once,
  // rather than keeping this old single-purpose SOS multiplier running
  // alongside it -- tonight's own opponentAdjustWeight sweep already
  // found a negative result plausibly caused by exactly this kind of
  // double-counting (see opponentAdjustWeight's history below), so
  // stacking a second, more thorough opponent-adjustment mechanism on
  // top of this one rather than replacing it was judged too likely to
  // repeat that mistake at a larger scale.
  sosWeight: 0,
  marketShrinkageK: 6, // shallower CFB schedules (12 games) mean less time to prove the model out
  // pointsPerEpa/spPriorWeight/eloSignalPoints below: calibrated from the
  // cfb-external-sweep run (see README "External ratings" / backtest run
  // 101-125) — spPriorWeight and eloSignalPoints were NOT independent
  // guesses like the rest of this file, they're the actual best-cover-rate
  // combo found (49.9%, still below the 52.4% breakeven line, but the
  // highest of every combo tested). Re-sweep if pointsPerEpa/baseK change,
  // since this pair was only tested holding those two fixed.
  pointsPerEpa: 20,
  spPriorWeight: 0, // swept 0-1: consistently HURT cover rate once weighted above ~0.3 — SP+'s uncertain preseason-vs-final timing (see README) looks like it's actively wrong, not just unhelpful
  eloSignalPoints: 1.5, // swept 0-3: genuine, fairly clean positive effect on cover rate, peaking around 1.5-2
  // spSignalPoints: swept 0-3 (cfb-spsignal-sweep, run 210-215) — unlike
  // eloSignalPoints, this one did NOT replicate the "additive treatment of
  // an external rating helps" pattern: 0 was the best value on both cover
  // rate (49.9%) and avgClv (0.62), and both metrics degraded monotonically
  // as the signal got stronger (48.9%/0.55 at spSignalPoints=3). Left at 0.
  // Best guess why eloSignalPoints helped and this doesn't: CFBD's weekly
  // Elo updates within-season (fresh info every week); SP+ here is frozen
  // at last year's final value for the whole season, so it's likely just
  // adding stale noise on top of what the model's own rating + market
  // blend already has, not new information.
  spSignalPoints: 0,
  // successRateWeight/pointsPerSuccessRate: swept 0-1 x 60-120
  // (cfb-successrate-sweep, run 216-228), then walk-forward validated
  // (cfb-successrate-walkforward, run 229-242: train on 2023-2024 only,
  // score the winning combo on the untouched 2025 season). In-sample sweep
  // found successRateWeight=0.75-1.0 with pointsPerSuccessRate=90-120
  // beating the EPA-only baseline (49.9% -> 50.5% cover), and the walk-
  // forward holdout, while showing the usual in-sample-to-holdout
  // shrinkage (train cover 51.5% -> holdout cover-vs-close 48.7%), still
  // beat the existing baseline's OWN 2025 holdout on the two metrics that
  // matter most: avg CLV (0.87 vs. 0.76) and cover-vs-opening-line (50.7%
  // vs. 50.0%, still short of the ~52.4% breakeven line). A real, modest
  // improvement, not a validated edge — n=762 on the holdout, SE~1.8pp, so
  // none of these shifts are individually conclusive on their own, but the
  // direction held across both the full sweep and an independent holdout.
  successRateWeight: 0.75,
  pointsPerSuccessRate: 120,
  // Uncalibrated starting point — widens confidence for predictions
  // fighting an extreme market spread, since backtest data showed those
  // losing more often than not (real CFB mismatches routinely hit 30-50+
  // points, more extreme than this rating system's compressed scale can
  // match — see README "Big-spread deviation"). A modelWeight-based
  // version of this same idea was tried first and proven mathematically
  // incapable of changing cover rate/CLV (see predictSpread's doc) — this
  // confidence-based version needs its own real sweep against
  // getConfidenceReport before trusting this specific value.
  bigSpreadShrinkRef: 25,
  // Inherited false from NFL_PARAMS — deliberately not flipped on yet.
  // CFBD's excludeGarbageTime param is confirmed to exist on the exact
  // endpoint already in use (/stats/game/advanced), but the no-garbage
  // columns need a real ingestion pass (cfb-garbage-time-ingest) and a
  // sweep + walk-forward validation before this is worth trusting, same
  // process successRateWeight just went through.
  excludeGarbageTime: false,
  // Swept 0-2 (cfb-oppadjust-sweep): a clean, monotonic NEGATIVE trend on
  // cover rate as weight increases past ~0.25. Likely double-counting with
  // sosWeight, which already adjusts each team's RATING UPDATE by opponent
  // strength — this adjusts the raw success-rate INPUT by the same
  // opponent's tendency, and stacking both seems to over-correct. Left at 0.
  opponentAdjustWeight: 0,
  // Swept -0.2 to 0.5 (cfb-restday-sweep): genuinely flat, no signal in
  // either direction (confirmed via the negative-value sanity check too).
  // Most likely explanation: the market already prices rest/bye
  // differential in efficiently, so there's nothing incremental left to
  // extract from an additive signal on top of the closing line. Left at 0.
  pointsPerRestDay: 0,
  // Swept 0-1 (cfb-turnoverluck-sweep, run 262-268, after cfb-turnover-
  // ingest): essentially flat — cover rate wobbles 50.5%-50.7% with no
  // clean monotonic trend and avgClv is unchanged (0.69-0.70) across the
  // whole grid, nothing like successRateWeight's real 0.6pp move with a
  // clear direction. Skipped the walk-forward holdout since the in-sample
  // sweep already shows no signal worth confirming — same call made for
  // opponentAdjustWeight and pointsPerRestDay above. Best guess why:
  // turnover luck is likely already substantially captured by the
  // success-rate blend this model runs on — a defense that forces
  // turnovers usually also suppresses success rate on the same drives, so
  // stripping turnovers out separately has little independent information
  // left to add. Left at 0.
  turnoverLuckWeight: 0,
  // Swept 0-3 (cfb-weeklyspsignal-sweep, run 273-278, 2025 only — the one
  // season a real weekly archive exists for): noisy, not a clean trend —
  // cover vs open bounces 50.4%-50.8% through most of the grid, then the
  // top-of-range value (weight=3) came out best at 52.1%, still short of
  // the ~52.4% breakeven and short of "significantly higher than 52%."
  // Same "best value sits at the edge of the tested range" pattern the
  // confidence-filter idea showed right before its walk-forward holdout
  // showed it was noise (see adminJobs.ts's cfb-confidence-walkforward) —
  // except this one has no possible holdout to confirm or refute it
  // against, since 2025 is the only season with real data. Verdict:
  // staleness (the diagnosed reason spSignalPoints failed) wasn't
  // actually the problem — real, fresh week-by-week SP+ still doesn't
  // add anything this model doesn't already have. Left at 0.
  weeklySpSignalPoints: 0,
  // Calibrated (not go/no-go — explicitly adopted regardless of whether
  // each individually clears breakeven, per instruction) via
  // cfb-component-ingest + cfb-component-sweep-* (run 279-322, two passes:
  // an initial coarse grid, then a refined grid around each one's best
  // region). Part of the component-model rebuild that replaced sosWeight
  // above (see that param's doc). None of these moved cover-vs-open more
  // than ~0.4pp from the sosWeight=0 baseline (52.0%) on its own — the
  // real value here (if any) may be in how they combine, not any single
  // one's isolated effect, which is exactly why they're being kept in
  // rather than screened out one at a time.
  //
  // pointsPerExplosiveness=8: best cover vs open in the refined sweep
  // (52.4%, tied with 12) with the best avgClv of that group (0.75).
  pointsPerExplosiveness: 8,
  // pointsPerStandardDownsSplit=10: cover vs open was flat/tied at 52.4%
  // across the whole 10-50 refined range, but avgClv declined steadily as
  // the weight increased (0.67 at 10 down to 0.58 at 50) — picked the
  // lowest weight in the tied-cover group, since it has no CLV cost for
  // the same cover rate.
  pointsPerStandardDownsSplit: 10,
  // pointsPerPassingDownsSplit=20: best cover vs open in the refined
  // sweep (52.2%), avgClv tied with the 0-weight baseline (0.69).
  pointsPerPassingDownsSplit: 20,
  // pointsPerSackRate=15: best cover vs open in the refined sweep (52.3%),
  // avgClv tied with the best of the group (0.69).
  pointsPerSackRate: 15,
  // Swept 0-20 (cfb-component-sweep-finishingdrives, run 323-327): unlike
  // every other component, this one shows a real, steep, CLEAN monotonic
  // decline in avgClv as weight increases (0.72 -> 0.64 -> 0.48 -> 0.34 ->
  // 0.17, a ~75% drop by weight=20) while cover vs open stays roughly flat
  // (52.0-52.4%) -- a genuine cost that gets worse with more weight, not
  // just "no signal" like the others. Calibrated to the smallest tested
  // nonzero value (closest to the 0-weight baseline on both metrics) per
  // instruction to keep it in regardless, rather than a value the data
  // argues for -- treat this as the deliberately-minimized end of a real
  // trade-off, not a neutral pick.
  pointsPerFinishingDrives: 2,
  // Calibrated via cfb-specialteams-ingest + cfb-component-sweep-*
  // (run 328-338). pointsPerFieldPosition=0.2: tied-best cover vs open
  // (52.4%, tied with 0.1) with the best avgClv of that pair (0.65);
  // declined beyond 0.2. pointsPerFgMakeRate=5: best cover vs open of
  // the WHOLE grid (52.5%, the single best value seen across every
  // Phase 1-3 component sweep tonight) with a still-reasonable avgClv
  // (0.60); both metrics declined steadily past weight=5.
  pointsPerFieldPosition: 0.2,
  pointsPerFgMakeRate: 5,
  // Untested — the real iterative-solve opponent-adjustment
  // (ratings/opponentAdjust.ts) is built and real-data-sanity-checked
  // (cfb-opponent-adjust-snapshot: converges cleanly, 2024 rankings match
  // reality), but off_adj/def_adj haven't been computed/ingested per-week
  // yet (needs ingest/cfbd/syncOpponentAdjustedStats.ts, not yet built) —
  // 0 until that exists and a real sweep has run.
  pointsPerOpponentAdj: 0,
};

export function getRatingParams(sport: Sport): RatingParams {
  return sport === "cfb" ? CFB_PARAMS : NFL_PARAMS;
}
