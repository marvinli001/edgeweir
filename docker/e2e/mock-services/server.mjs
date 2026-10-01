// Local-only DNS provider and webhook sink for compose acceptance.

import http from "node:http";

const zones = new Map(),
  events = [];
const same = (a, b) => a.name === b.name && a.type === b.type && a.data === b.data;
const httpServer = http.createServer(async (req, res) => {
  const respond = (status, data) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };
  if (req.method === "GET" && req.url === "/health") return respond(200, { ok: true });
  if (req.method === "GET" && req.url === "/records")
    return respond(200, Object.fromEntries(zones));
  if (req.method === "GET" && req.url === "/events") return respond(200, events);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) return respond(413, { error: "too large" });
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    return respond(400, { error: "invalid JSON" });
  }
  if (req.method === "POST" && req.url === "/webhook") {
    events.push(body);
    return respond(200, { ok: true });
  }
  if (req.method === "POST" && req.url?.startsWith("/dns/")) {
    if (req.headers.authorization !== "Bearer e2e-dns-token")
      return respond(401, { error: "invalid fixture token" });
    if (typeof body.zone !== "string") return respond(400, { error: "zone required" });
    const old = zones.get(body.zone) ?? [],
      records = body.records ?? [],
      action = req.url.slice(5);
    if (action === "list") return respond(200, old);
    if (action === "delete")
      zones.set(
        body.zone,
        old.filter((r) => !records.some((next) => same(r, next))),
      );
    else if (action === "append")
      zones.set(body.zone, [
        ...old,
        ...records.filter((r) => !old.some((previous) => same(r, previous))),
      ]);
    else if (action === "set")
      zones.set(body.zone, [
        ...old.filter((r) => !records.some((next) => r.name === next.name && r.type === next.type)),
        ...records,
      ]);
    else return respond(404, { error: "operation not found" });
    return respond(200, records);
  }
  return respond(404, { error: "not found" });
});
httpServer.listen(8080, "0.0.0.0");
