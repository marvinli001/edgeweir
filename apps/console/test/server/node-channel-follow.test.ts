import "reflect-metadata";
import { webcrypto } from "node:crypto";
import { checkServerIdentity, connect, type PeerCertificate } from "node:tls";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { CHANNEL_FOLLOW_FEATURE, type Node, nodeChannelStateOf } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import {
  ChannelSource,
  type ChannelStatus,
  ChannelStatusSchema,
  NodeService,
  ProbeService,
} from "@edgeweir/proto";
import * as x509 from "@peculiar/x509";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import { type NodeChannel, startNodeChannel } from "../../src/server/node-channel/server";
import { nodeChannelWebSocketOpen } from "../../src/server/services/node-channel-url";
import { deleteNode, getNode, listNodes, setNodeStatus } from "../../src/server/services/nodes";
import { listProbes } from "../../src/server/services/probes";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const OLD = "https://old.example.test:9443";
const NEW = "https://new.example.test:9443";

async function keyAndCsr() {
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

/** What an agent with channel-follow-v1 reports. */
interface Report {
  fallback?: { url: string };
  source?: ChannelSource;
  failed?: { url: string };
  errorCode?: string;
  error?: string;
  failedAt?: { seconds: bigint; nanos: number };
}
const status = (url: string, extra: Report = {}): ChannelStatus =>
  create(ChannelStatusSchema, {
    current: { url },
    source: extra.source ?? ChannelSource.ENROLL,
    errorCode: extra.errorCode ?? "",
    error: extra.error ?? "",
    ...(extra.fallback ? { fallback: extra.fallback } : {}),
    ...(extra.failed ? { failed: extra.failed } : {}),
    ...(extra.failedAt ? { failedAt: extra.failedAt } : {}),
  });

describe("enrolled nodes and probes follow the node channel URL", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let channel: NodeChannel;
  let port = 0;
  let clusterId = "";

  type Cert = { certificatePem: string; keyPem: string };
  /** Connects like an agent whose address names `servername`. */
  const transport = (servername: string, cert?: Cert) =>
    createConnectTransport({
      baseUrl: `https://localhost:${port}`,
      httpVersion: "2",
      nodeOptions: {
        ca: ctx.nodeCa.certificatePem,
        servername,
        ...(cert ? { cert: cert.certificatePem, key: cert.keyPem } : {}),
      },
    });
  const nodeAt = (servername: string, cert: Cert) =>
    createClient(NodeService, transport(servername, cert));

  const enrollNode = async (nodeName: string) => {
    const token = await admin.clusters.createEnrollmentToken({ clusterId, nodeName });
    expect(token.serverUrl).toBe(OLD);
    const { csrPem, keyPem } = await keyAndCsr();
    const enrolled = await createClient(NodeService, transport("old.example.test")).enroll({
      token: token.token,
      csrPem,
    });
    return { id: enrolled.nodeId, cert: { certificatePem: enrolled.certificatePem, keyPem } };
  };
  const names = () => channel.certificate.names;
  const presented = (servername: string) =>
    new Promise<PeerCertificate>((resolve, reject) => {
      const socket = connect({
        host: "127.0.0.1",
        port,
        servername,
        ca: ctx.nodeCa.certificatePem,
      });
      socket.once("error", reject);
      socket.once("secureConnect", () => {
        resolve(socket.getPeerCertificate());
        socket.end();
      });
    });
  const stateOf = async (node: Node) => {
    const desired = await admin.settings.nodeChannel();
    return nodeChannelStateOf(node.channel, {
      url: desired.effectiveUrl,
      serverName: desired.serverName,
    });
  };

  let actor: { type: "user"; id: string };

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    const [operator] = await ctx.db
      .select({ id: schema.user.id })
      .from(schema.user)
      .where(eq(schema.user.email, "admin@example.com"));
    actor = { type: "user", id: operator?.id ?? "" };
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    channel = await startNodeChannel(ctx);
    const address = channel.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    port = address.port;
    await admin.settings.setNodeChannel({ url: OLD });
    await vi.waitFor(() => expect(names()).toContain("old.example.test"));
  });
  afterAll(async () => {
    await channel.close();
    await pglite.close();
  });

  let follower: Awaited<ReturnType<typeof enrollNode>>;
  let older: Awaited<ReturnType<typeof enrollNode>>;

  it("hands the URL to nodes with channel-follow-v1 and records what every node uses", async () => {
    follower = await enrollNode("edge-follow");
    older = await enrollNode("edge-older");
    const answer = await nodeAt("old.example.test", follower.cert).reportStatus({
      info: { supportedFeatures: [CHANNEL_FOLLOW_FEATURE] },
      channel: status(OLD),
    });
    expect(answer.channel).toMatchObject({ url: OLD, serverName: "old.example.test" });
    const legacy = await nodeAt("old.example.test", older.cert).reportStatus({
      info: { supportedFeatures: ["tls-v1"] },
    });
    expect(legacy.channel).toBeUndefined();

    const node = await getNode(ctx.db, follower.id);
    expect(node.channel).toMatchObject({
      url: OLD,
      fallbackUrl: null,
      onFallback: false,
      source: "enroll",
      error: null,
      observedServerName: "old.example.test",
      observedWebSocket: false,
    });
    expect((await getNode(ctx.db, older.id)).channel).toMatchObject({
      url: null,
      observedServerName: "old.example.test",
    });
    expect(await stateOf(node)).toBe("current");
    expect((await admin.settings.nodeChannel()).adoption).toEqual({
      nodes: 2,
      nodesCurrent: 2,
      probes: 0,
      probesCurrent: 0,
    });
  });

  it("gives out a new URL; nodes not on it yet show as pending or needing an upgrade", async () => {
    await admin.settings.setNodeChannel({ url: NEW });
    await vi.waitFor(() => expect(names()).toContain("new.example.test"));
    // The earlier name stays in the certificate for the nodes still on it.
    expect(checkServerIdentity("old.example.test", await presented("old.example.test"))).toBe(
      undefined,
    );
    const answer = await nodeAt("old.example.test", follower.cert).reportStatus({
      info: { supportedFeatures: [CHANNEL_FOLLOW_FEATURE] },
      channel: status(OLD),
    });
    expect(answer.channel).toMatchObject({ url: NEW, serverName: "new.example.test" });
    await nodeAt("old.example.test", older.cert).reportStatus({ info: {} });

    const nodes = await listNodes(ctx.db);
    const byId = (id: string) => nodes.find((n) => n.id === id) as Node;
    expect(await stateOf(byId(follower.id))).toBe("pending");
    expect(await stateOf(byId(older.id))).toBe("upgrade");
    const settings = await admin.settings.nodeChannel();
    expect(settings.previousNames).toEqual([{ name: "old.example.test", nodes: 2, probes: 0 }]);
    expect(settings.adoption).toMatchObject({ nodes: 2, nodesCurrent: 0 });
  });

  it("shows why a node could not switch", async () => {
    await nodeAt("old.example.test", follower.cert).reportStatus({
      info: { supportedFeatures: [CHANNEL_FOLLOW_FEATURE] },
      channel: status(OLD, {
        failed: { url: NEW },
        errorCode: "unreachable",
        error: "dial tcp 203.0.113.9:9443: i/o timeout",
        failedAt: { seconds: 1_800_000_000n, nanos: 0 },
      }),
    });
    const node = await getNode(ctx.db, follower.id);
    expect(node.channel?.error).toEqual({
      code: "unreachable",
      message: "dial tcp 203.0.113.9:9443: i/o timeout",
      url: NEW,
      serverName: "",
      at: new Date(1_800_000_000_000).toISOString(),
    });
    expect(await stateOf(node)).toBe("failed");
  });

  it("answers CheckChannel for the node behind the certificate, disabled or not", async () => {
    const client = nodeAt("new.example.test", follower.cert);
    expect(await client.checkChannel({})).toMatchObject({
      nodeId: follower.id,
      channel: { url: NEW, serverName: "new.example.test" },
    });
    await setNodeStatus(ctx.db, follower.id, "disabled", actor);
    expect((await client.checkChannel({})).nodeId).toBe(follower.id);
    await expect(client.reportStatus({})).rejects.toMatchObject({ code: Code.PermissionDenied });
    await setNodeStatus(ctx.db, follower.id, "active", actor);
    // Without a client certificate: nothing.
    const anonymous = createClient(NodeService, transport("new.example.test"));
    const refused = await anonymous.checkChannel({}).catch((error: unknown) => error);
    expect(ConnectError.from(refused).code).toBe(Code.Unauthenticated);
  });

  it("answers with its clock and keeps the offset the node measured against it", async () => {
    const client = nodeAt("new.example.test", follower.cert);
    const before = Date.now();
    const checked = await client.checkChannel({});
    const consoleTime = (t?: { seconds: bigint; nanos: number }) =>
      t ? Number(t.seconds) * 1000 + Math.floor(t.nanos / 1e6) : 0;
    expect(consoleTime(checked.consoleTime)).toBeGreaterThanOrEqual(before - 1000);
    expect(consoleTime(checked.consoleTime)).toBeLessThanOrEqual(Date.now() + 1000);
    // Before its first measurement a node sends no offset.
    const first = await client.reportStatus({});
    expect(consoleTime(first.consoleTime)).toBeGreaterThanOrEqual(before - 1000);
    expect((await getNode(ctx.db, follower.id)).clock).toBeNull();
    await client.reportStatus({ clockOffsetMillis: -42_000n });
    expect((await getNode(ctx.db, follower.id)).clock).toMatchObject({
      offsetMs: -42_000,
      skewed: true,
    });
    // Skewed against the alert policy's threshold.
    await admin.alerts.setPolicy({ clockSkewSeconds: 60 });
    expect((await getNode(ctx.db, follower.id)).clock?.skewed).toBe(false);
    await admin.alerts.setPolicy({});
    // A heartbeat without an offset keeps the last one; an absurd one is clamped.
    await client.reportStatus({});
    expect((await getNode(ctx.db, follower.id)).clock?.offsetMs).toBe(-42_000);
    await client.reportStatus({ clockOffsetMillis: 10n ** 15n });
    expect((await getNode(ctx.db, follower.id)).clock?.offsetMs).toBe(2 ** 31 - 1);
    await client.reportStatus({ clockOffsetMillis: 12n });
    expect((await getNode(ctx.db, follower.id)).clock).toMatchObject({
      offsetMs: 12,
      skewed: false,
    });
  });

  it("keeps an earlier name while a node connects with it, and drops it once none does", async () => {
    // The node switched: it connects with the new name and keeps the old URL as its fallback.
    await nodeAt("new.example.test", follower.cert).reportStatus({
      info: { supportedFeatures: [CHANNEL_FOLLOW_FEATURE] },
      channel: status(NEW, { fallback: { url: OLD }, source: ChannelSource.CONSOLE }),
    });
    expect(await stateOf(await getNode(ctx.db, follower.id))).toBe("current");
    // The older node still connects with the old name.
    expect((await admin.settings.nodeChannel()).previousNames).toEqual([
      { name: "old.example.test", nodes: 1, probes: 0 },
    ]);
    const inUse = await rpcError(
      admin.settings.removeNodeChannelName({ name: "old.example.test" }),
    );
    expect(inUse.code).toBe("NODE_CHANNEL_NAME_IN_USE");
    expect(inUse.data).toEqual({ nodes: 1, probes: 0 });
    expect(names()).toContain("old.example.test");

    // Names the environment gives, the current one and unknown ones are not removable.
    for (const name of ["localhost", "new.example.test", "never.example.test"])
      expect((await rpcError(admin.settings.removeNodeChannelName({ name }))).code, name).toBe(
        "NODE_CHANNEL_NAME_NOT_FOUND",
      );

    // A node whose certificate expired must enroll again: it does not count.
    await ctx.db
      .update(schema.node)
      .set({ certNotAfter: new Date(Date.now() - 1000) })
      .where(eq(schema.node.id, older.id));
    expect((await admin.settings.nodeChannel()).adoption).toMatchObject({
      nodes: 1,
      nodesCurrent: 1,
    });
    await deleteNode(ctx.db, older.id, actor);

    // The fallback the switched node keeps does not hold the name.
    const saved = await admin.settings.removeNodeChannelName({ name: "old.example.test" });
    expect(saved.previousNames).toEqual([]);
    await vi.waitFor(() => expect(names()).not.toContain("old.example.test"));
    // A node verifying the old name is refused now.
    await expect(presented("old.example.test")).rejects.toThrow(/altnames/);
    const audits = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "system.node_channel_update"));
    const audit = audits.find((a) => (a.metadata as { removedName?: string }).removedName);
    expect(audit?.metadata).toEqual({ before: NEW, after: NEW, removedName: "old.example.test" });
  });

  it("closes the WebSocket entry an earlier URL opened once no node uses it", async () => {
    expect((await rpcError(admin.settings.closeNodeChannelWebSocket())).code).toBe(
      "NODE_CHANNEL_WEBSOCKET_REQUIRED",
    );
    await admin.settings.setNodeChannel({ url: "wss://ws.example.test" });
    expect((await admin.settings.nodeChannel()).webSocket).toMatchObject({
      open: true,
      closable: false,
    });
    // The current URL needs the entry.
    expect((await rpcError(admin.settings.closeNodeChannelWebSocket())).code).toBe(
      "NODE_CHANNEL_WEBSOCKET_REQUIRED",
    );
    await nodeAt("new.example.test", follower.cert).reportStatus({
      info: { supportedFeatures: [CHANNEL_FOLLOW_FEATURE] },
      channel: status("wss://ws.example.test", { fallback: { url: NEW } }),
    });
    await admin.settings.setNodeChannel({ url: NEW });
    expect((await admin.settings.nodeChannel()).webSocket).toEqual({
      open: true,
      closable: true,
      nodes: 1,
      probes: 0,
    });
    const busy = await rpcError(admin.settings.closeNodeChannelWebSocket());
    expect(busy.code).toBe("NODE_CHANNEL_WEBSOCKET_IN_USE");
    expect(busy.data).toEqual({ nodes: 1, probes: 0 });

    await nodeAt("new.example.test", follower.cert).reportStatus({
      info: { supportedFeatures: [CHANNEL_FOLLOW_FEATURE] },
      channel: status(NEW, { fallback: { url: "wss://ws.example.test" } }),
    });
    const closed = await admin.settings.closeNodeChannelWebSocket();
    expect(closed.webSocket).toEqual({ open: false, closable: false, nodes: 0, probes: 0 });
    expect(await nodeChannelWebSocketOpen(ctx)).toBe(false);
  });

  it("hands the URL to probes with channel-follow-v1 and records theirs", async () => {
    const regionId = (await admin.regions.create({ name: "East", code: "east" })).id;
    const token = await admin.probes.createToken({ name: "probe-1", regionId });
    const { csrPem, keyPem } = await keyAndCsr();
    const enrolled = await createClient(ProbeService, transport("new.example.test")).enrollProbe({
      token: token.token,
      csrPem,
      info: { hostname: "probe-host" },
    });
    const cert = { certificatePem: enrolled.certificatePem, keyPem };
    const probe = createClient(ProbeService, transport("new.example.test", cert));
    const legacy = await probe.getProbeTargets({ info: { hostname: "probe-host" } });
    expect(legacy.channel).toBeUndefined();
    const answer = await probe.getProbeTargets({
      info: { hostname: "probe-host", supportedFeatures: [CHANNEL_FOLLOW_FEATURE] },
      channel: status(NEW),
    });
    expect(answer.channel).toMatchObject({ url: NEW, serverName: "new.example.test" });
    expect(await probe.checkProbeChannel({})).toMatchObject({ probeId: enrolled.probeId });
    // Nodes check through NodeService.
    const nodeAsProbe = createClient(ProbeService, transport("new.example.test", follower.cert));
    const refused = await nodeAsProbe.checkProbeChannel({}).catch((error: unknown) => error);
    // A node certificate reaches ProbeService only while the node probes.
    expect(ConnectError.from(refused).code).toBe(Code.PermissionDenied);

    const [listed] = await listProbes(ctx.db);
    expect(listed?.channel).toMatchObject({ url: NEW, observedServerName: "new.example.test" });
    expect((await admin.settings.nodeChannel()).adoption).toMatchObject({
      probes: 1,
      probesCurrent: 1,
    });
  });
});
