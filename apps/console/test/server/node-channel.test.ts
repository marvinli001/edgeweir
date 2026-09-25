import "reflect-metadata";
import { webcrypto } from "node:crypto";
import type { Http2SecureServer } from "node:http2";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { schema } from "@edgeweir/db";
import { ApplyState, NodeService, WatchEvent } from "@edgeweir/proto";
import * as x509 from "@peculiar/x509";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startNodeChannel } from "../../src/server/node-channel/server";
import { createClusterTx } from "../../src/server/services/clusters";
import { createEnrollmentToken } from "../../src/server/services/enrollment";
import { listNodes } from "../../src/server/services/nodes";
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
      {
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
      },
      { organizationId, actor },
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

  it("rejects unknown tokens", async () => {
    const { csrPem } = await nodeKeyAndCsr();
    await expect(anonymous().enroll({ token: "ewt_nope", csrPem })).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
  });
});
