import { createServer } from "node:http";
import { pool } from "./db/pool.js";

// A minimal, read-only debug/report surface for pulling backtest results
// and running ad hoc verification queries without deploy-log round trips.
// Not the (gated, not-yet-built) live-picks web app — this exposes no
// picks or recommendations, only raw diagnostic data behind a bearer token.
const PORT = process.env.PORT ?? "3000";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

function isAuthorized(authHeader: string | undefined): boolean {
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }

  if (req.method === "POST" && url.pathname === "/query") {
    if (!isAuthorized(req.headers.authorization)) {
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

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(Number(PORT), () => {
  console.log(`report server listening on ${PORT}`);
});
