import "reflect-metadata";
import { webcrypto } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { Code, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { encodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import {
  ApplyState,
  ListenerProtocol,
  ListenerSchema,
  NodeConfigSchema,
  NodeService,
  ProbeMethod,
  ProbeService,
} from "@edgeweir/proto";
import * as x509 from "@peculiar/x509";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type NodeChannel, startNodeChannel } from "../../src/server/node-channel/server";
import { createClusterTx } from "../../src/server/services/clusters";
import { createEnrollmentToken } from "../../src/server/services/enrollment";
import { getNode, setNodeAddresses, setNodeProbe } from "../../src/server/services/nodes";
import {
  createProbeToken,
  deleteProbe,
  hashProbeToken,
  listProbeResults,
  listProbes,
  updateProbe,
} from "../../src/server/services/probes";
import { latestRevision } from "../../src/server/services/revisions";
import { createTestContext, seedOperator } from "./helpers";

const actor = { type: "user" as const, id: "user_admin" };

async function keyAndCsr() {
  const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const keys = (await webcrypto.subtle.generateKey(alg, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: "CN=probe-host",
    keys: keys as never,
    signingAlgorithm: alg,
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey));
  const keyPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString("base64")}\n-----END PRIVATE KEY-----\n`;
  return { csrPem: csr.toString("pem"), keyPem };
}

describe("probe channel", async () => {
  const { ctx, client: pglite } = await createTestContext();
  let channel: NodeChannel;
  let baseUrl = "";
  let clusterId = "";
  let regionId = "";
  let regionGroup = "";
  let plainGroup = "";
  const reports: string[][] = [];

  const transport = (cert?: { certificatePem: string; keyPem: string }) =>
    createConnectTransport({
      baseUrl,
      httpVersion: "2",
      nodeOptions: {
        ca: ctx.nodeCa.certificatePem,
        servername: "localhost",
        ...(cert ? { cert: cert.certificatePem, key: cert.keyPem } : {}),
      },
    });
  const probeClient = (cert?: { certificatePem: string; keyPem: string }) =>
    createClient(ProbeService, transport(cert));
  const nodeClient = (cert?: { certificatePem: string; keyPem: string }) =>
    createClient(NodeService, transport(cert));
  const tokenFor = (name: string, ttlMinutes = 60) =>
    createProbeToken(
      ctx.db,
      { name, regionId, ttlMinutes },
      { actor, serverUrl: ctx.env.nodeApiUrl, caSha256: ctx.nodeCa.fingerprintSha256 },
    );
  const enrollProbe = async (name: string) => {
    const token = await tokenFor(name);
    const { csrPem, keyPem } = await keyAndCsr();
    const enrolled = await probeClient().enrollProbe({
      token: token.token,
      csrPem,
      info: { hostname: `${name}-host`, agentVersion: "0.14.0", os: "linux", arch: "amd64" },
    });
    const cert = { certificatePem: enrolled.certificatePem, keyPem };
    return { id: enrolled.probeId, cert, client: probeClient(cert), enrolled };
  };
  const enrollNode = async (nodeName: string, nodeGroupId: string) => {
    const token = await createEnrollmentToken(
      ctx.db,
      { clusterId, nodeGroupId, nodeName, ttlMinutes: 10 },
      {
        actor,
        consoleUrl: ctx.env.EDGEWEIR_PUBLIC_URL,
        serverUrl: ctx.env.nodeApiUrl,
        caSha256: ctx.nodeCa.fingerprintSha256,
      },
    );
    const { csrPem, keyPem } = await keyAndCsr();
    const enrolled = await nodeClient().enroll({ token: token.token, csrPem });
    const cert = { certificatePem: enrolled.certificatePem, keyPem };
    return { id: enrolled.nodeId, cert, node: nodeClient(cert), probe: probeClient(cert) };
  };

  beforeAll(async () => {
    await seedOperator(ctx.db);
    clusterId = (
      await ctx.db.transaction((tx) =>
        createClusterTx(tx, { name: "default", description: "" }, actor),
      )
    ).id;
    const [region] = await ctx.db
      .insert(schema.region)
      .values({ name: "East", code: "east" })
      .returning();
    regionId = region?.id ?? "";
    plainGroup =
      (
        await ctx.db
          .select()
          .from(schema.nodeGroup)
          .where(eq(schema.nodeGroup.clusterId, clusterId))
      )[0]?.id ?? "";
    const [group] = await ctx.db
      .insert(schema.nodeGroup)
      .values({ clusterId, name: "east", regionId })
      .returning();
    regionGroup = group?.id ?? "";
    channel = await startNodeChannel(ctx, {
      probes: {
        afterReport: async (clusterIds) => {
          reports.push([...clusterIds]);
        },
      },
    });
    const address = channel.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `https://localhost:${address.port}`;
  });

  afterAll(async () => {
    await channel.close();
    await pglite.close();
  });

  it("enrolls a probe once with a hash-only token: CN=<probe id>, O=Edgeweir Probe, client auth", async () => {
    const token = await tokenFor("east-1");
    expect(token.token).toMatch(/^ewp_[A-Za-z0-9_-]{43}$/);
    expect(token.serverUrl).toBe(ctx.env.nodeApiUrl);
    expect(token.caSha256).toBe(ctx.nodeCa.fingerprintSha256);
    const [exportLine, run] = token.command.split("\n");
    expect(exportLine).toBe(`export EDGEWEIR_TOKEN='${token.token}'`);
    expect(run).toContain("-e EDGEWEIR_TOKEN ");
    expect(run).not.toContain(token.token);
    expect(run).toContain(`-e EDGEWEIR_SERVER=${ctx.env.nodeApiUrl}`);
    expect(run).toContain(`-e EDGEWEIR_CA_SHA256=${ctx.nodeCa.fingerprintSha256}`);
    expect(run).toMatch(/edgeweir-node:\S+ probe$/);
    const [row] = await ctx.db
      .select()
      .from(schema.probeToken)
      .where(eq(schema.probeToken.id, token.tokenId));
    expect(row?.tokenHash).toBe(hashProbeToken(token.token));
    expect(row?.tokenPrefix).toBe(token.token.slice(0, 10));
    expect(JSON.stringify(await ctx.db.select().from(schema.probeToken))).not.toContain(
      token.token,
    );
    const audit = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "probe.token_create"));
    expect(JSON.stringify(audit)).not.toContain(token.token);

    const { csrPem, keyPem } = await keyAndCsr();
    const enrolled = await probeClient().enrollProbe({
      token: token.token,
      csrPem,
      info: { hostname: "probe-host", agentVersion: "0.14.0", os: "linux", arch: "arm64" },
    });
    expect(enrolled).toMatchObject({ probeName: "east-1", regionId });
    expect(enrolled.caCertificatePem.trim()).toBe(ctx.nodeCa.certificatePem.trim());
    const cert = new x509.X509Certificate(enrolled.certificatePem);
    expect(cert.subject).toBe(`CN=${enrolled.probeId}, O=Edgeweir Probe`);
    const eku = cert.getExtension(x509.ExtendedKeyUsageExtension);
    expect(eku?.usages).toEqual([x509.ExtendedKeyUsage.clientAuth]);
    const [probe] = await ctx.db
      .select()
      .from(schema.probe)
      .where(eq(schema.probe.id, enrolled.probeId));
    expect(probe).toMatchObject({
      name: "east-1",
      regionId,
      hostname: "probe-host",
      agentVersion: "0.14.0",
      arch: "arm64",
      certSerial: cert.serialNumber,
    });
    const [used] = await ctx.db
      .select()
      .from(schema.probeToken)
      .where(eq(schema.probeToken.id, token.tokenId));
    expect(used?.usedByProbeId).toBe(enrolled.probeId);
    const [entry] = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "probe.enroll"));
    expect(entry).toMatchObject({ actorType: "probe", actorId: enrolled.probeId });

    // Single use.
    const again = await keyAndCsr();
    await expect(
      probeClient().enrollProbe({ token: token.token, csrPem: again.csrPem }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    // Expired.
    const late = await tokenFor("late");
    await ctx.db
      .update(schema.probeToken)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.probeToken.id, late.tokenId));
    await expect(
      probeClient().enrollProbe({ token: late.token, csrPem: again.csrPem }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    // A node enrollment token is not a probe token, and vice versa.
    await expect(
      nodeClient().enroll({ token: (await tokenFor("swap")).token, csrPem: again.csrPem }),
    ).rejects.toMatchObject({ code: Code.PermissionDenied });
    // Everything else needs the certificate.
    await expect(probeClient().getProbeTargets({})).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    const mtls = probeClient({ certificatePem: enrolled.certificatePem, keyPem });
    const targets = await mtls.getProbeTargets({ info: { hostname: "probe-host-2" } });
    expect(targets).toMatchObject({ intervalSeconds: 10, timeoutMs: 3000, attempts: 3 });
    expect(targets.renewCertificate).toBe(false);
    expect((await listProbes(ctx.db)).find((p) => p.id === enrolled.probeId)).toMatchObject({
      online: true,
      hostname: "probe-host-2",
      regionName: "East",
    });
  });

  it("keeps node and probe certificates apart in both directions", async () => {
    const probe = await enrollProbe("apart");
    // A probe certificate never reaches NodeService.
    for (const call of [
      () => nodeClient(probe.cert).getConfig({}),
      () => nodeClient(probe.cert).reportStatus({ appliedRevision: 1n }),
      () => nodeClient(probe.cert).renewCertificate({ csrPem: "x" }),
    ])
      await expect(call()).rejects.toMatchObject({ code: Code.Unauthenticated });

    // A node certificate reaches ProbeService only for a node that probes from a region.
    const node = await enrollNode("prober", plainGroup);
    await expect(node.probe.getProbeTargets({})).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
    await expect(setNodeProbe(ctx.db, { id: node.id, enabled: true }, actor)).rejects.toMatchObject(
      { code: "NODE_REGION_REQUIRED" },
    );
    let status = await node.node.reportStatus({ appliedRevision: 1n, state: ApplyState.APPLIED });
    expect(status.probe).toBe(false);
    await ctx.db
      .update(schema.node)
      .set({ nodeGroupId: regionGroup })
      .where(eq(schema.node.id, node.id));
    expect((await setNodeProbe(ctx.db, { id: node.id, enabled: true }, actor)).probeEnabled).toBe(
      true,
    );
    status = await node.node.reportStatus({ appliedRevision: 1n, state: ApplyState.APPLIED });
    expect(status.probe).toBe(true);
    const targets = await node.probe.getProbeTargets({});
    expect(targets.renewCertificate).toBe(false);
    // Nodes renew through NodeService only.
    await expect(node.probe.renewProbeCertificate({ csrPem: "x" })).rejects.toMatchObject({
      code: Code.FailedPrecondition,
    });
    // Without a region (the group lost it) the node stops probing.
    await ctx.db
      .update(schema.nodeGroup)
      .set({ regionId: null })
      .where(eq(schema.nodeGroup.id, regionGroup));
    await expect(node.probe.getProbeTargets({})).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
    status = await node.node.reportStatus({ appliedRevision: 1n, state: ApplyState.APPLIED });
    expect(status.probe).toBe(false);
    await ctx.db
      .update(schema.nodeGroup)
      .set({ regionId })
      .where(eq(schema.nodeGroup.id, regionGroup));
    // Turning it off refuses it again and drops its results.
    await ctx.db.insert(schema.probeResult).values({
      proberKind: "node",
      proberId: node.id,
      regionId,
      nodeId: node.id,
      address: "8.8.8.8",
      port: 80,
      method: "tcp",
      sent: 3,
      lost: 0,
      checkedAt: new Date(),
    });
    await setNodeProbe(ctx.db, { id: node.id, enabled: false }, actor);
    expect(
      await ctx.db
        .select()
        .from(schema.probeResult)
        .where(eq(schema.probeResult.proberId, node.id)),
    ).toEqual([]);
    await expect(node.probe.getProbeTargets({})).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
    const audit = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "node.set_probe"));
    expect(audit.map((a) => a.metadata)).toEqual([
      { from: false, to: true },
      { from: true, to: false },
    ]);
  });

  it("renews a probe certificate, refuses a disabled probe and revokes a deleted one", async () => {
    const probe = await enrollProbe("cycle");
    await updateProbe(ctx.db, { id: probe.id, enabled: false }, actor);
    await expect(probe.client.getProbeTargets({})).rejects.toMatchObject({
      code: Code.PermissionDenied,
    });
    // Renewal still works while disabled; the old certificate stays until the new one is used.
    const next = await keyAndCsr();
    const renewed = await probe.client.renewProbeCertificate({ csrPem: next.csrPem });
    const fresh = probeClient({ certificatePem: renewed.certificatePem, keyPem: next.keyPem });
    expect(new x509.X509Certificate(renewed.certificatePem).subject).toBe(
      `CN=${probe.id}, O=Edgeweir Probe`,
    );
    await updateProbe(ctx.db, { id: probe.id, enabled: true }, actor);
    await probe.client.getProbeTargets({});
    await fresh.getProbeTargets({});
    await expect(probe.client.getProbeTargets({})).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    const [renewal] = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "probe.certificate_renew"));
    expect(renewal?.actorType).toBe("probe");
    // Deleting revokes it.
    await deleteProbe(ctx.db, probe.id, actor);
    await expect(fresh.getProbeTargets({})).rejects.toMatchObject({
      code: Code.Unauthenticated,
    });
    const [revoked] = await ctx.db
      .select()
      .from(schema.nodeCertificateRevocation)
      .where(eq(schema.nodeCertificateRevocation.nodeId, probe.id));
    expect(revoked?.reason).toBe("probe deleted");
  });

  it("hands out scheduling addresses × listener ports, TCP until every node has probe-health-v1", async () => {
    const probe = await enrollProbe("targets");
    const own = await enrollNode("own", regionGroup);
    const reported = await enrollNode("reported", regionGroup);
    const configured = await enrollNode("configured", plainGroup);
    const disabled = await enrollNode("disabled", plainGroup);
    await ctx.db
      .update(schema.node)
      .set({ status: "disabled" })
      .where(eq(schema.node.id, disabled.id));
    const ips = async (nodeId: string, addresses: string[]) =>
      ctx.db.insert(schema.nodeIp).values(addresses.map((address) => ({ nodeId, address })));
    await ips(own.id, ["8.8.0.1"]);
    // Reported: only public ones.
    await ips(reported.id, ["8.8.0.2", "10.0.0.2", "fe80::2"]);
    await ips(configured.id, ["8.8.0.3"]);
    await ips(disabled.id, ["8.8.0.4"]);
    // Configured addresses (private ranges allowed) replace the reported ones.
    await setNodeAddresses(
      ctx.db,
      {
        id: configured.id,
        addresses: [
          { address: "172.28.0.3", level: 0 },
          { address: "172.29.0.3", level: 1 },
        ],
      },
      actor,
    );
    // A configuration with HTTP, HTTPS and an HTTPS listener behind PROXY protocol.
    const latest = await latestRevision(ctx.db, clusterId);
    if (!latest) throw new Error("revision missing");
    const config = create(NodeConfigSchema, {
      revision: BigInt(latest.revision + 1),
      listeners: [
        create(ListenerSchema, { port: 80, protocol: ListenerProtocol.HTTP }),
        create(ListenerSchema, { port: 443, protocol: ListenerProtocol.HTTPS }),
        create(ListenerSchema, {
          port: 8443,
          protocol: ListenerProtocol.HTTPS,
          proxyProtocol: true,
        }),
      ],
    });
    await ctx.db.insert(schema.configRevision).values({
      clusterId,
      revision: latest.revision + 1,
      contentHash: "listeners",
      ir: encodeNodeConfig(config),
    });
    const ofNodes = <T extends { nodeId: string }>(targets: T[]) =>
      targets.filter((t) => [own.id, reported.id, configured.id, disabled.id].includes(t.nodeId));
    const ports = [80, 443, 8443];
    const expected = (method: (port: number) => ProbeMethod, nodes = [own, reported, configured]) =>
      [
        ...nodes.flatMap((n) =>
          (n === own
            ? ["8.8.0.1"]
            : n === reported
              ? ["8.8.0.2"]
              : ["172.28.0.3", "172.29.0.3"]
          ).flatMap((address) =>
            ports.map((port) => ({
              nodeId: n.id,
              address,
              port,
              method: method(port),
              proxyProtocol: port === 8443,
            })),
          ),
        ),
      ].sort((a, b) =>
        a.nodeId !== b.nodeId
          ? a.nodeId < b.nodeId
            ? -1
            : 1
          : a.address !== b.address
            ? a.address < b.address
              ? -1
              : 1
            : a.port - b.port,
      );
    const strip = (
      targets: {
        nodeId: string;
        address: string;
        port: number;
        method: ProbeMethod;
        proxyProtocol: boolean;
      }[],
    ) =>
      targets.map(({ nodeId, address, port, method, proxyProtocol }) => ({
        nodeId,
        address,
        port,
        method,
        proxyProtocol,
      }));
    let response = await probe.client.getProbeTargets({});
    expect(strip(ofNodes(response.targets))).toEqual(expected(() => ProbeMethod.TCP));
    // Sorted by node, address, port overall.
    const keys = response.targets.map(
      (t) => `${t.nodeId}|${t.address}|${String(t.port).padStart(5, "0")}`,
    );
    expect(keys).toEqual([...keys].sort());
    // Every active node of the cluster answers the health endpoint: HTTP(S) requests.
    const active = await ctx.db
      .select()
      .from(schema.node)
      .where(and(eq(schema.node.clusterId, clusterId), eq(schema.node.status, "active")));
    for (const node of active)
      await ctx.db
        .update(schema.node)
        .set({ supportedFeatures: ["probe-health-v1"] })
        .where(eq(schema.node.id, node.id));
    response = await probe.client.getProbeTargets({});
    const https = (port: number) => (port === 80 ? ProbeMethod.HTTP : ProbeMethod.HTTPS);
    expect(strip(ofNodes(response.targets))).toEqual(expected(https));
    // A node that probes skips itself.
    await setNodeProbe(ctx.db, { id: own.id, enabled: true }, actor);
    response = await own.probe.getProbeTargets({});
    expect(strip(ofNodes(response.targets))).toEqual(expected(https, [reported, configured]));

    // Results: only targets the prober has, 1-10 attempts, lost ≤ sent, RTT ≤ 10 s.
    reports.length = 0;
    const result = (extra: Record<string, unknown>) => ({
      nodeId: reported.id,
      address: "8.8.0.2",
      port: 80,
      method: ProbeMethod.HTTP,
      sent: 3,
      lost: 0,
      rttMs: 12,
      error: "",
      ...extra,
    });
    const accepted = await probe.client.reportProbeResults({
      results: [
        result({}),
        result({ port: 443, sent: 3, lost: 3, rttMs: 99, error: "timeout" }),
        result({ address: "8.8.0.9" }),
        result({ address: "10.0.0.2" }),
        result({ port: 8080 }),
        result({ nodeId: disabled.id, address: "8.8.0.4" }),
        result({ nodeId: "00000000-0000-4000-8000-000000000000" }),
        result({ port: 8443, sent: 0, lost: 0 }),
        result({ port: 8443, sent: 11, lost: 0 }),
        result({ port: 8443, sent: 3, lost: 4 }),
        result({ port: 8443, rttMs: 20000 }),
        result({ nodeId: configured.id, address: "172.29.0.3", port: 8443, lost: 1, rttMs: 30 }),
      ],
    });
    expect(accepted.accepted).toBe(3);
    expect(reports).toEqual([[clusterId]]);
    const rows = await listProbeResults(ctx.db, { probeId: probe.id });
    expect(
      rows.map(({ nodeId, address, port, method, sent, lost, rttMs, error, proberKind }) => ({
        nodeId,
        address,
        port,
        method,
        sent,
        lost,
        rttMs,
        error,
        proberKind,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          nodeId: reported.id,
          address: "8.8.0.2",
          port: 80,
          method: "http",
          sent: 3,
          lost: 0,
          rttMs: 12,
          error: "",
          proberKind: "probe",
        },
        {
          nodeId: reported.id,
          address: "8.8.0.2",
          port: 443,
          method: "https",
          sent: 3,
          lost: 3,
          rttMs: 0,
          error: "timeout",
          proberKind: "probe",
        },
        {
          nodeId: configured.id,
          address: "172.29.0.3",
          port: 8443,
          method: "https",
          sent: 3,
          lost: 1,
          rttMs: 30,
          error: "",
          proberKind: "probe",
        },
      ]),
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.regionId === regionId && r.proberName === "targets")).toBe(true);
    expect((await listProbeResults(ctx.db, { nodeId: configured.id })).map((r) => r.port)).toEqual([
      8443,
    ]);
    // The node's own view for probing: a node prober reports with its region.
    await own.probe.reportProbeResults({
      results: [result({ port: 80, rttMs: 5 })],
    });
    const fromNode = (await listProbeResults(ctx.db, { probeId: own.id }))[0];
    expect(fromNode).toMatchObject({ proberKind: "node", proberName: "own", regionId });
    const [probeRow] = await ctx.db
      .select()
      .from(schema.probe)
      .where(eq(schema.probe.id, probe.id));
    expect(probeRow?.lastSeenAt).not.toBeNull();
    const summary = (await listProbes(ctx.db)).find((p) => p.id === probe.id);
    expect(summary?.lastRound).toMatchObject({ results: 3, failed: 1 });
    expect(summary?.targets).toBe((await probe.client.getProbeTargets({})).targets.length);
  });

  it("stores the host metrics of a heartbeat on the node", async () => {
    const node = await enrollNode("metrics", plainGroup);
    await node.node.reportStatus({
      appliedRevision: 1n,
      state: ApplyState.APPLIED,
      metrics: {
        cpuPercent: 150,
        load1: 1.5,
        load5: -1,
        load15: Number.NaN,
        memoryUsedBytes: 512n,
        memoryTotalBytes: 2048n,
        egressBps: 8_000_000n,
        activeConnections: 42n,
      },
    });
    const dto = await getNode(ctx.db, node.id);
    expect(dto.metrics).toMatchObject({
      cpuPercent: 100,
      load1: 1.5,
      load5: 0,
      load15: 0,
      memoryUsedBytes: 512,
      memoryTotalBytes: 2048,
      egressBps: 8_000_000,
      activeConnections: 42,
    });
    // A report without metrics clears them.
    await node.node.reportStatus({ appliedRevision: 1n, state: ApplyState.APPLIED });
    expect((await getNode(ctx.db, node.id)).metrics).toBeNull();
    const [entry] = await ctx.db
      .select()
      .from(schema.auditLog)
      .orderBy(desc(schema.auditLog.id))
      .limit(1);
    expect(entry?.action).toBe("node.enroll");
  });
});
