import "reflect-metadata";
import { webcrypto } from "node:crypto";
import type { Http2SecureServer } from "node:http2";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { siteCreateInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { ApplyState, NodeService, PurgeType, TaskState, WatchEvent } from "@edgeweir/proto";
import * as x509 from "@peculiar/x509";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startNodeChannel } from "../../src/server/node-channel/server";
import { createCacheTask } from "../../src/server/services/cache-tasks";
import { createClusterTx } from "../../src/server/services/clusters";
import { createEnrollmentToken } from "../../src/server/services/enrollment";
import { deleteNode, listNodes, setNodeStatus } from "../../src/server/services/nodes";
import { latestRevision } from "../../src/server/services/revisions";
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
  let server: Http2SecureServer;
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

  beforeAll(async () => {
    ({ organizationId } = await seedOrganization(ctx.db));
    const cluster = await ctx.db.transaction((tx) =>
      createClusterTx(tx, { name: "default", description: "" }, actor),
    );
    clusterId = cluster.id;
    server = await startNodeChannel(ctx);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `https://localhost:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
    expect(token.installCommand).toContain("/install.sh | sudo bash -s --");

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
  });

  it("rejects unknown tokens", async () => {
    const { csrPem } = await nodeKeyAndCsr();
    await expect(anonymous().enroll({ token: "ewt_nope", csrPem })).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
  });
});
