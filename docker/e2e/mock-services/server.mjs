// Local-only DNS provider and webhook sink for compose acceptance.
//
// DNS provider fixture (the "test" provider, EDGEWEIR_DNS_TEST_ENDPOINT):
// POST /dns/{list,append,set,delete,zones} with "Authorization: Bearer
// <token>"; every token in ACCOUNTS may write any zone, "zones" lists the
// account's zones. POST /fail {token, down} makes an account answer 503.
// Custom HTTP provider receiver (the "webhook" provider): POST /dns-hook,
// signed with WEBHOOK_SECRET as documented (X-Edgeweir-Signature: v1=HMAC).

import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";

const ACCOUNTS = {
  "e2e-dns-token": ["cdn.m5.test", "browser.cdn.test"],
  "e2e-dns-token-b": ["cdn-b.dns.test"],
};
const WEBHOOK_SECRET = "e2e-webhook-secret-0123";
const WEBHOOK_ZONES = ["dns-hook.test"];

const zones = new Map(),
  events = [],
  down = new Set();
const same = (a, b) => a.name === b.name && a.type === b.type && a.data === b.data;

/** Applies a provider action to a zone; returns the answer records. */
function apply(zone, action, records) {
  const old = zones.get(zone) ?? [];
  if (action === "list") return old;
  if (action === "delete")
    zones.set(
      zone,
      old.filter((r) => !records.some((next) => same(r, next))),
    );
  else if (action === "append")
    zones.set(zone, [...old, ...records.filter((r) => !old.some((previous) => same(r, previous)))]);
  else if (action === "set")
    zones.set(zone, [
      ...old.filter((r) => !records.some((next) => r.name === next.name && r.type === next.type)),
      ...records,
    ]);
  else return null;
  return records;
}

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
  const raw = Buffer.concat(chunks);
  let body;
  try {
    body = JSON.parse(raw.toString() || "{}");
  } catch {
    return respond(400, { error: "invalid JSON" });
  }
  if (req.method === "POST" && req.url === "/webhook") {
    events.push(body);
    return respond(200, { ok: true });
  }
  if (req.method === "POST" && req.url === "/fail") {
    if (!(body.token in ACCOUNTS)) return respond(400, { error: "unknown token" });
    if (body.down) down.add(body.token);
    else down.delete(body.token);
    return respond(200, { ok: true });
  }
  if (req.method === "POST" && req.url === "/dns-hook") {
    const timestamp = req.headers["x-edgeweir-timestamp"] ?? "";
    const signature = String(req.headers["x-edgeweir-signature"] ?? "");
    const expected = `v1=${createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.`).update(raw).digest("hex")}`;
    const fresh = Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300;
    if (
      !fresh ||
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      return respond(401, { error: "invalid signature" });
    if (body.action === "zones") return respond(200, { zones: WEBHOOK_ZONES });
    if (!WEBHOOK_ZONES.includes(body.zone)) return respond(404, { error: "unknown zone" });
    const records = apply(body.zone, body.action, body.records ?? []);
    if (!records) return respond(400, { error: "unknown action" });
    return respond(200, { records });
  }
  if (req.method === "POST" && req.url?.startsWith("/dns/")) {
    const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (!(token in ACCOUNTS)) return respond(401, { error: "invalid fixture token" });
    if (down.has(token)) return respond(503, { error: "provider down" });
    const action = req.url.slice(5);
    if (action === "zones") return respond(200, ACCOUNTS[token]);
    if (typeof body.zone !== "string") return respond(400, { error: "zone required" });
    const records = apply(body.zone, action, body.records ?? []);
    if (!records) return respond(404, { error: "operation not found" });
    return respond(200, records);
  }
  return respond(404, { error: "not found" });
});
httpServer.listen(8080, "0.0.0.0");
