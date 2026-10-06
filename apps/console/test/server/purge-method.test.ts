import "reflect-metadata";
import { webcrypto } from "node:crypto";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { siteCreateInput, siteUpdateInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { ApplyState, NodeService } from "@edgeweir/proto";
import * as x509 from "@peculiar/x509";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type NodeChannel, startNodeChannel } from "../../src/server/node-channel/server";
import {
  getCacheTask,
  listCacheTasks,
  PURGE_METHOD_TASKS_PER_MINUTE,
} from "../../src/server/services/cache-tasks";
import { createClusterTx } from "../../src/server/services/clusters";
import { createEnrollmentToken } from "../../src/server/services/enrollment";
import { getNode } from "../../src/server/services/nodes";
import { createSite, updateSite } from "../../src/server/services/sites";
import { createTestContext, seedOperator } from "./helpers";

const actor = { type: "user" as const, id: "user_admin" };
const KEY = "purge-key-0123456789abcdef";

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

describe("PURGE method and cache usage over the node channel", async () => {
  const { ctx, client: pglite } = await createTestContext();
  let channel: NodeChannel;
  let baseUrl: string;
  let clusterId: string;
  let otherClusterId: string;

  const enroll = async (nodeName: string, cluster: string) => {
    const token = await createEnrollmentToken(
      ctx.db,
      { clusterId: cluster, nodeName, ttlMinutes: 10 },
      {
        actor,
        consoleUrl: ctx.env.EDGEWEIR_PUBLIC_URL,
        serverUrl: ctx.env.nodeApiUrl,
        caSha256: ctx.nodeCa.fingerprintSha256,
      },
    );
    const { csrPem, keyPem } = await nodeKeyAndCsr();
    const anonymous = createClient(
      NodeService,
      createConnectTransport({
        baseUrl,
        httpVersion: "2",
        nodeOptions: { ca: ctx.nodeCa.certificatePem, servername: "localhost" },
      }),
    );
    const enrolled = await anonymous.enroll({
      token: token.token,
      csrPem,
      info: { supportedFeatures: ["tls-v1", "site-content-v1", "cache-zone-v1"] },
    });
    const mtls = createClient(
      NodeService,
      createConnectTransport({
        baseUrl,
        httpVersion: "2",
        nodeOptions: {
          ca: enrolled.caCertificatePem,
          cert: enrolled.certificatePem,
          key: keyPem,
          servername: "localhost",
        },
      }),
    );
    return { nodeId: enrolled.nodeId, mtls };
  };
  const site = async (name: string, cluster: string) =>
    (
      await createSite(
        ctx.db,
        siteCreateInput.parse({
          name,
          clusterId: cluster,
          domains: [`${name}.test`, `*.${name}.test`],
          origins: [{ address: "whoami" }],
        }),
        { actor, masterKey: ctx.masterKey },
      )
    ).site;
  const purgeOn = (id: string, key = KEY) =>
    updateSite(
      ctx.db,
      siteUpdateInput.parse({ id, cacheSettings: { purgeMethod: { enabled: true, key } } }),
      { actor, masterKey: ctx.masterKey },
    );
  const code = (error: unknown) => ConnectError.from(error).code;

  beforeAll(async () => {
    await seedOperator(ctx.db);
    clusterId = (
      await ctx.db.transaction((tx) =>
        createClusterTx(tx, { name: "default", description: "" }, actor),
      )
    ).id;
    otherClusterId = (
      await ctx.db.transaction((tx) =>
        createClusterTx(tx, { name: "other", description: "" }, actor),
      )
    ).id;
    channel = await startNodeChannel(ctx);
    const address = channel.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `https://localhost:${address.port}`;
  });

  afterAll(async () => {
    await channel.close();
    await pglite.close();
  });

  it("hands the cluster's PURGE keys out like origin credentials, never another cluster's", async () => {
    const { mtls } = await enroll("edge-keys", clusterId);
    const own = await site("keys", clusterId);
    const foreign = await site("foreign-keys", otherClusterId);
    await purgeOn(own.id);
    await purgeOn(foreign.id, `${KEY}-other`);
    const secrets = await ctx.db.select().from(schema.siteSecret);
    const ownId = secrets.find((s) => s.siteId === own.id)?.id ?? "";
    const foreignId = secrets.find((s) => s.siteId === foreign.id)?.id ?? "";
    const creds = await mtls.getOriginCredentials({ ids: [ownId, foreignId] });
    expect(creds.credentials).toHaveLength(1);
    expect(creds.credentials[0]).toMatchObject({
      id: ownId,
      version: 1n,
      accessKeyId: "",
      secretAccessKey: KEY,
    });
  });

  it("creates a URL purge of the cluster for an accepted PURGE request", async () => {
    const { nodeId, mtls } = await enroll("edge-purge", clusterId);
    await enroll("edge-peer", clusterId);
    const shop = await site("shop", clusterId);
    // The method is off: refused.
    await expect(
      mtls.submitPurge({ siteId: shop.id, url: "https://shop.test/a.css" }),
    ).rejects.toSatisfy((e) => code(e) === Code.PermissionDenied);
    await purgeOn(shop.id);
    const { taskId } = await mtls.submitPurge({
      siteId: shop.id,
      url: "https://a.shop.test/a.css?v=1",
    });
    const task = await getCacheTask(ctx.db, taskId);
    expect(task).toMatchObject({
      type: "url",
      targets: ["https://a.shop.test/a.css?v=1"],
      sites: [{ id: shop.id, name: "shop" }],
      source: "purge_method",
      createdByName: "edge-purge",
    });
    // Every node of the cluster gets it, the submitting one included.
    expect(task.nodes.map((n) => n.nodeName).sort()).toEqual(
      expect.arrayContaining(["edge-peer", "edge-purge"]),
    );
    expect((await listCacheTasks(ctx.db, { siteId: shop.id, page: 1, pageSize: 10 })).total).toBe(
      1,
    );
    const [audit] = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, taskId));
    expect(audit).toMatchObject({
      action: "cache.purge",
      actorType: "node",
      actorId: nodeId,
      actorName: "edge-purge",
    });
    expect(audit?.metadata).toMatchObject({ type: "url", method: "PURGE" });
  });

  it("refuses URLs of other sites, sites of other clusters, disabled sites and bad input", async () => {
    const { mtls } = await enroll("edge-refuse", clusterId);
    const mine = await site("mine", clusterId);
    const neighbour = await site("neighbour", clusterId);
    const remote = await site("remote", otherClusterId);
    await purgeOn(mine.id);
    await purgeOn(remote.id);
    for (const [url, siteId, want] of [
      ["https://neighbour.test/x", mine.id, Code.InvalidArgument],
      ["https://unknown.test/x", mine.id, Code.InvalidArgument],
      ["ftp://mine.test/x", mine.id, Code.InvalidArgument],
      [`https://mine.test/${"a".repeat(2048)}`, mine.id, Code.InvalidArgument],
      ["https://remote.test/x", remote.id, Code.PermissionDenied],
      ["https://neighbour.test/x", neighbour.id, Code.PermissionDenied],
      ["https://mine.test/x", "not-a-site", Code.InvalidArgument],
    ] as const)
      await expect(mtls.submitPurge({ siteId, url }), url).rejects.toSatisfy(
        (e) => code(e) === want,
      );
    await ctx.db.update(schema.site).set({ enabled: false }).where(eq(schema.site.id, mine.id));
    await expect(
      mtls.submitPurge({ siteId: mine.id, url: "https://mine.test/x" }),
    ).rejects.toSatisfy((e) => code(e) === Code.PermissionDenied);
  });

  it("limits PURGE tasks per site and minute and says when to retry", async () => {
    const { mtls } = await enroll("edge-rate", clusterId);
    const busy = await site("busy", clusterId);
    await purgeOn(busy.id);
    const now = Date.now();
    await ctx.db.insert(schema.cacheTask).values(
      Array.from({ length: PURGE_METHOD_TASKS_PER_MINUTE }, (_, i) => ({
        type: "url",
        targets: [`https://busy.test/${i}`],
        siteIds: [busy.id],
        source: "purge_method",
        createdAt: new Date(now - 30_000 + i),
      })),
    );
    const error = await mtls
      .submitPurge({ siteId: busy.id, url: "https://busy.test/x" })
      .catch((e) => e);
    expect(code(error)).toBe(Code.ResourceExhausted);
    expect(ConnectError.from(error).rawMessage).toMatch(/^retry after (2[0-9]|3[01])$/);
    // Tasks of other sources do not count.
    const calm = await site("calm", clusterId);
    await purgeOn(calm.id);
    expect(
      (await mtls.submitPurge({ siteId: calm.id, url: "https://calm.test/x" })).taskId,
    ).toBeTruthy();
  });

  it("stores the cache usage nodes report and keeps it until the next measurement", async () => {
    const { nodeId, mtls } = await enroll("edge-usage", clusterId);
    const report = (usage: { usedBytes: bigint; maxBytes: bigint }[]) =>
      mtls.reportStatus({
        appliedRevision: 0n,
        state: ApplyState.APPLYING,
        dataPlaneHealthy: true,
        cacheUsage: usage.map((u) => ({
          name: "default",
          ...u,
          measuredAt: timestampFromDate(new Date("2026-10-07T10:00:00Z")),
        })),
      });
    await report([{ usedBytes: 123_456_789n, maxBytes: 10_737_418_240n }]);
    expect((await getNode(ctx.db, nodeId)).cache).toEqual({
      maxSizeGb: null,
      usage: {
        usedBytes: 123_456_789,
        maxBytes: 10_737_418_240,
        measuredAt: "2026-10-07T10:00:00.000Z",
      },
    });
    // A heartbeat before the next measurement carries none: the last one stays.
    await report([]);
    expect((await getNode(ctx.db, nodeId)).cache.usage?.usedBytes).toBe(123_456_789);
  });
});
