import { renderPage, nav, escapeHtml } from "../layout.js";
import type { AggregateStats, ThresholdStats, ConfidenceStats, SportSeasonStats } from "../../backtest/report.js";
import type { BacktestRunSummary } from "../../db/repo.js";

function fmtPct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function fmtSigned(value: number | null): string {
  if (value === null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}`;
}

function coverClass(value: number | null): string {
  if (value === null) return "muted";
  return value >= 0.5 ? "good" : "bad";
}

export function renderBacktestReport(
  run: BacktestRunSummary,
  overall: AggregateStats,
  thresholds: ThresholdStats[],
  confidence: ConfidenceStats[],
  bySeasonSport: SportSeasonStats[],
): string {
  const thresholdRows = thresholds
    .map(
      (t) => `<tr>
        <td class="num">${t.threshold}+</td>
        <td class="num">${t.games}</td>
        <td class="num ${coverClass(t.coverRate)}">${fmtPct(t.coverRate)}</td>
        <td class="num">${fmtSigned(t.avgClv)}</td>
      </tr>`,
    )
    .join("");

  const confidenceRows = confidence
    .map(
      (c) => `<tr>
        <td class="num">≤${c.maxConfidence}</td>
        <td class="num">${c.games}</td>
        <td class="num ${coverClass(c.coverRate)}">${fmtPct(c.coverRate)}</td>
        <td class="num">${fmtSigned(c.avgClv)}</td>
      </tr>`,
    )
    .join("");

  const seasonRows = bySeasonSport
    .map(
      (s) => `<tr>
        <td>${escapeHtml(s.sport)}</td>
        <td class="num">${s.season}</td>
        <td class="num">${s.games}</td>
        <td class="num ${coverClass(s.coverRate)}">${fmtPct(s.coverRate)}</td>
        <td class="num">${fmtSigned(s.avgClv)}</td>
      </tr>`,
    )
    .join("");

  const body = `
    <h1>Backtest #${run.id}: ${escapeHtml(run.name)}</h1>
    <p class="subtitle">${escapeHtml(run.method)} · ${escapeHtml(run.sport ?? "?")} · seasons ${run.seasonStart}–${run.seasonEnd}</p>
    ${nav()}
    <div class="banner">
      <strong>Cover rate</strong> is ATS win rate against the closing line for whichever side the
      model favored — needs no opening line, so it's the primary signal metric here.
      <strong>Avg CLV</strong> is only computed for games with a real opening line (currently rare —
      see README "Odds data"); "—" means none of the games in that row had one.
    </div>

    <h2>Overall</h2>
    <table>
      <thead><tr><th>Games</th><th>Cover rate</th><th>Avg CLV</th><th>Beat-close rate</th></tr></thead>
      <tbody><tr>
        <td class="num">${overall.games}</td>
        <td class="num ${coverClass(overall.coverRate)}">${fmtPct(overall.coverRate)}</td>
        <td class="num">${fmtSigned(overall.avgClv)}</td>
        <td class="num">${fmtPct(overall.beatCloseRate)}</td>
      </tr></tbody>
    </table>

    <h2>By deviation threshold</h2>
    <p class="subtitle">Restricting to picks where the model disagreed with the market by at least this much.</p>
    <table>
      <thead><tr><th>Min deviation (pts)</th><th>Games</th><th>Cover rate</th><th>Avg CLV</th></tr></thead>
      <tbody>${thresholdRows}</tbody>
    </table>

    <h2>By confidence</h2>
    <p class="subtitle">Restricting to picks with at least this much certainty (lower = more games observed when predicted) — a different question than deviation size above.</p>
    <table>
      <thead><tr><th>Max error (±pts)</th><th>Games</th><th>Cover rate</th><th>Avg CLV</th></tr></thead>
      <tbody>${confidenceRows}</tbody>
    </table>

    <h2>By sport/season</h2>
    <table>
      <thead><tr><th>Sport</th><th>Season</th><th>Games</th><th>Cover rate</th><th>Avg CLV</th></tr></thead>
      <tbody>${seasonRows}</tbody>
    </table>
  `;
  return renderPage(`Backtest #${run.id}`, body);
}
