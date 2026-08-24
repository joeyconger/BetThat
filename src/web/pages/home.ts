import { renderPage, nav, escapeHtml } from "../layout.js";
import type { BacktestRunSummary } from "../../db/repo.js";
import type { AggregateStats } from "../../backtest/report.js";

function fmtPct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function coverClass(value: number | null): string {
  if (value === null) return "muted";
  return value >= 0.5 ? "good" : "bad";
}

export function renderHome(runs: BacktestRunSummary[], statsByRun: Map<number, AggregateStats>): string {
  const rows = runs
    .map((run) => {
      const stats = statsByRun.get(run.id);
      return `<tr>
        <td><a class="run-link" href="/backtest/${run.id}">${run.id}</a></td>
        <td>${escapeHtml(run.name)}</td>
        <td>${escapeHtml(run.sport ?? "—")}</td>
        <td class="num">${run.seasonStart}–${run.seasonEnd}</td>
        <td class="num">${stats ? stats.games : 0}</td>
        <td class="num ${coverClass(stats?.coverRate ?? null)}">${fmtPct(stats?.coverRate ?? null)}</td>
        <td class="muted">${new Date(run.createdAt).toISOString().slice(0, 16).replace("T", " ")}</td>
      </tr>`;
    })
    .join("");

  const body = `
    <h1>Bet That — diagnostics</h1>
    <p class="subtitle">Backtest runs, team ratings, and model predictions. Read-only.</p>
    ${nav()}
    <div class="banner">
      This is a diagnostics dashboard, not the live-picks app — Phase 4 (live picks) is
      still gated until the backtest shows real signal. Nothing here is a betting
      recommendation.
    </div>
    <h2>Backtest runs</h2>
    ${
      runs.length === 0
        ? `<p class="muted">No backtest runs yet.</p>`
        : `<table>
            <thead><tr><th>ID</th><th>Name</th><th>Sport</th><th>Seasons</th><th>Games</th><th>Cover rate</th><th>Run at</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`
    }
  `;
  return renderPage("Backtest runs", body, "/backtests");
}
