import { updateHttps, uploadCertificate } from "../../src/server/services/certificates";
import "reflect-metadata";
import { webcrypto } from "node:crypto";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { siteCreateInput, tlsSettings } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { ApplyState, NodeService, PurgeType, TaskState, WatchEvent } from "@edgeweir/proto";
import * as x509 from "@peculiar/x509";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type NodeChannel, startNodeChannel } from "../../src/server/node-channel/server";
import { createCacheTask, getCacheTask } from "../../src/server/services/cache-tasks";
import { createClusterTx } from "../../src/server/services/clusters";
import { createEnrollmentToken } from "../../src/server/services/enrollment";
import { deleteNode, listNodes, setNodeStatus } from "../../src/server/services/nodes";
import { siteOriginHealth } from "../../src/server/services/origin-health";
import { latestRevision } from "../../src/server/services/revisions";
import { saveRules } from "../../src/server/services/rules";
import { createSite } from "../../src/server/services/sites";
import { createTestContext, seedOrganization } from "./helpers";

const actor = { type: "user" as const, id: "user_admin" };

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

describe("node channel", async () => {
  const { ctx, client: pglite } = await createTestContext();
  let channel: NodeChannel;
  let baseUrl: string;
  let clusterId: string;
  let organizationId: string;

  const anonymous = () =>
    createClient(
      NodeService,
      createConnectTransport({
        baseUrl,
        httpVersion: "2",
        nodeOptions: { ca: ctx.nodeCa.certificatePem, servername: "localhost" },
      }),
    );

  /** Enrolls a node of the default cluster and returns its mTLS client. */
  const enroll = async (nodeName: string) => {
    const token = await createEnrollmentToken(
      ctx.db,
      { clusterId, nodeName, ttlMinutes: 10 },
      {
        actor,
        consoleUrl: ctx.env.EDGEWEIR_PUBLIC_URL,
        serverUrl: ctx.env.nodeApiUrl,
        caSha256: ctx.nodeCa.fingerprintSha256,
      },
    );
    const { csrPem, keyPem } = await nodeKeyAndCsr();
    const enrolled = await anonymous().enroll({ token: token.token, csrPem });
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
  const demoSite = (name: string, origins: { address: string }[] = [{ address: "whoami" }]) =>
    createSite(ctx.db, siteCreateInput.parse({ name, domains: [`${name}.test`], origins }), {
      organizationId,
      actor,
      masterKey: ctx.masterKey,
    });

  beforeAll(async () => {
    ({ organizationId } = await seedOrganization(ctx.db));
    const cluster = await ctx.db.transaction((tx) =>
      createClusterTx(tx, { name: "default", description: "" }, actor),
    );
    clusterId = cluster.id;
    channel = await startNodeChannel(ctx);
    const address = channel.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `https://localhost:${address.port}`;
  });

  afterAll(async () => {
    await channel.close();
    await pglite.close();
  });

  it("enrolls with a one-time token, then requires mTLS for everything else", async () => {
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
    expect(token.installCommand).toContain(`--ca-sha256 ${ctx.nodeCa.fingerprintSha256}`);
    // The token is exported, then passed through sudo in the environment only.
    const [exportLine, curlLine] = token.installCommand.split("\n");
    expect(exportLine).toBe(`export EDGEWEIR_TOKEN='${token.token}'`);
    expect(curlLine).toContain("/install.sh | sudo --preserve-env=EDGEWEIR_TOKEN bash -s --");
    expect(curlLine).not.toContain(token.token);
    expect(curlLine).not.toContain("--token");

    // Only the hash is stored.
    const rows = await ctx.db.select().from(schema.enrollmentToken);
    expect(rows[0]?.tokenHash).not.toBe(token.token);
    expect(JSON.stringify(rows)).not.toContain(token.token);

    const { csrPem, keyPem } = await nodeKeyAndCsr();
    const enrolled = await anonymous().enroll({
      token: token.token,
      csrPem,
      info: { hostname: "edge-host", agentVersion: "test", ipAddresses: ["192.0.2.10"] },
    });
    expect(enrolled.nodeName).toBe("edge-1");
    expect(enrolled.caCertificatePem.trim()).toBe(ctx.nodeCa.certificatePem.trim());
    const cert = new x509.X509Certificate(enrolled.certificatePem);
    expect(cert.subject).toContain(`CN=${enrolled.nodeId}`);

    // Token reuse is rejected.
    const again = await nodeKeyAndCsr();
    await expect(
      anonymous().enroll({ token: token.token, csrPem: again.csrPem }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });

    // Without a client certificate every other RPC is refused.
    const err = await anonymous()
      .getConfig({})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe(Code.Unauthenticated);

    // With the issued certificate (mTLS) the node can talk to the console.
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
    const first = await mtls.getConfig({});
    expect(first.payload.case).toBe("snapshot");
    const snap = first.payload.case === "snapshot" ? first.payload.value : undefined;
    expect(snap?.revision).toBe(1n);
    expect(snap?.sites).toHaveLength(0);

    // Watch: first message is the latest revision.
    const abort = new AbortController();
    const stream = mtls.watchConfig({ knownRevision: 1n }, { signal: abort.signal });
    const iterator = stream[Symbol.asyncIterator]();
    const hello = await iterator.next();
    expect(hello.value?.event).toBe(WatchEvent.REVISION);
    expect(hello.value?.latestRevision).toBe(1n);

    // Creating a site publishes revision 2 and notifies the stream.
    const { site, revision } = await createSite(
      ctx.db,
      siteCreateInput.parse({
        name: "demo",
        domains: ["demo.test"],
        origins: [
          { address: "whoami", port: 80, scheme: "http", weight: 1, backup: false, hostHeader: "" },
        ],
        cacheRules: [
          {
            priority: 10,
            pathPrefixes: ["/"],
            extensions: [],
            action: "cache",
            edgeTtlSeconds: 60,
            originCacheControl: "override",
          },
        ],
      }),
      { organizationId, actor, masterKey: ctx.masterKey },
    );
    expect(revision.revision).toBe(2);
    ctx.events.emitLocal({ clusterId, revision: 2, contentHash: revision.contentHash });
    const notified = await iterator.next();
    expect(notified.value?.latestRevision).toBe(2n);
    expect(notified.value?.contentHash).toBe(revision.contentHash);
    abort.abort();

    // Diff from 1 to 2 contains exactly the new site.
    const diff = await mtls.getConfig({ baseRevision: 1n });
    expect(diff.payload.case).toBe("diff");
    if (diff.payload.case === "diff") {
      expect(diff.payload.value.upsertedSites.map((s) => s.id)).toEqual([site.id]);
      expect(diff.payload.value.upsertedSites[0]?.domains[0]?.name).toBe("demo.test");
      expect(diff.payload.value.contentHash).toBe(revision.contentHash);
    }

    // A node cannot poison the cluster's restore floor with an unissued revision.
    expect(diff.revisionReceipt).not.toBe("");
    await expect(
      mtls.reportStatus({
        appliedRevision: BigInt(Number.MAX_SAFE_INTEGER - 1),
        appliedContentHash: revision.contentHash,
        state: ApplyState.APPLIED,
        dataPlaneHealthy: true,
        revisionReceipt: diff.revisionReceipt,
      }),
    ).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect((await latestRevision(ctx.db, clusterId))?.revision).toBe(2);

    // Apply receipt makes the node online with its revision.
    const status = await mtls.reportStatus({
      appliedRevision: 2n,
      appliedContentHash: revision.contentHash,
      state: ApplyState.APPLIED,
      dataPlaneHealthy: true,
      info: { hostname: "edge-host", engine: "openresty", engineVersion: "1.31.1.1" },
    });
    expect(status.latestRevision).toBe(2n);
    expect(status.renewCertificate).toBe(false);
    const [node] = await listNodes(ctx.db, clusterId);
    expect(node).toMatchObject({
      online: true,
      appliedRevision: 2,
      applyState: "applied",
      appliedContentHash: revision.contentHash,
      engine: "openresty",
    });
    expect(node?.ipAddresses).toContain("192.0.2.10");

    // Certificate rotation supersedes the old certificate.
    const rotated = await nodeKeyAndCsr();
    const renewed = await mtls.renewCertificate({ csrPem: rotated.csrPem });
    expect(new x509.X509Certificate(renewed.certificatePem).subject).toContain(enrolled.nodeId);
    await expect(mtls.getConfig({})).rejects.toMatchObject({ code: Code.Unauthenticated });

    const audit = await ctx.db
      .select({ action: schema.auditLog.action })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, enrolled.nodeId));
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["node.enroll", "node.certificate_renew"]),
    );
    expect((await latestRevision(ctx.db, clusterId))?.revision).toBe(2);
  });

  it("refuses disabled nodes, ends their watch stream and revokes deleted nodes", async () => {
    const token = await createEnrollmentToken(
      ctx.db,
      { clusterId, nodeName: "edge-2", ttlMinutes: 10 },
      {
        actor,
        consoleUrl: ctx.env.EDGEWEIR_PUBLIC_URL,
        serverUrl: ctx.env.nodeApiUrl,
        caSha256: ctx.nodeCa.fingerprintSha256,
      },
    );
    const { csrPem, keyPem } = await nodeKeyAndCsr();
    const enrolled = await anonymous().enroll({ token: token.token, csrPem });
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
    const [row] = await ctx.db
      .select()
      .from(schema.node)
      .where(eq(schema.node.id, enrolled.nodeId));
    const [group] = await ctx.db
      .select()
      .from(schema.nodeGroup)
      .where(eq(schema.nodeGroup.clusterId, clusterId));
    // Enrolled nodes join the cluster's default node group.
    expect(row?.nodeGroupId).toBe(group?.id);

    // An open watch stream ends as soon as the node is disabled.
    const stream = mtls.watchConfig({ knownRevision: 0n });
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.event).toBe(WatchEvent.REVISION);
    await setNodeStatus(ctx.db, enrolled.nodeId, "disabled", actor);
    ctx.events.emitLocal({ clusterId, revision: 99, contentHash: "wake" });
    await expect(iterator.next()).rejects.toMatchObject({ code: Code.PermissionDenied });
    await expect(mtls.getConfig({})).rejects.toMatchObject({ code: Code.PermissionDenied });

    await setNodeStatus(ctx.db, enrolled.nodeId, "active", actor);
    expect((await mtls.getConfig({})).payload.case).toBe("snapshot");

    // Deleting revokes the certificate: the agent can no longer reconnect.
    await deleteNode(ctx.db, enrolled.nodeId, actor);
    const [revoked] = await ctx.db
      .select()
      .from(schema.nodeCertificateRevocation)
      .where(eq(schema.nodeCertificateRevocation.nodeId, enrolled.nodeId));
    expect(revoked?.fingerprintSha256).toBe(row?.certFingerprint);
    const refused = await mtls.getConfig({}).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConnectError);
    expect((refused as ConnectError).code).toBe(Code.Unauthenticated);
    expect((refused as ConnectError).rawMessage).toContain("revoked");
  });

  it("delivers origin credentials, typed tasks and origin health over mTLS", async () => {
    const token = await createEnrollmentToken(
      ctx.db,
      { clusterId, nodeName: "edge-3", ttlMinutes: 10 },
      {
        actor,
        consoleUrl: ctx.env.EDGEWEIR_PUBLIC_URL,
        serverUrl: ctx.env.nodeApiUrl,
        caSha256: ctx.nodeCa.fingerprintSha256,
      },
    );
    const { csrPem, keyPem } = await nodeKeyAndCsr();
    const enrolled = await anonymous().enroll({ token: token.token, csrPem });
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
    const s3Origin = (accessKeyId: string, secretAccessKey: string) => ({
      address: "minio",
      port: 9000,
      s3: { region: "us-east-1", bucket: "media", accessKeyId, secretAccessKey },
    });
    const own = await createSite(
      ctx.db,
      siteCreateInput.parse({
        name: "bucket-own",
        domains: ["own.bucket.test"],
        origins: [s3Origin("AKIDOWN", "own-secret"), { address: "backup", backup: true }],
      }),
      { organizationId, actor, masterKey: ctx.masterKey },
    );
    const otherCluster = await ctx.db.transaction((tx) =>
      createClusterTx(tx, { name: "other", description: "" }, actor),
    );
    const foreign = await createSite(
      ctx.db,
      siteCreateInput.parse({
        name: "bucket-foreign",
        clusterId: otherCluster.id,
        domains: ["foreign.bucket.test"],
        origins: [s3Origin("AKIDFOREIGN", "foreign-secret")],
      }),
      { organizationId, actor, masterKey: ctx.masterKey },
    );
    const credentialOf = async (siteId: string) =>
      (
        await ctx.db
          .select()
          .from(schema.originCredential)
          .where(eq(schema.originCredential.siteId, siteId))
      )[0]?.id ?? "";
    const ownId = await credentialOf(own.site.id);
    const foreignId = await credentialOf(foreign.site.id);

    // Only credentials of the node's own cluster are handed out.
    const creds = await mtls.getOriginCredentials({ ids: [ownId, foreignId, "not-a-uuid"] });
    expect(creds.credentials).toHaveLength(1);
    expect(creds.credentials[0]).toMatchObject({
      id: ownId,
      version: 1n,
      accessKeyId: "AKIDOWN",
      secretAccessKey: "own-secret",
    });

    // A new task wakes the watch stream with a TASKS event.
    const abort = new AbortController();
    const stream = mtls.watchConfig({ knownRevision: 0n }, { signal: abort.signal });
    const iterator = stream[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.event).toBe(WatchEvent.REVISION);
    const task = await createCacheTask(
      ctx.db,
      { type: "url", urls: ["http://own.bucket.test/a.png?x=1"], siteIds: [] },
      { scope: { all: true }, actor },
    );
    ctx.events.emitTasksLocal({ clusterIds: [clusterId] });
    expect((await iterator.next()).value?.event).toBe(WatchEvent.TASKS);
    abort.abort();

    const heartbeat = await mtls.reportStatus({ appliedRevision: 1n, state: ApplyState.APPLIED });
    expect(heartbeat.tasksPending).toBe(true);
    const pulled = await mtls.pullTasks({ maxTasks: 5 });
    expect(pulled.tasks).toHaveLength(1);
    const nodeTask = pulled.tasks[0];
    expect(nodeTask?.id).toBe(task.id);
    expect(nodeTask?.kind.case).toBe("purge");
    if (nodeTask?.kind.case === "purge") {
      expect(nodeTask.kind.value.targets).toEqual([
        expect.objectContaining({
          siteId: own.site.id,
          type: PurgeType.URL,
          host: "own.bucket.test",
          path: "/a.png",
          query: "x=1",
        }),
      ]);
    }
    expect((await mtls.pullTasks({})).tasks).toHaveLength(0);

    await mtls.reportTaskResult({
      taskId: task.id,
      state: TaskState.SUCCEEDED,
      succeeded: 1,
      finishedAt: timestampFromDate(new Date()),
    });
    const [delivery] = await ctx.db
      .select()
      .from(schema.cacheTaskNode)
      .where(eq(schema.cacheTaskNode.nodeId, enrolled.nodeId));
    expect(delivery).toMatchObject({ state: "succeeded", succeeded: 1 });
    await expect(
      mtls.reportTaskResult({ taskId: task.id, state: TaskState.UNSPECIFIED }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });

    // Origin health rides on the heartbeat.
    const primary = own.site.origins[0]?.id ?? "";
    const after = await mtls.reportStatus({
      appliedRevision: 1n,
      state: ApplyState.APPLIED,
      originHealth: [
        {
          siteId: own.site.id,
          originId: primary,
          healthy: false,
          consecutiveFailures: 3,
          lastError: "connect timeout",
          lastFailureAt: timestampFromDate(new Date()),
        },
      ],
    });
    expect(after.tasksPending).toBe(false);
    const health = await ctx.db
      .select()
      .from(schema.originHealth)
      .where(eq(schema.originHealth.nodeId, enrolled.nodeId));
    expect(health).toEqual([
      expect.objectContaining({ originId: primary, healthy: false, lastError: "connect timeout" }),
    ]);

    // Stats are summed per minute and site in one upsert; other clusters' sites are dropped.
    const bucketStart = Math.floor(Date.now() / 60000) * 60000 - 120000;
    const minute = timestampFromDate(new Date(bucketStart + 30000));
    expect((await mtls.reportStatsV2({})).batchSequence).toBe(0n);
    const stats = await mtls.reportStatsV2({
      batchSequence: 1n,
      stats: [
        { minute, siteId: own.site.id, requests: 2n, cacheHits: 1n, statusCodes: { 200: 2n } },
        { minute, siteId: own.site.id, requests: 3n, statusCodes: { 200: 1n, 404: 2n } },
        { minute, siteId: foreign.site.id, requests: 7n },
      ],
    });
    expect(stats.accepted).toBe(2);
    expect(
      (
        await mtls.reportStatsV2({
          batchSequence: 1n,
          stats: [{ minute, siteId: own.site.id, requests: 100n }],
        })
      ).accepted,
    ).toBe(0);
    await mtls.reportStatsV2({
      batchSequence: 2n,
      stats: [{ minute, siteId: own.site.id, requests: 1n }],
    });
    expect((await mtls.reportStatsV2({})).batchSequence).toBe(2n);
    // The statistics watermark rides on cursor queries: whole minutes, never backwards,
    // never more than a minute ahead of the console clock.
    const watermark = async () =>
      (
        await ctx.db
          .select({ at: schema.nodeStatsCursor.completeUntil })
          .from(schema.nodeStatsCursor)
          .where(eq(schema.nodeStatsCursor.nodeId, enrolled.nodeId))
      )[0]?.at;
    await mtls.reportStatsV2({ completeUntil: timestampFromDate(new Date(bucketStart + 60030)) });
    expect(await watermark()).toEqual(new Date(bucketStart + 60000));
    expect(
      (await mtls.reportStatsV2({ completeUntil: timestampFromDate(new Date(bucketStart)) }))
        .batchSequence,
    ).toBe(2n);
    expect(await watermark()).toEqual(new Date(bucketStart + 60000));
    await mtls.reportStatsV2({ completeUntil: timestampFromDate(new Date(Date.now() + 3600000)) });
    expect((await watermark())?.getTime()).toBeLessThanOrEqual(Date.now() + 60000);
    const counted = await ctx.db
      .select()
      .from(schema.nodeMinuteStats)
      .where(eq(schema.nodeMinuteStats.nodeId, enrolled.nodeId));
    expect(counted).toEqual([
      expect.objectContaining({
        minute: new Date(bucketStart),
        siteId: own.site.id,
        requests: 6,
        cacheHits: 1,
        statusCodes: { "200": 3, "404": 2 },
      }),
    ]);
  });

  it("stores the error codes nodes report and returns them with the text (CP-M9)", async () => {
    const { nodeId, mtls } = await enroll("edge-codes");
    const { site } = await demoSite("codes", [
      { address: "primary.test" },
      { address: "legacy.test" },
      { address: "odd.test" },
    ]);
    const [primary, legacy, odd] = site.origins.map((o) => o.id);
    const failedAt = timestampFromDate(new Date());
    await mtls.reportStatus({
      appliedRevision: 1n,
      state: ApplyState.APPLIED,
      originHealth: [
        {
          siteId: site.id,
          originId: primary,
          healthy: false,
          consecutiveFailures: 3,
          lastError: "HTTP 503",
          lastErrorCode: "upstream_status",
          lastErrorParams: { status: "503" },
          lastFailureAt: failedAt,
        },
        // A node before v0.2.1: text only, mapped to a code where that is unambiguous.
        {
          siteId: site.id,
          originId: legacy,
          healthy: false,
          consecutiveFailures: 3,
          lastError: "dns legacy.test: server failure",
          lastFailureAt: failedAt,
        },
        // Malformed codes and parameters are dropped, the text stays.
        {
          siteId: site.id,
          originId: odd,
          healthy: false,
          consecutiveFailures: 1,
          lastError: "timeout or HTTP 504",
          lastErrorCode: "Not A Code!",
          lastErrorParams: { "bad-key": "x", ok: "y".repeat(600) },
          lastFailureAt: failedAt,
        },
      ],
    });
    const [stored] = await ctx.db
      .select()
      .from(schema.originHealth)
      .where(eq(schema.originHealth.originId, primary ?? ""));
    expect(stored).toMatchObject({
      lastErrorCode: "upstream_status",
      lastErrorParams: { status: "503" },
    });
    const health = await siteOriginHealth(ctx.db, site.id, { all: true });
    const nodeOf = (originId: string | undefined) =>
      health.find((h) => h.originId === originId)?.nodes.find((n) => n.nodeId === nodeId);
    expect(health.find((h) => h.originId === primary)).toMatchObject({
      lastError: "HTTP 503",
      lastErrorCode: "upstream_status",
      lastErrorParams: { status: "503" },
    });
    expect(nodeOf(legacy)).toMatchObject({
      lastError: "dns legacy.test: server failure",
      lastErrorCode: "dns_failed",
      lastErrorParams: { host: "legacy.test" },
    });
    expect(nodeOf(odd)).toMatchObject({ lastError: "timeout or HTTP 504", lastErrorCode: "" });
    const [oddRow] = await ctx.db
      .select()
      .from(schema.originHealth)
      .where(eq(schema.originHealth.originId, odd ?? ""));
    expect(oddRow?.lastErrorParams).toEqual({ ok: "y".repeat(500) });

    // Task results carry a code and parameters next to the text.
    const purge = await createCacheTask(
      ctx.db,
      { type: "url", urls: ["http://codes.test/a"], siteIds: [] },
      { scope: { all: true }, actor },
    );
    const prefetch = await createCacheTask(
      ctx.db,
      { type: "prefetch", urls: ["http://codes.test/b", "http://codes.test/c"], siteIds: [] },
      { scope: { all: true }, actor },
    );
    const old = await createCacheTask(
      ctx.db,
      { type: "prefix", urls: ["http://codes.test/c/"], siteIds: [] },
      { scope: { all: true }, actor },
    );
    expect((await mtls.pullTasks({})).tasks.map((t) => t.id).sort()).toEqual(
      [purge.id, prefetch.id, old.id].sort(),
    );
    const finishedAt = timestampFromDate(new Date());
    await mtls.reportTaskResult({
      taskId: purge.id,
      state: TaskState.FAILED,
      failed: 1,
      message: "data plane unavailable, the purge applies when it recovers: x",
      errorCode: "purge_failed",
      finishedAt,
    });
    const params = {
      failed: "1",
      total: "2",
      url: "http://codes.test/c",
      reason: "status",
      status: "404",
    };
    await mtls.reportTaskResult({
      taskId: prefetch.id,
      state: TaskState.FAILED,
      succeeded: 1,
      failed: 1,
      message: "http://codes.test/c: HTTP 404",
      errorCode: "prefetch_failed",
      errorParams: params,
      finishedAt,
    });
    await mtls.reportTaskResult({
      taskId: old.id,
      state: TaskState.FAILED,
      message: "unsupported task type; upgrade edgeweir-node",
      finishedAt,
    });
    const nodeResult = async (taskId: string) =>
      (await getCacheTask(ctx.db, taskId, { all: true })).nodes.find((n) => n.nodeId === nodeId);
    expect(await nodeResult(purge.id)).toMatchObject({
      state: "failed",
      errorCode: "purge_failed",
      errorParams: {},
      message: "data plane unavailable, the purge applies when it recovers: x",
    });
    expect(await nodeResult(prefetch.id)).toMatchObject({
      errorCode: "prefetch_failed",
      errorParams: params,
      message: "http://codes.test/c: HTTP 404",
    });
    expect(await nodeResult(old.id)).toMatchObject({
      errorCode: "task_unsupported",
      errorParams: { type: "unknown" },
    });
  });

  it("hands a node back after more than 7 days a whole-site purge for expired purges (N-M4)", async () => {
    const { nodeId, mtls } = await enroll("edge-away");
    const { site } = await demoSite("away");
    const task = await createCacheTask(
      ctx.db,
      { type: "url", urls: ["http://away.test/a.js", "http://away.test/b.js"], siteIds: [] },
      { scope: { all: true }, actor },
    );
    await ctx.db
      .update(schema.cacheTask)
      .set({ createdAt: new Date(Date.now() - 8 * 24 * 3600 * 1000) })
      .where(eq(schema.cacheTask.id, task.id));

    const status = await mtls.reportStatus({ appliedRevision: 1n, state: ApplyState.APPLIED });
    expect(status.tasksPending).toBe(true);
    const pulled = await mtls.pullTasks({});
    expect(pulled.tasks).toHaveLength(1);
    const [recovery] = pulled.tasks;
    expect(recovery?.id).not.toBe(task.id);
    expect(recovery?.kind.case).toBe("purge");
    if (recovery?.kind.case === "purge") {
      expect(recovery.kind.value.targets).toEqual([
        expect.objectContaining({ siteId: site.id, type: PurgeType.SITE, host: "", path: "" }),
      ]);
    }
    await mtls.reportTaskResult({
      taskId: recovery?.id ?? "",
      state: TaskState.SUCCEEDED,
      succeeded: 1,
      finishedAt: timestampFromDate(new Date()),
    });
    // Once: nothing further, and the heartbeat stops asking the node to pull.
    expect((await mtls.pullTasks({})).tasks).toHaveLength(0);
    expect(
      (await mtls.reportStatus({ appliedRevision: 1n, state: ApplyState.APPLIED })).tasksPending,
    ).toBe(false);
    const original = await getCacheTask(ctx.db, task.id, { all: true });
    const mine = original.nodes.find((n) => n.nodeId === nodeId);
    expect(mine).toMatchObject({ state: "failed", errorCode: "task_expired" });
    expect(mine?.recoveredAt).not.toBeNull();
    const made = await getCacheTask(ctx.db, recovery?.id ?? "", { all: true });
    expect(made).toMatchObject({ source: "recovery", state: "succeeded", targets: ["away"] });
  });

  it("rejects unknown tokens", async () => {
    const { csrPem } = await nodeKeyAndCsr();
    await expect(anonymous().enroll({ token: "ewt_nope", csrPem })).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
  });
  it("withholds TLS revisions from old agents and gates certificate material with mTLS", async () => {
    const { mtls, nodeId } = await enroll("capability-test");
    const { site } = await demoSite("capability");
    const material = await ctx.nodeCa.issueServerCertificate(["capability.test"]);
    const certificateContext = { scope: { all: true as const }, actor, organizationId };
    const certificate = await uploadCertificate(
      ctx,
      {
        name: "capability",
        chainPem: material.certificatePem,
        privateKeyPem: material.privateKeyPem,
      },
      certificateContext,
    );
    await updateHttps(
      ctx,
      site.id,
      tlsSettings.parse({ certificateId: certificate.id }),
      certificateContext,
    );
    await expect(mtls.getConfig({})).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect((await listNodes(ctx.db, clusterId)).find((n) => n.id === nodeId)?.upgradeRequired).toBe(
      true,
    );
    await mtls.reportStatus({
      info: {
        agentVersion: "dev",
        supportedFeatures: ["tls-v1", "http01-v1", "http3-v1", "stats-sequence-v1"],
      },
    });
    expect((await mtls.getConfig({})).payload.case).toBe("snapshot");
    expect((await listNodes(ctx.db, clusterId)).find((n) => n.id === nodeId)?.upgradeRequired).toBe(
      false,
    );
    await expect(anonymous().getCertificates({ ids: [certificate.id] })).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    expect(
      (await mtls.getCertificates({ ids: [certificate.id] })).certificates[0]?.privateKeyPem,
    ).toBe(material.privateKeyPem);
  });
  it("withholds subdivision rules from nodes without a City MMDB", async () => {
    const { mtls, nodeId } = await enroll("subdivision-test");
    const agent = [
      "tls-v1",
      "http01-v1",
      "http3-v1",
      "rules-v1",
      "stats-sequence-v1",
      "access-logs-v1",
    ];
    const report = (geo: string[]) =>
      mtls.reportStatus({ info: { agentVersion: "dev", supportedFeatures: [...agent, ...geo] } });
    const upgradeRequired = async () =>
      (await listNodes(ctx.db, clusterId)).find((n) => n.id === nodeId)?.upgradeRequired;
    const platform = { scope: { all: true as const }, actor, organizationId: null };
    await saveRules(
      ctx,
      null,
      [
        {
          name: "subdivision",
          phase: "waf-custom",
          expression: 'ip.geoip.subdivision eq "AUK"',
          enabled: true,
          action: { kind: "log" },
        },
      ],
      platform,
    );
    // IPinfo Lite alone: country data (geoip-city-v1), no subdivisions.
    await report(["geoip-country-v1", "geoip-city-v1", "geoip-asn-v1"]);
    await expect(mtls.getConfig({})).rejects.toMatchObject({ code: Code.FailedPrecondition });
    expect(await upgradeRequired()).toBe(true);
    // Before geoip-country-v1, geoip-city-v1 always came from a City MMDB.
    await report(["geoip-city-v1"]);
    expect((await mtls.getConfig({})).payload.case).toBe("snapshot");
    await report(["geoip-country-v1", "geoip-city-v1", "geoip-subdivision-v1"]);
    expect((await mtls.getConfig({})).payload.case).toBe("snapshot");
    expect(await upgradeRequired()).toBe(false);
    await saveRules(ctx, null, [], platform);
  });
});
