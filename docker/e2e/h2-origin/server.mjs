// HTTP/2 test origin of scripts/e2e-h2.mjs and scripts/e2e-pp.mjs: HTTP/2
// with prior knowledge on 8080 and nothing else (an HTTP/1.1 request
// fails). /proto answers "HTTP/2.0 <authority>" with the authority it saw
// (the Host the node sent); the gRPC methods /e2e.Echo/Unary,
// /e2e.Echo/Bidi and /e2e.Echo/Fail echo raw-byte messages in gRPC's
// length-prefixed framing, the status in the trailers: Unary
// "echo:<message> authority=<authority> te=<TE>", Bidi "echo:<message>"
// per message as it arrives, Fail status 5.
//
// grpc.health.v1.Health/Check: "" and "e2e.Echo" are SERVING while
// /serving/1 was asked last on the control port (the start), NOT_SERVING
// after /serving/0; other services NOT_FOUND (status 5). Every call is
// counted per service (/checks on the control port).
//
// PROXY protocol (scripts/e2e-pp.mjs): 8081 serves HTTP/1.1 and 8083 the
// same HTTP/2 as 8080, both only after a PROXY protocol header (v1 or v2;
// a connection without one is closed). 8081 answers every request with
// "pp=<v> src=<address>:<port> dst=<address>:<port> conn=<n> req=<k>": the
// header's addresses ("local" for v2 LOCAL, "unknown" for v1 UNKNOWN), the
// connection's number and the request's number on it. 8082 is the control
// port (HTTP/1.1): /serving/<0|1>, /checks.
import http from "node:http";
import http2 from "node:http2";
import net from "node:net";
import { duplexPair } from "node:stream";

const frame = (message) => {
  const b = Buffer.alloc(5 + message.length);
  b.writeUInt32BE(message.length, 1);
  message.copy(b, 5);
  return b;
};

/** Calls onMessage with every gRPC message of the stream as it completes. */
function messages(stream, onMessage) {
  let buffer = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
      const n = buffer.readUInt32BE(1);
      onMessage(buffer.subarray(5, 5 + n));
      buffer = buffer.subarray(5 + n);
    }
  });
}

let serving = true;
const checks = {};

