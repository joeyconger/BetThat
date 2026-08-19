import { renderPage, nav, escapeHtml } from "../layout.js";
import type { BacktestRunSummary } from "../../db/repo.js";

export function renderHome(runs: BacktestRunSummary[]): string {
  const rows = runs
    .map(
      (run) => `<tr>
        <td><a class="run-link" href="/backtest/${run.id}">${run.id}</a></td>
        <td>${escapeHtml(run.name)}</td>
        <td>${escapeHtml(run.sport ?? "—")}</td>
        <td class="num">${run.seasonStart}–${run.seasonEnd}</td>
        <td class="muted">${new Date(run.createdAt).toISOString().slice(0, 16).replace("T", " ")}</td>
      </tr>`,
    )
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
            <thead><tr><th>ID</th><th>Name</th><th>Sport</th><th>Seasons</th><th>Run at</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`
    }
  `;
  return renderPage("Backtest runs", body);
}
