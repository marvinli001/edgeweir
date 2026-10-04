import "reflect-metadata";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { connect, createServer as createTcpServer, type Server, type Socket } from "node:net";
import { createServer, type Server as TlsServer } from "node:tls";
import { NODE_CHANNEL_WEBSOCKET_PATH, NODE_CHANNEL_WEBSOCKET_PROTOCOL } from "@edgeweir/contract";
import { afterEach, describe, expect, it } from "vitest";
import { createWebSocketStream, WebSocketServer } from "ws";
import { CertificateAuthority, generateCa } from "../../src/server/pki/ca";
import { checkNodeChannelUrl } from "../../src/server/services/node-channel-check";

const servers: (Server | TlsServer | HttpServer)[] = [];
const sockets = new Set<Socket>();

async function listen(server: Server | TlsServer | HttpServer): Promise<number> {
  servers.push(server);
  server.on("connection", (socket: Socket) => sockets.add(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return address.port;
}

/** A TLS server presenting a certificate of `ca`, with or without the CA in the chain. */
async function tlsServer(ca: CertificateAuthority, withCa = true) {
  const cert = await ca.issueServerCertificate(["localhost", "127.0.0.1"]);
  return listen(
    createServer({
      key: cert.privateKeyPem,
      cert: withCa ? cert.certificatePem + ca.certificatePem : cert.certificatePem,
    }),
  );
}

/**
 * A WebSocket entry like the console's: each WebSocket on
 * NODE_CHANNEL_WEBSOCKET_PATH is piped to a TCP connection to `target`.
 */
async function webSocketEntry(target: number) {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: () => NODE_CHANNEL_WEBSOCKET_PROTOCOL,
  });
  const server = createHttpServer((_req, res) => res.writeHead(404).end());
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== NODE_CHANNEL_WEBSOCKET_PATH) return void socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      const stream = createWebSocketStream(ws);
      const tcp = connect(target, "127.0.0.1");
      sockets.add(tcp);
      stream.pipe(tcp).pipe(stream);
      tcp.on("error", () => stream.destroy());
      stream.on("error", () => tcp.destroy());
    });
  });
  return listen(server);
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

describe("the console's check of its node channel URL", async () => {
  const ca = await CertificateAuthority.load(await generateCa("Node CA"));
  const other = await CertificateAuthority.load(await generateCa("Proxy CA"));

  it("is ok when the console's node CA answers", async () => {
    const port = await tlsServer(ca);
    expect(await checkNodeChannelUrl(`https://127.0.0.1:${port}`, ca.fingerprintSha256)).toBe("ok");
    expect(
      await checkNodeChannelUrl(
        `https://localhost:${port}`,
        ca.fingerprintSha256.toUpperCase(),
        2000,
      ),
    ).toBe("ok");
  });

  it("reports a mismatch when another chain terminates TLS", async () => {
    const port = await tlsServer(other);
    expect(await checkNodeChannelUrl(`https://127.0.0.1:${port}`, ca.fingerprintSha256)).toBe(
      "mismatch",
    );
    // A leaf of the right CA without the CA itself is not the console's channel either.
    const bare = await tlsServer(ca, false);
    expect(await checkNodeChannelUrl(`https://127.0.0.1:${bare}`, ca.fingerprintSha256)).toBe(
      "mismatch",
    );
  });

  it("is unreachable when nothing listens or no handshake completes in time", async () => {
    const closed = await listen(createTcpServer());
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));
    expect(await checkNodeChannelUrl(`https://127.0.0.1:${closed}`, ca.fingerprintSha256)).toBe(
      "unreachable",
    );
    // Accepts the connection and never answers the ClientHello.
    const silent = await listen(createTcpServer(() => {}));
    const started = Date.now();
    expect(
      await checkNodeChannelUrl(`https://127.0.0.1:${silent}`, ca.fingerprintSha256, 200),
    ).toBe("unreachable");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await checkNodeChannelUrl("not a url", ca.fingerprintSha256)).toBe("unreachable");
  });
});

describe("the console's check of a wss:// or ws:// node channel URL", async () => {
  const ca = await CertificateAuthority.load(await generateCa("Node CA"));
  const other = await CertificateAuthority.load(await generateCa("Proxy CA"));

  it("is ok when the node CA answers inside the WebSocket", async () => {
    const entry = await webSocketEntry(await tlsServer(ca));
    expect(await checkNodeChannelUrl(`ws://127.0.0.1:${entry}`, ca.fingerprintSha256)).toBe("ok");
    // A URL saved in system settings connects to the address resolved before.
    expect(
      await checkNodeChannelUrl(
        `ws://entry.invalid:${entry}`,
        ca.fingerprintSha256,
        2000,
        "127.0.0.1",
      ),
    ).toBe("ok");
  });

  it("reports a mismatch when another chain answers or no entry upgrades", async () => {
    const proxied = await webSocketEntry(await tlsServer(other));
    expect(await checkNodeChannelUrl(`ws://127.0.0.1:${proxied}`, ca.fingerprintSha256)).toBe(
      "mismatch",
    );
    const plain = await listen(createHttpServer((_req, res) => res.writeHead(404).end()));
    expect(await checkNodeChannelUrl(`ws://127.0.0.1:${plain}`, ca.fingerprintSha256)).toBe(
      "mismatch",
    );
  });

  it("is unreachable when nothing listens or nothing answers in time", async () => {
    const closed = await listen(createTcpServer());
    await new Promise<void>((resolve) => servers.pop()?.close(() => resolve()));
    expect(await checkNodeChannelUrl(`ws://127.0.0.1:${closed}`, ca.fingerprintSha256)).toBe(
      "unreachable",
    );
    const silent = await listen(createTcpServer(() => {}));
    const started = Date.now();
    expect(await checkNodeChannelUrl(`wss://127.0.0.1:${silent}`, ca.fingerprintSha256, 200)).toBe(
      "unreachable",
    );
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
