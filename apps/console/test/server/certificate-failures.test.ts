import "reflect-metadata";
import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { schema } from "@edgeweir/db";
import { ApplyState, NodeService } from "@edgeweir/proto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type NodeChannel, startNodeChannel } from "../../src/server/node-channel/server";
import { toCertificateFailures } from "../../src/server/services/certificate-failures";
import { listCertificates } from "../../src/server/services/certificates";
import { createClusterTx } from "../../src/server/services/clusters";
import { createEnrollmentToken } from "../../src/server/services/enrollment";
import { deleteNode, listNodes } from "../../src/server/services/nodes";
import { createTestContext, seedOperator } from "./helpers";
import { nodeKeyAndCsr } from "./node-csr";

const actor = { type: "user" as const, id: "user_admin", name: "Admin" };
const FP = "a".repeat(64);
const EARLIER = "b".repeat(64);

// Nodes with certificate-isolation-v1 apply a revision without the
// certificates they cannot load and report them in ReportStatus: the console
// keeps them with the node's status, shows them on the node and the
// certificate, and fires certificate_unloadable while any node reports one.
describe("certificates nodes report they cannot load", async () => {
  const { ctx, client: pglite } = await createTestContext();
  let channel: NodeChannel;
  let baseUrl: string;
  let clusterId: string;
  let certificateId: string;

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
      info: {
        hostname: nodeName,
        agentVersion: "test",
        supportedFeatures: ["certificate-isolation-v1"],
      },
    });
    return {
      nodeId: enrolled.nodeId,
      mtls: createClient(
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
      ),
    };
  };
  const alerts = () =>
    ctx.db
      .select()
      .from(schema.alertEvent)
      .where(
        and(
          eq(schema.alertEvent.kind, "certificate_unloadable"),
          eq(schema.alertEvent.resourceId, certificateId),
        ),
      )
      .orderBy(schema.alertEvent.ordinal);

  beforeAll(async () => {
    await seedOperator(ctx.db);
    clusterId = (
      await ctx.db.transaction((tx) =>
        createClusterTx(tx, { name: "default", description: "" }, actor),
      )
    ).id;
    channel = await startNodeChannel(ctx);
    const address = channel.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `https://localhost:${address.port}`;
    certificateId = crypto.randomUUID();
    await ctx.db.insert(schema.certificate).values({
      id: certificateId,
      name: "explicit",
      names: ["explicit.test"],
      source: "upload",
      status: "ready",
      fingerprint: FP,
    });
  });

  afterAll(async () => {
    await channel.close();
    await pglite.close();
  });

  it("keeps only certificate ids, once each, known reasons and bounded messages", () => {
    const failures = toCertificateFailures([
      {
        certificateId: "not-an-id",
        sha256Fingerprint: FP,
        reason: "x",
        message: "",
        servingFingerprint: "",
      },
      {
        certificateId: certificateId.toUpperCase(),
        sha256Fingerprint: FP,
        reason: "invalid_material",
        message: `x509: unsupported\n${"e".repeat(400)}`,
        servingFingerprint: "nope",
      },
      {
        certificateId,
        sha256Fingerprint: FP,
        reason: "unavailable",
        message: "",
        servingFingerprint: "",
      },
      {
        certificateId: crypto.randomUUID(),
        sha256Fingerprint: "zz",
        reason: "something new",
        message: "m",
        servingFingerprint: EARLIER,
      },
    ] as never);
    expect(failures).toHaveLength(2);
    const own = failures.find((f) => f.certificateId === certificateId);
    expect(own).toMatchObject({
      fingerprint: FP,
      reason: "invalid_material",
      servingFingerprint: "",
    });
    expect(own?.message).toHaveLength(256);
    expect(own?.message).not.toContain("\n");
    expect(failures.find((f) => f.certificateId !== certificateId)).toMatchObject({
      fingerprint: "",
      reason: "invalid_material",
      servingFingerprint: EARLIER,
    });
  });

  it("stores a node's failures, shows them and alerts while any node reports one", async () => {
    const a = await enroll("edge-a");
    const b = await enroll("edge-b");
    const report = (failures: { serving?: string }[]) => ({
      appliedRevision: 0n,
      state: ApplyState.APPLIED,
      dataPlaneHealthy: true,
      certificateFailures: failures.map((f) => ({
        certificateId,
        sha256Fingerprint: FP,
        reason: "invalid_material",
        message: "tls: failed to parse private key",
        servingFingerprint: f.serving ?? "",
      })),
    });
    await a.mtls.reportStatus(report([{}]));
    await b.mtls.reportStatus(report([{ serving: EARLIER }]));
    const [row] = await ctx.db
      .select()
      .from(schema.nodeConfigStatus)
      .where(eq(schema.nodeConfigStatus.nodeId, a.nodeId));
    expect(row?.certificateFailures).toEqual([
      {
        certificateId,
        fingerprint: FP,
        reason: "invalid_material",
        message: "tls: failed to parse private key",
        servingFingerprint: "",
      },
    ]);
    const nodes = await listNodes(ctx.db);
    expect(nodes.find((n) => n.id === a.nodeId)?.certificateFailures).toEqual([
      {
        certificateId,
        certificateName: "explicit",
        reason: "invalid_material",
        servingEarlier: false,
      },
    ]);
    expect(nodes.find((n) => n.id === b.nodeId)?.certificateFailures[0]?.servingEarlier).toBe(true);
    const cert = (await listCertificates(ctx)).find((c) => c.id === certificateId);
    expect(cert?.nodeFailures).toEqual([
      { nodeId: a.nodeId, nodeName: "edge-a", reason: "invalid_material", servingEarlier: false },
      { nodeId: b.nodeId, nodeName: "edge-b", reason: "invalid_material", servingEarlier: true },
    ]);
    // One alert for the certificate, however many nodes report it; heartbeats
    // that repeat the same failures change nothing.
    await a.mtls.reportStatus(report([{}]));
    expect((await alerts()).map((e) => e.status)).toEqual(["firing"]);
    // Resolved once no node reports it.
    await a.mtls.reportStatus(report([]));
    expect((await alerts()).map((e) => e.status)).toEqual(["firing"]);
    await b.mtls.reportStatus(report([]));
    expect((await alerts()).map((e) => e.status)).toEqual(["firing", "resolved"]);
    expect((await listCertificates(ctx)).find((c) => c.id === certificateId)?.nodeFailures).toEqual(
      [],
    );
    // A deleted node's reports go with it: the alert resolves.
    await a.mtls.reportStatus(report([{}]));
    expect((await alerts()).map((e) => e.status)).toEqual(["firing", "resolved", "firing"]);
    await deleteNode(ctx.db, a.nodeId, actor);
    expect((await alerts()).map((e) => e.status)).toEqual([
      "firing",
      "resolved",
      "firing",
      "resolved",
    ]);
    // A node without the feature sends none: nothing is kept.
    const [status] = await ctx.db
      .select({ failures: schema.nodeConfigStatus.certificateFailures })
      .from(schema.nodeConfigStatus)
      .where(eq(schema.nodeConfigStatus.nodeId, b.nodeId));
    expect(status?.failures).toEqual([]);
  });
});
