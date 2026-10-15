// TLS test origin of scripts/e2e-g19.mjs (origin protection). The script
// writes the files into /run/origin-tls and sends SIGHUP; until the first
// files exist nothing listens.
//   :8443  server.pem / server.key, requires a client certificate the origin
//          client CA (client-ca.pem) issued (nginx's ssl_verify_client on)
//   :9443  server-csr.pem / server-csr.key, no client certificate
// Both speak HTTP/1.1 and HTTP/2 (ALPN). GET /whoami answers
// "<HTTP version> client=<the client certificate's CN, or none>"; the gRPC
// method /e2e.Echo/Unary answers "echo:<message> client=<CN>" with
// grpc-status 0 in the trailers.
import { readFileSync } from "node:fs";
import http2 from "node:http2";

const DIR = "/run/origin-tls";
const read = (name) => readFileSync(`${DIR}/${name}`);
const PORTS = {
  8443: () => ({
    cert: read("server.pem"),
    key: read("server.key"),
    ca: read("client-ca.pem"),
    requestCert: true,
    rejectUnauthorized: true,
  }),
  9443: () => ({ cert: read("server-csr.pem"), key: read("server-csr.key") }),
};

const frame = (message) => {
  const b = Buffer.alloc(5 + message.length);
  b.writeUInt32BE(message.length, 1);
  message.copy(b, 5);
  return b;
};

function clientOf(socket) {
  const cert = socket?.getPeerCertificate?.();
  return cert?.subject?.CN ?? "none";
}

function handle(req, res) {
  const client = clientOf(req.socket);
  if ((req.headers["content-type"] ?? "").startsWith("application/grpc")) {
    const chunks = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const message = body.length >= 5 ? body.subarray(5, 5 + body.readUInt32BE(1)).toString() : "";
      res.writeHead(200, { "content-type": "application/grpc" });
      res.addTrailers({ "grpc-status": "0" });
      res.end(frame(Buffer.from(`echo:${message} client=${client}`)));
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`${req.httpVersion} client=${client}\n`);
}

const servers = {};
function load() {
  for (const [port, options] of Object.entries(PORTS)) {
    let tls;
    try {
      tls = options();
    } catch {
      continue; // not written yet
    }
    if (servers[port]) {
      servers[port].setSecureContext(tls);
      continue;
    }
    const server = http2.createSecureServer({ ...tls, allowHTTP1: true }, handle);
    server.on("tlsClientError", () => {}); // refused clients are expected
    server.listen(Number(port), () => console.log(`origin-tls: listening on ${port}`));
    servers[port] = server;
  }
}

process.on("SIGHUP", () => {
  load();
  console.log("origin-tls: files reloaded");
});
load();
// Keeps the process alive before the first files arrive.
setInterval(() => {
  if (Object.keys(servers).length < Object.keys(PORTS).length) load();
}, 1000);
