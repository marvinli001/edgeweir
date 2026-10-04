import "reflect-metadata";
import { webcrypto } from "node:crypto";
import { createServer, type Server } from "node:http";
import { connect as tlsConnect } from "node:tls";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { NODE_CHANNEL_WEBSOCKET_PATH, NODE_CHANNEL_WEBSOCKET_PROTOCOL } from "@edgeweir/contract";
import { ApplyState, NodeService } from "@edgeweir/proto";
import { getRequestListener } from "@hono/node-server";
import * as x509 from "@peculiar/x509";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket, { createWebSocketStream } from "ws";
import { createApp } from "../../src/server/app";
import { type NodeChannel, startNodeChannel } from "../../src/server/node-channel/server";
import {
  attachNodeChannelWebSocket,
  isNodeChannelUpgrade,
} from "../../src/server/node-channel/websocket";
import { type ApiClient, createTestContext, rpcClient, setupPlatform, signIn } from "./helpers";

async function nodeKeyAndCsr() {
  const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const keys = (await webcrypto.subtle.generateKey(alg, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: "CN=edge-host",
    keys: keys as never,
    signingAlgorithm: alg,
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey));
  const keyPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString("base64")}\n-----END PRIVATE KEY-----\n`;
  return { csrPem: csr.toString("pem"), keyPem };
}

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

  /** Opens a WebSocket to the entry; rejects with the HTTP status when it is refused. */
  const openWebSocket = (
    options: WebSocket.ClientOptions = {},
    protocol = NODE_CHANNEL_WEBSOCKET_PROTOCOL,
  ) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`${entry}${NODE_CHANNEL_WEBSOCKET_PATH}`, protocol, options);
      sockets.push(ws);
      ws.once("open", () => resolve(ws));
      ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
      ws.once("error", reject);
    });

  /** A NodeService client whose HTTP/2 connection runs inside one WebSocket. */
  const nodeClient = async (
    tls: { cert?: string; key?: string } = {},
    headers: Record<string, string> = {},
  ) => {
    const ws = await openWebSocket({ headers });
    const options = { ca: ctx.nodeCa.certificatePem, servername: "localhost", ...tls };
    return createClient(
      NodeService,
      createConnectTransport({
        baseUrl: "https://localhost",
        httpVersion: "2",
        nodeOptions: {
          ...options,
          createConnection: () =>
            tlsConnect({ ...options, socket: createWebSocketStream(ws), ALPNProtocols: ["h2"] }),
        },
      }),
    );
  };

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
    await new Promise<void>((resolve) => web.close(() => resolve()));
    await channel.close();
    await pglite.close();
  });

  it("is closed while the node channel URL is an https:// one", async () => {
    await expect(openWebSocket()).rejects.toThrow("HTTP 404");
    expect(await plainGet()).toBe(404);
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
});
