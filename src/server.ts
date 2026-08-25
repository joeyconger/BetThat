import { createServer } from "node:http";
import { pool } from "./db/pool.js";
import { isBasicAuthorized, requireBasicAuth } from "./web/basicAuth.js";
import { renderHome } from "./web/pages/home.js";
import { renderBacktestReport } from "./web/pages/backtestReport.js";
import { renderSlatePage } from "./web/pages/slate.js";
import type { SimTeamOption } from "./web/pages/slate.js";
import {
  listBacktestRuns,
  getTeamRatingsForWeek,
  getPredictionsForWeek,
  getTeamNameToIdMap,
  getAvailableSeasons,
  getAvailableWeeks,
  getCurrentSeasonWeek,
} from "./db/repo.js";
import type { Sport } from "./db/repo.js";
import { predictHypotheticalMatchup, getProjectedScoresForWeek } from "./ratings/service.js";
import {
  getOverallReport,
  getOverallStatsByRun,
  getOpeningCoverRate,
  getThresholdReport,
  getConfidenceReport,
  getSportSeasonReport,
  getConferenceReport,
  getInOutConferenceReport,
  getWeekBucketReport,
  getHomeRoadBySpreadSizeReport,
  getHomeRoadByDeviationReport,
  getKeyNumberReport,
  getWeatherReport,
  getPrecipitationReport,
} from "./backtest/report.js";
import { listJobs, getJob, JOB_STARTERS } from "./adminJobs.js";

// A read-only diagnostics surface: backtest reports, team ratings, and raw
// model predictions vs. market lines. NOT the live-picks app (still
// gated — see README Phase 4 status); nothing here is framed as a
// recommendation. HTML routes require HTTP Basic auth (DASHBOARD_USER/
// DASHBOARD_PASSWORD, same shape as the other Railway app in this repo's
// history); /query keeps its own bearer-token auth for API-style access.
const PORT = process.env.PORT ?? "3000";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

function isQueryAuthorized(authHeader: string | undefined): boolean {
  if (!ADMIN_TOKEN) return false;
  return authHeader === `Bearer ${ADMIN_TOKEN}`;
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function html(res: import("node:http").ServerResponse, body: string): void {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

function isSport(value: string): value is Sport {
  return value === "nfl" || value === "cfb";
}

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    console.error("unhandled request error:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "text/plain" });
    }
    res.end("internal error");
  });
});

