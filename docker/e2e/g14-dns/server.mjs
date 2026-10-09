// Test resolver for G14's verified crawlers (scripts/e2e-g14.mjs): node-g14
// uses it as its resolver. It answers the PTR, A and AAAA records the test
// puts on it and forwards every other query to Docker's embedded DNS
// (127.0.0.11 inside this container), so container names keep resolving.
//   PUT  http://g14-dns:8053/records  {"ptr": {"<ip>": "<name>"}, "a": {"<name>": ["<ip>"]}, "aaaa": {...}}
//   GET  http://g14-dns:8053/queries  the PTR, A and AAAA questions it answered itself
// Records replace the previous ones. Test data only; never use it elsewhere.
import dgram from "node:dgram";
import http from "node:http";
import { isIPv4, isIPv6 } from "node:net";

const UPSTREAM = { address: "127.0.0.11", port: 53 };
const TYPE = { A: 1, PTR: 12, AAAA: 28 };
let records = { ptr: {}, a: {}, aaaa: {} };
const answered = [];

const lower = (name) => name.toLowerCase().replace(/\.$/, "");

/** The reverse lookup name of an address (in-addr.arpa or ip6.arpa). */
function arpa(ip) {
  if (isIPv4(ip)) return `${ip.split(".").reverse().join(".")}.in-addr.arpa`;
  const parts = ip.split("::");
  const head = parts[0] ? parts[0].split(":") : [];
  const tail = parts[1] ? parts[1].split(":") : [];
  const groups = [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
  const hex = groups.map((g) => g.padStart(4, "0")).join("");
  return `${[...hex].reverse().join(".")}.ip6.arpa`;
}

/** Reads the name at `offset` (no compression in questions); returns [name, next offset]. */
function readName(msg, offset) {
  const labels = [];
  let i = offset;
  while (i < msg.length) {
    const len = msg[i];
    if (len === 0) return [labels.join("."), i + 1];
    if (len > 63) throw new Error("compressed question");
    labels.push(msg.subarray(i + 1, i + 1 + len).toString("latin1"));
    i += 1 + len;
  }
  throw new Error("truncated name");
}

function encodeName(name) {
  const parts = lower(name)
    .split(".")
    .filter(Boolean)
    .map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label, "latin1")]));
  return Buffer.concat([...parts, Buffer.from([0])]);
}

function rdata(type, value) {
  if (type === TYPE.A) return Buffer.from(value.split(".").map(Number));
  if (type === TYPE.AAAA) {
    const parts = value.split("::");
    const head = parts[0] ? parts[0].split(":") : [];
    const tail = parts[1] ? parts[1].split(":") : [];
    const groups = [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
    return Buffer.from(groups.flatMap((g) => [parseInt(g, 16) >> 8, parseInt(g, 16) & 255]));
  }
  return encodeName(value);
}

/** The answers this resolver gives itself, or null to forward the query. */
function lookup(name, type) {
  const key = lower(name);
  if (type === TYPE.PTR) {
    const ip = Object.keys(records.ptr).find((addr) => arpa(addr) === key);
    return ip === undefined ? null : [records.ptr[ip]];
  }
  const table = type === TYPE.A ? records.a : type === TYPE.AAAA ? records.aaaa : null;
  if (!table) return null;
  const own = Object.keys(table).find((n) => lower(n) === key);
  if (own !== undefined) return table[own];
  // A name the test owns for the other family answers with nothing (NOERROR).
  const other = type === TYPE.A ? records.aaaa : records.a;
  return Object.keys(other).some((n) => lower(n) === key) ? [] : null;
}

function reply(msg, questionEnd, type, values) {
  const header = Buffer.from(msg.subarray(0, 12));
  const rd = header[2] & 1;
  header[2] = 0x84 | rd; // QR, AA, RD as asked
  header[3] = 0x80; // RA, NOERROR
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(values.length, 6);
  header.writeUInt16BE(0, 8);
  header.writeUInt16BE(0, 10);
  const answers = values.map((value) => {
    const data = rdata(type, value);
    const rr = Buffer.alloc(12);
    rr.writeUInt16BE(0xc00c, 0);
    rr.writeUInt16BE(type, 2);
    rr.writeUInt16BE(1, 4);
    rr.writeUInt32BE(60, 6);
    rr.writeUInt16BE(data.length, 10);
    return Buffer.concat([rr, data]);
  });
  return Buffer.concat([header, msg.subarray(12, questionEnd), ...answers]);
}

const server = dgram.createSocket("udp4");
server.on("message", (msg, from) => {
  let handled = false;
  try {
    if (msg.length >= 12 && msg.readUInt16BE(4) === 1) {
      const [name, end] = readName(msg, 12);
      const type = msg.readUInt16BE(end);
      const values = lookup(name, type);
      if (values) {
        answered.push({ name: lower(name), type, values });
        if (answered.length > 1000) answered.shift();
        server.send(reply(msg, end + 4, type, values), from.port, from.address);
        handled = true;
      }
    }
  } catch {
    handled = false;
  }
  if (handled) return;
  const upstream = dgram.createSocket("udp4");
  const timer = setTimeout(() => upstream.close(), 3000);
  upstream.on("message", (answer) => {
    clearTimeout(timer);
    server.send(answer, from.port, from.address);
    upstream.close();
  });
  upstream.on("error", () => {
    clearTimeout(timer);
    upstream.close();
  });
  upstream.send(msg, UPSTREAM.port, UPSTREAM.address);
});
server.bind(53, "0.0.0.0");

http
  .createServer((req, res) => {
    if (req.method === "GET" && req.url === "/queries") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answered));
      return;
    }
    if (req.method !== "PUT" || req.url !== "/records") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        const next = JSON.parse(body);
        for (const ip of Object.keys(next.ptr ?? {}))
          if (!isIPv4(ip) && !isIPv6(ip)) throw new Error(`not an address: ${ip}`);
        records = { ptr: next.ptr ?? {}, a: next.a ?? {}, aaaa: next.aaaa ?? {} };
        answered.length = 0;
        res.writeHead(204).end();
      } catch (error) {
        res.writeHead(400, { "content-type": "text/plain" }).end(String(error));
      }
    });
  })
  .listen(8053, "0.0.0.0");
console.log("g14-dns: udp 53, http 8053");
