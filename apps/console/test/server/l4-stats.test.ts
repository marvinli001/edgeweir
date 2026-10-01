import "reflect-metadata";
import { webcrypto } from "node:crypto";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { l4AppCreateInput, l4StatsInput, portPoolsInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { NodeService } from "@edgeweir/proto";
import * as x509 from "@peculiar/x509";
import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type NodeChannel, startNodeChannel } from "../../src/server/node-channel/server";
import { createClusterTx } from "../../src/server/services/clusters";
import { createEnrollmentToken } from "../../src/server/services/enrollment";
import {
  createL4App,
  deleteL4App,
  l4AppStats,
  l4StatsBucketSeconds,
  setPortPools,
} from "../../src/server/services/l4";
import { ingestL4MinuteStats } from "../../src/server/services/stats";
import { pruneTraffic } from "../../src/server/services/stats-rollup";
import { createTestContext, seedOperator } from "./helpers";

const actor = { type: "user" as const, id: "user_admin" };
const MINUTE = 60_000;

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

describe("layer-4 statistics", async () => {
  const { ctx, client: pglite } = await createTestContext();
  let channel: NodeChannel;
  let baseUrl = "";
  let clusterId = "";
  let nodeId = "";
  let appId = "";
  let foreignAppId = "";
  let mtls: ReturnType<typeof createClient<typeof NodeService>>;
  /** Two minutes ago, at the start of a minute. */
  const bucketStart = Math.floor(Date.now() / MINUTE) * MINUTE - 2 * MINUTE;

  const app = async (cluster: string, name: string, port: number) =>
    (
      await createL4App(
        ctx.db,
        l4AppCreateInput.parse({
          clusterId: cluster,
          name,
          protocol: "tcp",
          port,
          origins: [{ address: "origin.example.com", port: 22 }],
        }),
        actor,
      )
    ).app.id;
  const rows = () =>
    ctx.db
      .select()
      .from(schema.l4MinuteStats)
      .where(eq(schema.l4MinuteStats.appId, appId))
      .orderBy(asc(schema.l4MinuteStats.minute), asc(schema.l4MinuteStats.nodeId));

  beforeAll(async () => {
    await seedOperator(ctx.db);
    const cluster = await ctx.db.transaction((tx) =>
      createClusterTx(tx, { name: "default", description: "" }, actor),
    );
    clusterId = cluster.id;
    const other = await ctx.db.transaction((tx) =>
      createClusterTx(tx, { name: "other", description: "" }, actor),
    );
    for (const id of [clusterId, other.id])
      await setPortPools(
        ctx.db,
        portPoolsInput.parse({ clusterId: id, pools: [{ protocol: "tcp", from: 2000, to: 3000 }] }),
        actor,
      );
    appId = await app(clusterId, "ssh", 2222);
    foreignAppId = await app(other.id, "foreign", 2222);
    channel = await startNodeChannel(ctx);
    const address = channel.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `https://localhost:${address.port}`;
    const token = await createEnrollmentToken(
      ctx.db,
      { clusterId, nodeName: "edge-1", ttlMinutes: 10 },
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
    const enrolled = await anonymous.enroll({ token: token.token, csrPem });
    nodeId = enrolled.nodeId;
    mtls = createClient(
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
  });

  afterAll(async () => {
    await channel.close();
    await pglite.close();
  });

  it("ingests an application's minutes with the batch's sequence: a retried batch counts once", async () => {
    const minute = timestampFromDate(new Date(bucketStart + 10_000));
    const sameMinute = timestampFromDate(new Date(bucketStart + 50_000));
    const next = timestampFromDate(new Date(bucketStart + MINUTE));
    const stats = await mtls.reportStatsV2({
      batchSequence: 1n,
      l4Stats: [
        {
          minute,
          appId,
          connections: 2n,
          refused: 1n,
          peakConcurrent: 5n,
          bytesReceived: 100n,
          bytesSent: 200n,
        },
        {
          minute: sameMinute,
          appId: appId.toUpperCase(),
          connections: 3n,
          peakConcurrent: 7n,
          bytesReceived: 50n,
          bytesSent: 25n,
        },
        { minute: next, appId, connections: 1n, peakConcurrent: 2n, bytesSent: 10n },
        // Another cluster's application, unknown ids and minutes beyond retention are dropped.
        { minute, appId: foreignAppId, connections: 9n },
        { minute, appId: "00000000-0000-4000-8000-000000000000", connections: 9n },
        { minute, appId: "ssh", connections: 9n },
        {
          minute: timestampFromDate(new Date(bucketStart - 8 * 86_400_000)),
          appId,
          connections: 9n,
        },
        { appId, connections: 9n },
      ],
    });
    expect(stats).toMatchObject({ accepted: 3, batchSequence: 1n });
    const expected = [
      {
        minute: new Date(bucketStart),
        nodeId,
        appId,
        connections: 5,
        refused: 1,
        peakConcurrent: 7,
        bytesReceived: 150,
        bytesSent: 225,
      },
      {
        minute: new Date(bucketStart + MINUTE),
        nodeId,
        appId,
        connections: 1,
        refused: 0,
        peakConcurrent: 2,
        bytesReceived: 0,
        bytesSent: 10,
      },
    ];
    expect(await rows()).toEqual(expected);
    // The node retries the batch: acknowledged again, counted once.
    const retry = await mtls.reportStatsV2({
      batchSequence: 1n,
      l4Stats: [{ minute, appId, connections: 2n, peakConcurrent: 5n, bytesReceived: 100n }],
    });
    expect(retry).toMatchObject({ accepted: 0, batchSequence: 1n });
    expect(await rows()).toEqual(expected);
    // The next batch adds its counters; the peak stays the minute's highest.
    expect(
      await mtls.reportStatsV2({
        batchSequence: 2n,
        l4Stats: [{ minute, appId, connections: 4n, peakConcurrent: 6n, bytesSent: 5n }],
      }),
    ).toMatchObject({ accepted: 1, batchSequence: 2n });
    expect((await rows())[0]).toMatchObject({ connections: 9, peakConcurrent: 7, bytesSent: 230 });
    expect((await mtls.reportStatsV2({})).batchSequence).toBe(2n);
    // Layer-4 minutes need a sequence like site minutes.
    const unsequenced = await mtls
      .reportStatsV2({ l4Stats: [{ minute, appId, connections: 1n }] })
      .catch((error: unknown) => error);
    expect(unsequenced).toBeInstanceOf(ConnectError);
    expect((unsequenced as ConnectError).code).toBe(Code.FailedPrecondition);
    // Site and layer-4 buckets of one batch share the sequence.
    expect(
      await mtls.reportStatsV2({
        batchSequence: 3n,
        stats: [{ minute, siteId: "00000000-0000-4000-8000-000000000000", requests: 1n }],
        l4Stats: [{ minute, appId, connections: 1n }],
      }),
    ).toMatchObject({ accepted: 1, batchSequence: 3n });
    expect((await rows())[0]?.connections).toBe(10);
  });

  it("combines duplicate buckets of a report and drops counters JavaScript cannot hold", async () => {
    const node = { id: nodeId, clusterId };
    const minute = new Date(bucketStart + 5 * MINUTE);
    const bucket = {
      minute,
      appId,
      connections: 1,
      refused: 0,
      peakConcurrent: 3,
      bytesReceived: 0,
      bytesSent: 0,
    };
    expect(
      await ingestL4MinuteStats(ctx.db, node, [
        bucket,
        { ...bucket, peakConcurrent: 1 },
        { ...bucket, connections: Number.MAX_SAFE_INTEGER + 2 },
        { ...bucket, refused: -1 },
      ]),
    ).toBe(2);
    expect((await rows()).find((r) => r.minute.getTime() === minute.getTime())).toMatchObject({
      connections: 2,
      peakConcurrent: 3,
    });
    await ctx.db.delete(schema.l4MinuteStats).where(eq(schema.l4MinuteStats.minute, minute));
  });

  it("reports per-minute points, totals and the share of each node", async () => {
    // A second node of the cluster reported the first minute too.
    const [second] = await ctx.db
      .insert(schema.node)
      .values({ clusterId, name: "edge-2" })
      .returning();
    const secondId = second?.id ?? "";
    await ingestL4MinuteStats(ctx.db, { id: secondId, clusterId }, [
      {
        minute: new Date(bucketStart),
        appId,
        connections: 20,
        refused: 2,
        peakConcurrent: 4,
        bytesReceived: 1000,
        bytesSent: 2000,
      },
    ]);
    const from = new Date(bucketStart - 3 * MINUTE).toISOString();
    const to = new Date(bucketStart + 2 * MINUTE).toISOString();
    const stats = await l4AppStats(ctx.db, l4StatsInput.parse({ id: appId, from, to }));
    expect(stats).toMatchObject({ appId, from, to, bucketSeconds: 60 });
    expect(stats.points.map((p) => p.time)).toEqual(
      Array.from({ length: 5 }, (_, i) => new Date(bucketStart + (i - 3) * MINUTE).toISOString()),
    );
    expect(stats.points[3]).toEqual({
      time: new Date(bucketStart).toISOString(),
      connections: 30,
      refused: 3,
      // Peaks of nodes add up within a minute.
      peakConcurrent: 11,
      bytesReceived: 1150,
      bytesSent: 2230,
    });
    expect(stats.points[4]).toMatchObject({ connections: 1, peakConcurrent: 2, bytesSent: 10 });
    expect(stats.points[0]).toMatchObject({ connections: 0, peakConcurrent: 0 });
    expect(stats.totals).toEqual({
      connections: 31,
      refused: 3,
      peakConcurrent: 11,
      bytesReceived: 1150,
      bytesSent: 2240,
    });
    expect(stats.nodes).toEqual([
      {
        nodeId: secondId,
        nodeName: "edge-2",
        connections: 20,
        refused: 2,
        peakConcurrent: 4,
        bytesReceived: 1000,
        bytesSent: 2000,
      },
      {
        nodeId,
        nodeName: "edge-1",
        connections: 11,
        refused: 1,
        peakConcurrent: 7,
        bytesReceived: 150,
        bytesSent: 240,
      },
    ]);
    // Wider ranges use wider points, starting at the bucket of `from`.
    const day = await l4AppStats(
      ctx.db,
      l4StatsInput.parse({
        id: appId,
        from: new Date(bucketStart - 2 * 86_400_000).toISOString(),
        to: new Date(bucketStart + 2 * MINUTE).toISOString(),
      }),
    );
    expect(day.bucketSeconds).toBe(300);
    expect(day.totals.connections).toBe(31);
    const fiveMinutes = (time: number) => new Date(Math.floor(time / 300_000) * 300_000);
    const point = (time: number) =>
      day.points.find((p) => p.time === fiveMinutes(time).toISOString());
    // The two reported minutes share a point unless a five-minute boundary lies between them.
    const together =
      fiveMinutes(bucketStart).getTime() === fiveMinutes(bucketStart + MINUTE).getTime();
    expect(point(bucketStart)).toMatchObject({
      connections: together ? 31 : 30,
      peakConcurrent: 11,
    });
    expect(point(bucketStart + MINUTE)).toMatchObject({
      connections: together ? 31 : 1,
      peakConcurrent: together ? 11 : 2,
    });
    expect(l4StatsBucketSeconds(86_400_000)).toBe(60);
    expect(l4StatsBucketSeconds(5 * 86_400_000)).toBe(300);
    expect(l4StatsBucketSeconds(6 * 86_400_000)).toBe(3600);
    // The range must be ordered and at most 7 days long.
    for (const range of [
      { from: to, to: from },
      { from: to, to },
      { from: new Date(bucketStart - 8 * 86_400_000).toISOString(), to },
    ])
      expect(l4StatsInput.safeParse({ id: appId, ...range }).success).toBe(false);
    await ctx.db.delete(schema.node).where(eq(schema.node.id, secondId));
    // Rows of a deleted node keep counting; its name is gone.
    const orphaned = await l4AppStats(ctx.db, l4StatsInput.parse({ id: appId, from, to }));
    expect(orphaned.nodes.find((n) => n.nodeId === secondId)?.nodeName).toBe("");
  });

  it("keeps the minutes as long as site minutes and drops them with their application", async () => {
    const old = new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000 - 8 * 86_400_000);
    await ctx.db
      .insert(schema.l4MinuteStats)
      .values({ minute: old, nodeId, appId, connections: 1 });
    const before = (await rows()).length;
    await pruneTraffic(ctx.db);
    const after = await rows();
    expect(after).toHaveLength(before - 1);
    expect(after.some((r) => r.minute.getTime() === old.getTime())).toBe(false);
    await deleteL4App(ctx.db, appId, actor);
    expect(await rows()).toEqual([]);
  });
});