async function handleRequest(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("bad request");
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.method === "POST" && url.pathname === "/query") {
    if (!isQueryAuthorized(req.headers.authorization)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    try {
      const body = JSON.parse(await readBody(req)) as { sql?: string; params?: unknown[] };
      const sql = (body.sql ?? "").trim();
      if (!/^select\b/i.test(sql)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "only SELECT queries are allowed" }));
        return;
      }
      const result = await pool.query(sql, body.params ?? []);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ rows: result.rows, rowCount: result.rowCount }));
    } catch (err) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // Background job triggers — for anything too slow to run inside
  // startCommand without risking the deploy healthcheck (see adminJobs.ts).
  // Same bearer-token auth as /query.
  if (req.method === "POST" && /^\/admin\/jobs\/[\w-]+$/.test(url.pathname)) {
    if (!isQueryAuthorized(req.headers.authorization)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const name = url.pathname.split("/")[3]!;
    const starter = JOB_STARTERS[name];
    if (!starter) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `unknown job: ${name}`, available: Object.keys(JOB_STARTERS) }));
      return;
    }
    const job = await starter();
    res.writeHead(202, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ started: job.id }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/admin/jobs") {
    if (!isQueryAuthorized(req.headers.authorization)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(listJobs()));
    return;
  }

  if (req.method === "GET" && /^\/admin\/jobs\/[\w-]+$/.test(url.pathname)) {
    if (!isQueryAuthorized(req.headers.authorization)) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    const job = getJob(url.pathname.split("/")[3]!);
    if (!job) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "job not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(job));
    return;
  }

  // Everything below is the HTML dashboard — Basic-auth gated.
  if (!isBasicAuthorized(req.headers.authorization)) {
    requireBasicAuth(res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/backtests") {
    const [runs, statsByRun] = await Promise.all([listBacktestRuns(), getOverallStatsByRun()]);
    html(res, renderHome(runs, statsByRun));
    return;
  }

  if (req.method === "GET" && /^\/backtest\/\d+$/.test(url.pathname)) {
    const runId = Number(url.pathname.split("/")[2]);
    const runs = await listBacktestRuns();
    const run = runs.find((r) => r.id === runId);
    if (!run) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("backtest run not found");
      return;
    }
    const isCfb = run.sport === "cfb";
    const [
      overall,
      openingCover,
      thresholds,
      confidence,
      bySeasonSport,
      keyNumbers,
      weather,
      precipitation,
      conference,
      inOutConference,
      weekBucket,
      homeRoadSpread,
      homeRoadDeviation,
    ] = await Promise.all([
      getOverallReport(runId),
      getOpeningCoverRate(runId),
      getThresholdReport(runId),
      getConfidenceReport(runId),
      getSportSeasonReport(runId),
      getKeyNumberReport(runId),
      getWeatherReport(runId),
      getPrecipitationReport(runId),
      isCfb ? getConferenceReport(runId) : Promise.resolve([]),
      isCfb ? getInOutConferenceReport(runId) : Promise.resolve([]),
      isCfb ? getWeekBucketReport(runId) : Promise.resolve([]),
      isCfb ? getHomeRoadBySpreadSizeReport(runId) : Promise.resolve([]),
      isCfb ? getHomeRoadByDeviationReport(runId) : Promise.resolve([]),
    ]);
    html(
      res,
      renderBacktestReport(run, overall, openingCover, thresholds, confidence, bySeasonSport, {
        keyNumbers,
        weather,
        precipitation,
        conference,
        inOutConference,
        weekBucket,
        homeRoadSpread,
        homeRoadDeviation,
      }),
    );
    return;
  }

  if (req.method === "GET" && (url.pathname === "/slate" || url.pathname === "/")) {
    const sportParam = url.searchParams.get("sport") ?? "";
    let season = url.searchParams.get("season") ?? "";
    let week = url.searchParams.get("week") ?? "";
    const activeTab = url.searchParams.get("tab") ?? "weekly";
    const simHome = url.searchParams.get("home") ?? "";
    const simAway = url.searchParams.get("away") ?? "";
    const validSport = isSport(sportParam) ? sportParam : "cfb";

    // No season/week in the URL (e.g. the bare homepage) -- default to
    // whichever season/week has games closest to right now, so the
    // homepage shows something useful without forcing a selection first.
    if (season === "" || week === "") {
      const current = await getCurrentSeasonWeek(validSport);
      if (current) {
        season = String(current.season);
        week = String(current.week);
      }
    }
    const hasContext = season !== "" && week !== "";

    const [predictions, ratings, teamMap, availableSeasons, projectedScores] = await Promise.all([
      hasContext ? getPredictionsForWeek(validSport, Number(season), Number(week)) : Promise.resolve(null),
      hasContext ? getTeamRatingsForWeek(validSport, Number(season), Number(week)) : Promise.resolve(null),
      getTeamNameToIdMap(validSport),
      getAvailableSeasons(validSport),
      hasContext ? getProjectedScoresForWeek(validSport, Number(season), Number(week)) : Promise.resolve(new Map()),
    ]);
    const availableWeeks = hasContext ? await getAvailableWeeks(validSport, Number(season)) : [];
    const teams: SimTeamOption[] = [...teamMap.entries()]
      .map(([name, id]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const simResult =
      hasContext && simHome && simAway && simHome !== simAway
        ? await predictHypotheticalMatchup(validSport, Number(simHome), Number(simAway), Number(season), Number(week))
        : null;

    html(
      res,
      renderSlatePage({
        sport: validSport,
        season,
        week,
        activeTab,
        predictions,
        ratings,
        teams,
        simHome,
        simAway,
        simResult,
        availableSeasons,
        availableWeeks,
        projectedScores,
      }),
    );
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("not found");
}

server.listen(Number(PORT), () => {
  console.log(`server listening on ${PORT}`);
});