/** Answers grpc.health.v1.Health/Check with the service in the request. */
function healthCheck(stream) {
  messages(stream, (m) => {
    // HealthCheckRequest: field 1 (service), length-delimited; empty for "".
    const service = m.length > 2 && m[0] === 0x0a ? m.subarray(2, 2 + m[1]).toString() : "";
    checks[service] = (checks[service] ?? 0) + 1;
    if (service !== "" && service !== "e2e.Echo") {
      stream.respond(
        { ":status": 200, "content-type": "application/grpc", "grpc-status": "5" },
        {
          endStream: true,
        },
      );
      return;
    }
    stream.respond(
      { ":status": 200, "content-type": "application/grpc" },
      { waitForTrailers: true },
    );
    stream.on("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
    // HealthCheckResponse: field 1 (status), varint; SERVING 1, NOT_SERVING 2.
    stream.end(frame(Buffer.from([0x08, serving ? 1 : 2])));
  });
}

const onStream = (stream, headers) => {
  const path = headers[":path"] ?? "/";
  const authority = headers[":authority"] ?? headers.host ?? "-";
  stream.on("error", () => {});
  if (path === "/grpc.health.v1.Health/Check") {
    healthCheck(stream);
    return;
  }
  if (!(headers["content-type"] ?? "").startsWith("application/grpc")) {
    stream.respond({ ":status": 200, "content-type": "text/plain" });
    stream.end(path.startsWith("/proto") ? `HTTP/2.0 ${authority}\n` : `${path}\n`);
    return;
  }
  let status = 0;
  let message = "";
  stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
  stream.on("wantTrailers", () =>
    stream.sendTrailers({
      "grpc-status": String(status),
      ...(message ? { "grpc-message": message } : {}),
    }),
  );
  stream.on("end", () => stream.end());
  switch (path) {
    case "/e2e.Echo/Unary": {
      let replied = false;
      messages(stream, (m) => {
        if (replied) return;
        replied = true;
        stream.write(
          frame(Buffer.from(`echo:${m} authority=${authority} te=${headers.te ?? "-"}`)),
        );
      });
      break;
    }
    case "/e2e.Echo/Bidi":
      messages(stream, (m) => stream.write(frame(Buffer.concat([Buffer.from("echo:"), m]))));
      break;
    case "/e2e.Echo/Fail":
      status = 5;
      message = "no such thing";
      stream.resume();
      break;
    default:
      status = 12;
      message = "unknown method";
      stream.resume();
  }
};
const server = http2.createServer();
server.on("stream", onStream);
server.listen(8080, () => console.log("h2-origin: HTTP/2 with prior knowledge on 8080"));

const SIGNATURE = Buffer.from("\r\n\r\n\0\r\nQUIT\n", "binary");

/**
 * Parses a PROXY protocol header at the start of buffer: { header, length }
 * with the header's version and addresses, { length: 0 } while incomplete,
 * null when buffer starts with something else.
 */
function proxyHeader(buffer) {
  if (buffer.subarray(0, 6).toString() === "PROXY ") {
    const end = buffer.indexOf("\r\n");
    if (end < 0) return buffer.length < 108 ? { length: 0 } : null;
    const [, family, src, dst, sport, dport] = buffer.subarray(0, end).toString().split(" ");
    if (family === "UNKNOWN")
      return { header: { v: 1, src: "unknown", dst: "unknown" }, length: end + 2 };
    return { header: { v: 1, src: `${src}:${sport}`, dst: `${dst}:${dport}` }, length: end + 2 };
  }
  if (buffer.length < 16)
    return SIGNATURE.subarray(0, buffer.length).equals(buffer) ? { length: 0 } : null;
  if (!buffer.subarray(0, 12).equals(SIGNATURE)) return null;
  const length = 16 + buffer.readUInt16BE(14);
  if (buffer.length < length) return { length: 0 };
  if (buffer[12] === 0x20) return { header: { v: 2, src: "local", dst: "local" }, length };
  const ip = (b) =>
    b.length === 4 ? [...b].join(".") : b.toString("hex").replace(/(.{4})(?!$)/g, "$1:");
  const n = buffer[13] === 0x11 ? 4 : 16;
  const at = 16;
  const src = ip(buffer.subarray(at, at + n));
  const dst = ip(buffer.subarray(at + n, at + 2 * n));
  const sport = buffer.readUInt16BE(at + 2 * n);
  const dport = buffer.readUInt16BE(at + 2 * n + 2);
  return { header: { v: 2, src: `${src}:${sport}`, dst: `${dst}:${dport}` }, length };
}

/**
 * Listens on port for connections that start with a PROXY protocol header
 * and hands each, header removed, to target; others are closed.
 */
let connections = 0;
function proxied(port, target) {
  net
    .createServer((socket) => {
      let buffer = Buffer.alloc(0);
      socket.on("error", () => {});
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const parsed = proxyHeader(buffer);
        if (parsed === null) return socket.destroy();
        if (parsed.length === 0) return;
        socket.off("data", onData);
        // http2 reads a net.Socket's handle directly, bypassing unshift():
        // the server gets the rest of the connection through a pair.
        const [inner, outer] = duplexPair();
        inner.proxyHeader = { ...parsed.header, conn: ++connections, requests: 0 };
        outer.write(buffer.subarray(parsed.length));
        socket.pipe(outer).pipe(socket);
        outer.on("error", () => socket.destroy());
        target.emit("connection", inner);
      };
      socket.on("data", onData);
    })
    .listen(port, () => console.log(`h2-origin: PROXY protocol on ${port}`));
}

const http1 = http.createServer((req, res) => {
  const pp = req.socket.proxyHeader;
  pp.requests += 1;
  res.end(`pp=${pp.v} src=${pp.src} dst=${pp.dst} conn=${pp.conn} req=${pp.requests}\n`);
});
proxied(8081, http1);
const proxiedH2 = http2.createServer();
proxiedH2.on("stream", onStream);
proxied(8083, proxiedH2);

http
  .createServer((req, res) => {
    const set = /^\/serving\/([01])$/.exec(req.url ?? "");
    if (set) serving = set[1] === "1";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ serving, checks }));
  })
  .listen(8082, () => console.log("h2-origin: control on 8082"));
