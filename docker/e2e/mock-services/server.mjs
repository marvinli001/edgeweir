// Local-only DNS provider/TXT authority and webhook sink for compose acceptance.

import { createSocket } from "node:dgram";
import http from "node:http";

const zones = new Map(),
  txt = new Map(),
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
  const values = type === 16 ? (txt.get(name) ?? []) : [];
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
