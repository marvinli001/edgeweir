import "reflect-metadata";
import { createServer, type Server } from "node:http";
import {
  type AddressInfo,
  createServer as createTcpServer,
  type Server as TcpServer,
  connect as tcpConnect,
} from "node:net";
import { createServer as createTlsServer, connect as tlsConnect } from "node:tls";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { NODE_CHANNEL_WEBSOCKET_PATH, NODE_CHANNEL_WEBSOCKET_PROTOCOL } from "@edgeweir/contract";
import { ApplyState, NodeService } from "@edgeweir/proto";
import { getRequestListener } from "@hono/node-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { createWebSocketStream } from "ws";
import { createApp } from "../../src/server/app";
import { CHECK_HEADER, issueCheckToken } from "../../src/server/node-channel/check-token";
import { type NodeChannel, startNodeChannel } from "../../src/server/node-channel/server";
import {
  attachNodeChannelWebSocket,
  clientBucket,
  isNodeChannelUpgrade,
  MAX_MESSAGE_BYTES,
  WEBSOCKET_ENTRY_LIMITS,
  type WebSocketEntryLimits,
} from "../../src/server/node-channel/websocket";
import { CertificateAuthority, generateCa } from "../../src/server/pki/ca";
import {
  checkNodeChannel,
  checkNodeChannelUrl,
} from "../../src/server/services/node-channel-check";
import { type ApiClient, createTestContext, rpcClient, setupPlatform, signIn } from "./helpers";
import { nodeKeyAndCsr } from "./node-csr";

