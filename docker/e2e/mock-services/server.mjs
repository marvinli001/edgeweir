// Local-only DNS provider/TXT authority and webhook sink for compose acceptance.
//
// DNS provider fixture (the "test" provider, EDGEWEIR_DNS_TEST_ENDPOINT):
// POST /dns/{list,append,set,delete,zones} with "Authorization: Bearer
// <token>"; every token in ACCOUNTS may write any zone, "zones" lists the
// account's zones. POST /fail {token, down} makes an account answer 503.
// Custom HTTP provider receiver (the "webhook" provider): POST /dns-hook,
// signed with WEBHOOK_SECRET as documented (X-Edgeweir-Signature: v1=HMAC).
// UDP :5353 answers TXT from /txt and from TXT records in the zones.

import { createHmac, timingSafeEqual } from "node:crypto";
import { createSocket } from "node:dgram";
import http from "node:http";

const ACCOUNTS = {
  "e2e-dns-token": ["cdn.m5.test", "browser.cdn.test"],
  "e2e-dns-token-b": ["cdn-b.dns.test"],
};
const WEBHOOK_SECRET = "e2e-webhook-secret-0123";
const WEBHOOK_ZONES = ["dns-tenant.test"];

const zones = new Map(),
  txt = new Map(),
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
  if (req.method === "POST" && req.url === "/txt") {
    if (
      typeof body.name !== "string" ||
      !Array.isArray(body.values) ||
      body.values.some((v) => typeof v !== "string" || Buffer.byteLength(v) > 255)
    )
      return respond(400, { error: "invalid TXT" });
    txt.set(body.name, body.values);
    return respond(200, { ok: true });
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

/** TXT values of a name: /txt entries and TXT records of the zones. */
function txtValues(name) {
  const values = [...(txt.get(name) ?? [])];
  for (const [zone, records] of zones) {
    if (name !== zone && !name.endsWith(`.${zone}`)) continue;
    const relative = name === zone ? "@" : name.slice(0, -zone.length - 1);
    for (const r of records) if (r.type === "TXT" && r.name === relative) values.push(r.data);
  }
  return values;
}

const dns = createSocket("udp4");
dns.on("message", (query, remote) => {
  if (query.length < 17) return;
  let offset = 12;
  const labels = [];
  while (offset < query.length && query[offset]) {
    const size = query[offset];
    if (size > 63 || offset + size >= query.length) return;
    labels.push(query.subarray(offset + 1, offset + 1 + size).toString());
    offset += size + 1;
  }
  if (offset + 5 > query.length) return;
  const type = query.readUInt16BE(offset + 1),
    name = labels.join(".").toLowerCase();
  offset += 5;
  const values = type === 16 ? txtValues(name) : [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0));
  header.writeUInt16BE(values.length ? 0x8180 : 0x8183, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(values.length, 6);
  const answers = values.map((value) => {
    const data = Buffer.from(value),
      rr = Buffer.alloc(13);
    rr.writeUInt16BE(0xc00c);
    rr.writeUInt16BE(16, 2);
    rr.writeUInt16BE(1, 4);
    rr.writeUInt32BE(1, 6);
    rr.writeUInt16BE(data.length + 1, 10);
    rr[12] = data.length;
    return Buffer.concat([rr, data]);
  });
  dns.send(
    Buffer.concat([header, query.subarray(12, offset), ...answers]),
    remote.port,
    remote.address,
  );
});
dns.bind(5353, "0.0.0.0");
