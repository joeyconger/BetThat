export function isBasicAuthorized(authHeader: string | undefined): boolean {
  const user = process.env.DASHBOARD_USER;
  const pass = process.env.DASHBOARD_PASSWORD;
  if (!user || !pass) return false;
  if (!authHeader?.startsWith("Basic ")) return false;

  const decoded = Buffer.from(authHeader.slice("Basic ".length), "base64").toString("utf8");
  const separatorIndex = decoded.indexOf(":");
  if (separatorIndex === -1) return false;

  return decoded.slice(0, separatorIndex) === user && decoded.slice(separatorIndex + 1) === pass;
}

export function requireBasicAuth(res: import("node:http").ServerResponse): void {
  res.writeHead(401, { "WWW-Authenticate": 'Basic realm="Bet That"', "Content-Type": "text/plain" });
  res.end("Authentication required");
}