/** Resolves with the close code once ws is closed (-1: it already was). */
const closed = (ws: WebSocket) =>
  new Promise<number>((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) resolve(-1);
    else ws.once("close", (code) => resolve(code));
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A second entry on its own port with other bounds; `entry` is its ws:// base. */
async function smallEntry(
  app: Parameters<typeof attachNodeChannelWebSocket>[1],
  fetch: Parameters<typeof getRequestListener>[0],
  channel: NodeChannel,
  limits: Partial<WebSocketEntryLimits>,
) {
  const server = createServer(
    { shouldUpgradeCallback: isNodeChannelUpgrade },
    getRequestListener(fetch),
  );
  attachNodeChannelWebSocket(server, app, channel, { ...WEBSOCKET_ENTRY_LIMITS, ...limits });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const entry = `ws://127.0.0.1:${port}`;
  return {
    server,
    entry,
    /** Ends the test's WebSockets to this entry, then the server (it waits for every bridge). */
    close: (sockets: readonly WebSocket[]) => {
      for (const ws of sockets) if (ws.url.startsWith(entry)) ws.terminate();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe("the per-address bucket of a WebSocket client", () => {
  it("is the IPv4 address, or the /64 of an IPv6 one", () => {
    expect(clientBucket("198.51.100.7")).toBe("198.51.100.7");
    expect(clientBucket("2001:db8:1:2:3:4:5:6")).toBe("2001:db8:1:2::/64");
    expect(clientBucket("2001:db8:1:2::ffff")).toBe("2001:db8:1:2::/64");
    expect(clientBucket("2001:db8:1:3::1")).toBe("2001:db8:1:3::/64");
    expect(clientBucket("")).toBe("");
  });
});

describe("the node channel's WebSocket entry", async () => {
  // The WebSocket clients connect from loopback, a trusted proxy here.
  const { ctx, client: pglite } = await createTestContext({
    EDGEWEIR_TRUSTED_PROXIES: "127.0.0.1",
  });
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let channel: NodeChannel;
  let web: Server;
  let entry: string;
  const sockets: WebSocket[] = [];
  const relays: TcpServer[] = [];

  /** Opens a WebSocket to the entry; rejects with the HTTP status when it is refused. */
  const openWebSocket = (
    options: WebSocket.ClientOptions = {},
    protocol = NODE_CHANNEL_WEBSOCKET_PROTOCOL,
    base = entry,
  ) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`${base}${NODE_CHANNEL_WEBSOCKET_PATH}`, protocol, options);
      sockets.push(ws);
      ws.once("open", () => resolve(ws));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once("error", reject);
    });

  /**
   * A NodeService client connected the way a node is: its TLS runs on a local
   * socket whose bytes travel inside one WebSocket to the entry. (TLS over the
   * WebSocket stream itself is unreliable under HTTP/2 in Node.js 24.)
   */
  const bridgedNode = async (
    tls: { cert?: string; key?: string } = {},
    headers: Record<string, string> = {},
    base = entry,
  ) => {
    const ws = await openWebSocket({ headers }, NODE_CHANNEL_WEBSOCKET_PROTOCOL, base);
    const relay = createTcpServer((socket) => {
      const stream = createWebSocketStream(ws);
      socket.pipe(stream).pipe(socket);
      socket.on("error", () => stream.destroy());
      stream.on("error", () => socket.destroy());
    });
    relays.push(relay);
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    const { port } = relay.address() as AddressInfo;
    const options = { ca: ctx.nodeCa.certificatePem, servername: "localhost", ...tls };
    const client = createClient(
      NodeService,
      createConnectTransport({
        baseUrl: "https://localhost",
        httpVersion: "2",
        nodeOptions: {
          ...options,
          createConnection: () =>
            tlsConnect({ ...options, host: "127.0.0.1", port, ALPNProtocols: ["h2"] }),
        },
      }),
    );
    return { ws, client };
  };
  const nodeClient = async (
    tls: { cert?: string; key?: string } = {},
    headers: Record<string, string> = {},
  ) => (await bridgedNode(tls, headers)).client;

  const plainGet = async () =>
    (await fetch(`${entry}${NODE_CHANNEL_WEBSOCKET_PATH}`.replace(/^ws/, "http"))).status;

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    channel = await startNodeChannel(ctx);
    web = createServer(
      { shouldUpgradeCallback: isNodeChannelUpgrade },
      getRequestListener(app.fetch),
    );
    attachNodeChannelWebSocket(web, ctx, channel);
    await new Promise<void>((resolve) => web.listen(0, "127.0.0.1", resolve));
    const address = web.address();
    if (!address || typeof address === "string") throw new Error("no address");
    entry = `ws://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    for (const relay of relays) relay.close();
    await new Promise<void>((resolve) => web.close(() => resolve()));
    await channel.close();
    await pglite.close();
  });

  it("is closed while the node channel URL is an https:// one", async () => {
    await expect(openWebSocket()).rejects.toThrow("HTTP 404");
    expect(await plainGet()).toBe(404);
  });

  it("takes the console's own check while closed, once per token", async () => {
    const fingerprint = ctx.nodeCa.fingerprintSha256;
    const checkToken = issueCheckToken(ctx.env.EDGEWEIR_MASTER_KEY);
    // The node channel's TLS inside the WebSocket, through a closed entry.
    expect(await checkNodeChannelUrl(entry, fingerprint, 3000, { checkToken })).toBe("ok");
    expect(await checkNodeChannelUrl(entry, fingerprint, 3000, { checkToken })).toBe("mismatch");
    expect(await checkNodeChannelUrl(entry, fingerprint, 3000)).toBe("mismatch");
    const other = issueCheckToken(Buffer.alloc(32, 9).toString("base64"));
    await expect(openWebSocket({ headers: { [CHECK_HEADER]: other } })).rejects.toThrow("HTTP 404");
    expect(await plainGet()).toBe(404);

    // A check's bridge lasts checkMs: it never authenticates.
    const small = await smallEntry(ctx, app.fetch, channel, { checkMs: 300 });
    try {
      const ws = await openWebSocket(
        { headers: { [CHECK_HEADER]: issueCheckToken(ctx.env.EDGEWEIR_MASTER_KEY) } },
        undefined,
        small.entry,
      );
      const started = Date.now();
      expect(await closed(ws)).not.toBe(-1);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      await small.close(sockets);
    }
  });

  it("finds the closed entry behind a proxy that terminates the node channel's TLS", async () => {
    // A CDN in front of the node channel port: its own certificate, the bytes relayed on.
    const proxyCa = await CertificateAuthority.load(await generateCa("CDN CA"));
    const proxyCert = await proxyCa.issueServerCertificate(["localhost", "127.0.0.1"]);
    const proxy = createTlsServer(
      { key: proxyCert.privateKeyPem, cert: proxyCert.certificatePem },
      (socket) => {
        const upstream = tcpConnect((channel.server.address() as AddressInfo).port, "127.0.0.1");
        socket.pipe(upstream).pipe(socket);
        socket.on("error", () => upstream.destroy());
        upstream.on("error", () => socket.destroy());
      },
    );
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxied = `https://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    const env = {
      publicUrl: ctx.env.EDGEWEIR_PUBLIC_URL,
      apiUrl: ctx.env.EDGEWEIR_NODE_API_URL,
      nodeApiUrl: ctx.env.nodeApiUrl,
    };
    // The operator's addresses (environment), checked as they are.
    ctx.env.EDGEWEIR_PUBLIC_URL = entry.replace(/^ws/, "http");
    ctx.env.EDGEWEIR_NODE_API_URL = proxied;
    ctx.env.nodeApiUrl = proxied;
    let clock = Date.now() + 7_200_000;
    try {
      const check = await checkNodeChannel(ctx, () => (clock += 60_000));
      expect(check).toMatchObject({
        url: proxied,
        result: "mismatch",
        candidate: { url: entry, result: "ok" },
      });
      // Checked, not opened.
      expect(await plainGet()).toBe(404);

      // Switching saves the candidate: the entry opens, the change is audited.
      const saved = await admin.settings.setNodeChannel({ url: entry });
      expect(saved).toMatchObject({ effectiveUrl: entry, source: "setting" });
      expect(await plainGet()).toBe(426);
      const after = await checkNodeChannel(ctx, () => (clock += 60_000));
      expect(after).toMatchObject({ url: entry, candidate: null });
      expect(after.result).not.toBe("mismatch");
    } finally {
      ctx.env.EDGEWEIR_PUBLIC_URL = env.publicUrl;
      ctx.env.EDGEWEIR_NODE_API_URL = env.apiUrl;
      ctx.env.nodeApiUrl = env.nodeApiUrl;
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it("opens with a wss:// node channel URL and serves the node channel inside", async () => {
    await admin.settings.setNodeChannel({ url: "wss://localhost" });
    expect(await plainGet()).toBe(426);

    const token = await admin.clusters.createEnrollmentToken({ clusterId, nodeName: "edge-ws" });
    expect(token.installCommand).toContain("--server wss://localhost");
    const { csrPem, keyPem } = await nodeKeyAndCsr();
    const enrolled = await (await nodeClient({}, { "x-forwarded-for": "203.0.113.9" })).enroll({
      token: token.token,
      csrPem,
      info: { hostname: "edge-host", supportedFeatures: [] },
    });
    // The WebSocket client's address, resolved like any request to the web port.
    expect((await admin.nodes.get({ id: enrolled.nodeId })).remoteAddress).toBe("203.0.113.9");

    // After enrollment every call needs the node's certificate, through the entry too.
    const mtls = await nodeClient({ cert: enrolled.certificatePem, key: keyPem });
    await mtls.reportStatus({ appliedRevision: 0n, state: ApplyState.APPLYING });
    expect((await admin.nodes.get({ id: enrolled.nodeId })).online).toBe(true);
    const refused = await (await nodeClient())
      .reportStatus({ appliedRevision: 0n, state: ApplyState.APPLYING })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ConnectError);
    expect((refused as ConnectError).code).toBe(Code.Unauthenticated);
  });

  it("never answers browsers or other WebSocket protocols", async () => {
    await expect(openWebSocket({ origin: "https://evil.example" })).rejects.toThrow("HTTP 403");
    await expect(openWebSocket({}, "chat")).rejects.toThrow("HTTP 400");
  });

  it("stays open for enrolled nodes after the URL is changed back", async () => {
    await admin.settings.setNodeChannel({ url: "https://localhost:8443" });
    expect(await plainGet()).toBe(426);
    const ws = await openWebSocket();
    expect(ws.protocol).toBe(NODE_CHANNEL_WEBSOCKET_PROTOCOL);
  });

  it("bounds the bridges at once, idle ones and the message size", async () => {
    // A second entry with small bounds (the entry is still open: wss:// was saved before).
    const small = createServer(
      { shouldUpgradeCallback: isNodeChannelUpgrade },
      getRequestListener(app.fetch),
    );
    attachNodeChannelWebSocket(small, ctx, channel, {
      ...WEBSOCKET_ENTRY_LIMITS,
      bridges: 3,
      bridgesPerClient: 2,
      idleMs: 2000,
    });
    await new Promise<void>((resolve) => small.listen(0, "127.0.0.1", resolve));
    const { port } = small.address() as AddressInfo;
    const open = (client: string) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(
          `ws://127.0.0.1:${port}${NODE_CHANNEL_WEBSOCKET_PATH}`,
          NODE_CHANNEL_WEBSOCKET_PROTOCOL,
          { headers: { "x-forwarded-for": client } },
        );
        sockets.push(ws);
        ws.once("open", () => resolve(ws));
        ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
        ws.once("error", reject);
      });
    try {
      const a1 = await open("198.51.100.1");
      await open("198.51.100.1");
      await expect(open("198.51.100.1")).rejects.toThrow("HTTP 503");
      await open("198.51.100.2");
      await expect(open("198.51.100.3")).rejects.toThrow("HTTP 503");
      // A closed bridge gives its place back.
      a1.close();
      await closed(a1);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const again = await open("198.51.100.1");
      // Nothing either way for idleMs: closed by the entry.
      expect(await closed(again)).not.toBe(-1);
      // A message over MAX_MESSAGE_BYTES ends the bridge (1009: too big).
      await new Promise((resolve) => setTimeout(resolve, 50));
      const big = await open("198.51.100.4");
      big.send(Buffer.alloc(MAX_MESSAGE_BYTES + 1));
      expect(await closed(big)).toBe(1009);
    } finally {
      await new Promise<void>((resolve) => small.close(() => resolve()));
    }
  });

  it("counts an IPv6 client by its /64", async () => {
    const small = await smallEntry(ctx, app.fetch, channel, { bridgesPerClient: 2 });
    const open = (client: string) =>
      openWebSocket({ headers: { "x-forwarded-for": client } }, undefined, small.entry);
    try {
      await open("2001:db8:1:2::1");
      await open("2001:db8:1:2::2");
      // Another address of the same /64 is the same client.
      await expect(open("2001:db8:1:2:ffff:ffff:ffff:ffff")).rejects.toThrow("HTTP 503");
      await open("2001:db8:1:3::1");
    } finally {
      await small.close(sockets);
    }
  });

  it("closes bridges without a verified client certificate after authenticateMs", async () => {
    const small = await smallEntry(ctx, app.fetch, channel, {
      bridges: 3,
      authenticateMs: 1500,
      idleMs: 60_000,
    });
    try {
      const token = await admin.clusters.createEnrollmentToken({
        clusterId,
        nodeName: "edge-auth",
      });
      const { csrPem, keyPem } = await nodeKeyAndCsr();
      const enrolled = await (await nodeClient()).enroll({
        token: token.token,
        csrPem,
        info: { hostname: "edge-auth", supportedFeatures: [] },
      });
      // No TLS at all.
      const silent = await openWebSocket({}, undefined, small.entry);
      // TLS without a client certificate, busy the whole time: only enrollments are served.
      const anonymous = await bridgedNode({}, {}, small.entry);
      // The node's certificate.
      const node = await bridgedNode(
        { cert: enrolled.certificatePem, key: keyPem },
        {},
        small.entry,
      );
      await node.client.reportStatus({ appliedRevision: 0n, state: ApplyState.APPLYING });
      await expect(openWebSocket({}, undefined, small.entry)).rejects.toThrow("HTTP 503");
      let busy = true;
      const attempts = (async () => {
        let refused = 0;
        while (busy) {
          const error = await anonymous.client
            .enroll({ token: "not-a-token", csrPem })
            .catch((e: unknown) => e);
          if (error instanceof ConnectError && error.code === Code.PermissionDenied) refused++;
          await sleep(100);
        }
        return refused;
      })();
      const started = Date.now();
      const ends = [closed(silent), closed(anonymous.ws)];
      for (const code of await Promise.all(ends)) expect(code).not.toBe(-1);
      busy = false;
      expect(await attempts).toBeGreaterThan(0);
      expect(Date.now() - started).toBeLessThan(5000);
      // The node keeps its bridge, and the closed ones gave theirs back.
      await sleep(500);
      expect(node.ws.readyState).toBe(WebSocket.OPEN);
      await node.client.reportStatus({ appliedRevision: 0n, state: ApplyState.APPLYING });
      await openWebSocket({}, undefined, small.entry);
    } finally {
      await small.close(sockets);
    }
  });

  it("closes the socket of a refused upgrade, even when the client keeps its side open", async () => {
    // An entry of its own: its only connection is this one.
    const small = await smallEntry(ctx, app.fetch, channel, {});
    const { port } = small.server.address() as AddressInfo;
    const socket = tcpConnect({ host: "127.0.0.1", port, allowHalfOpen: true });
    const response = new Promise<string>((resolve) => {
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk.toString();
      });
      socket.once("end", () => resolve(text));
    });
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(
      [
        `GET ${NODE_CHANNEL_WEBSOCKET_PATH} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        `Sec-WebSocket-Protocol: ${NODE_CHANNEL_WEBSOCKET_PROTOCOL}`,
        "Origin: https://evil.example",
        "",
        "",
      ].join("\r\n"),
    );
    expect(await response).toMatch(/^HTTP\/1\.1 403 /);
    // Our side is still open; the entry's is gone.
    const connections = () =>
      new Promise<number>((resolve, reject) =>
        small.server.getConnections((error, count) => (error ? reject(error) : resolve(count))),
      );
    for (let i = 0; i < 50 && (await connections()) > 0; i++) await sleep(20);
    expect(await connections()).toBe(0);
    expect(socket.writable).toBe(true);
    socket.destroy();
    await small.close(sockets);
  });
});

describe("the node channel's WebSocket entry without trusted proxies", async () => {
  const { ctx, client: pglite } = await createTestContext({ EDGEWEIR_NODE_API_WEBSOCKET: "true" });
  const app = createApp(ctx);
  let channel: NodeChannel;
  const sockets: WebSocket[] = [];
  beforeAll(async () => {
    await setupPlatform(ctx);
    channel = await startNodeChannel(ctx);
  });
  afterAll(async () => {
    for (const ws of sockets) ws.terminate();
    await channel.close();
    await pglite.close();
  });

  it("has no per-address cap, and unauthenticated clients cannot hold the bridges", async () => {
    const small = await smallEntry(ctx, app.fetch, channel, {
      bridges: 3,
      bridgesPerClient: 1,
      authenticateMs: 1000,
      idleMs: 60_000,
    });
    const open = () =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(
          `${small.entry}${NODE_CHANNEL_WEBSOCKET_PATH}`,
          NODE_CHANNEL_WEBSOCKET_PROTOCOL,
        );
        sockets.push(ws);
        ws.once("open", () => resolve(ws));
        ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
        ws.once("error", reject);
      });
    try {
      // Every client has the same (a platform proxy's) address: no cap per address.
      const held = [await open(), await open(), await open()];
      const ends = held.map(closed);
      await expect(open()).rejects.toThrow("HTTP 503");
      // None of them starts a TLS handshake with a node certificate: closed, places given back.
      for (const code of await Promise.all(ends)) expect(code).not.toBe(-1);
      await open();
    } finally {
      await small.close(sockets);
    }
  });
});
