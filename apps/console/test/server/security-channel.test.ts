import "reflect-metadata";
import { webcrypto } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { siteCreateInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import {
  AccessLogSchema,
  ApplyState,
  NodeService,
  SecurityEventKind,
  SecurityEventSchema,
} from "@edgeweir/proto";
import * as x509 from "@peculiar/x509";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Envelope } from "../../src/server/lib/envelope";
import { type NodeChannel, startNodeChannel } from "../../src/server/node-channel/server";
import { logsCsv, queryLogs } from "../../src/server/services/access-logs";
import { sweepAlerts } from "../../src/server/services/alerts";
import { ensureChallengeKeys } from "../../src/server/services/challenge-keys";
import { createClusterTx } from "../../src/server/services/clusters";
import { createEnrollmentToken } from "../../src/server/services/enrollment";
import { updateSiteProtection } from "../../src/server/services/protection";
import {
  listSecurityEvents,
  pruneSecurityEvents,
  siteSecurityState,
} from "../../src/server/services/security";
import { createSite } from "../../src/server/services/sites";
import { createTestContext, seedOrganization } from "./helpers";

const actor = { type: "user" as const, id: "user_admin", name: "Admin" };
const JA4 = "t13d1516h2_8daaf6152771_02713d6af862";

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

describe("challenge keys, security events and JA4 over the node channel", async () => {
  const { ctx, client: pglite } = await createTestContext();
  let channel: NodeChannel;
  let baseUrl: string;
  let clusterId: string;
  let otherClusterId: string;
  let organizationId: string;
  let siteId: string;
  let foreignSiteId: string;

  const enroll = async (clusterOf: string, nodeName: string, supportedFeatures: string[]) => {
    const token = await createEnrollmentToken(
      ctx.db,
      { clusterId: clusterOf, nodeName, ttlMinutes: 10 },
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
      info: { hostname: nodeName, agentVersion: "test", supportedFeatures },
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
  const site = async (name: string, cluster?: string) =>
    (
      await createSite(
        ctx.db,
        siteCreateInput.parse({
          name,
          clusterId: cluster,
          domains: [`${name}.test`],
          origins: [{ address: "origin.test" }],
        }),
        { organizationId, actor, masterKey: ctx.masterKey, isAdmin: true },
      )
    ).site.id;
  const event = (id: string, patch: Record<string, unknown> = {}) =>
    create(SecurityEventSchema, {
      id,
      siteId,
      occurredAt: timestampFromDate(new Date()),
      kind: SecurityEventKind.SITE_LEVEL,
      level: "js",
      previousLevel: "normal",
      metric: "site_qps",
      observed: 1500,
      threshold: 1000,
      topIps: [
        { value: "203.0.113.9", count: 900n },
        { value: "not-an-ip", count: 5n },
      ],
      topPaths: [{ value: "/login?user=secret", count: 800n }],
      ...patch,
    });
  const alertEvents = () =>
    ctx.db
      .select()
      .from(schema.alertEvent)
      .where(and(eq(schema.alertEvent.siteId, siteId), eq(schema.alertEvent.kind, "cc_mitigation")))
      .orderBy(schema.alertEvent.ordinal);

  beforeAll(async () => {
    ({ organizationId } = await seedOrganization(ctx.db));
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
    siteId = await site("guarded");
    foreignSiteId = await site("foreign", otherClusterId);
  });

  afterAll(async () => {
    await channel.close();
    await pglite.close();
  });

  it("delivers 32-byte secrets of the node's own cluster only, the same to every node", async () => {
    const keys = await ctx.db.transaction((tx) => ensureChallengeKeys(tx, clusterId));
    const foreign = await ctx.db.transaction((tx) => ensureChallengeKeys(tx, otherClusterId));
    const { mtls } = await enroll(clusterId, "edge-keys", ["challenge-v1"]);
    const { mtls: second } = await enroll(clusterId, "edge-keys-2", ["challenge-v1"]);
    const ids = keys.map((key) => key.id);
    const response = await mtls.getChallengeKeys({
      ids: [...ids, foreign[0]?.id ?? "", "not-a-key", crypto.randomUUID()],
    });
    expect(response.keys.map((key) => key.id).sort()).toEqual([...ids].sort());
    for (const key of response.keys) expect(key.secret).toHaveLength(32);
    const again = await second.getChallengeKeys({ ids });
    const secret = (list: typeof response.keys, id: string) =>
      Buffer.from(list.find((key) => key.id === id)?.secret ?? []).toString("hex");
    for (const id of ids) expect(secret(again.keys, id)).toBe(secret(response.keys, id));
    expect(new Set(ids.map((id) => secret(response.keys, id))).size).toBe(3);
    // Stored sealed and bound to the row.
    const rows = await ctx.db
      .select()
      .from(schema.challengeKey)
      .where(eq(schema.challengeKey.clusterId, clusterId));
    for (const row of rows) {
      expect(row.secret).not.toBeNull();
      const envelope = JSON.parse(row.secret ?? "{}") as Envelope;
      expect(envelope).toMatchObject({ v: 2, purpose: "challenge_key.secret" });
      expect(row.secret).not.toContain(secret(response.keys, row.id));
      expect(() =>
        ctx.masterKey.open(envelope, {
          purpose: "challenge_key.secret",
          recordId: crypto.randomUUID(),
        }),
      ).toThrow();
    }
    // The other cluster's keys never got a secret from this node.
    const [foreignRow] = await ctx.db
      .select()
      .from(schema.challengeKey)
      .where(eq(schema.challengeKey.id, foreign[0]?.id ?? ""));
    expect(foreignRow?.secret).toBeNull();
    expect((await mtls.getChallengeKeys({ ids: [] })).keys).toEqual([]);
  });

  it("stores security events idempotently, skips invalid ones and throttles the alert", async () => {
    const { nodeId, mtls } = await enroll(clusterId, "edge-events", ["challenge-v1"]);
    const reported = await mtls.reportSecurityEvents({
      events: [
        event("e1"),
        event("e2", {
          kind: SecurityEventKind.PATH_LEVEL,
          level: "pow",
          previousLevel: "js",
          path: "/login?x=1",
          metric: "url_qps",
        }),
        event("e3", {
          kind: SecurityEventKind.IP_BANNED,
          level: "",
          previousLevel: "",
          address: "203.0.113.9",
          metric: "ip_qps",
        }),
        // Skipped: another cluster's site, unknown level, unknown kind, bad id, bad address.
        event("e4", { siteId: foreignSiteId }),
        event("e5", { level: "slider" }),
        event("e6", { kind: SecurityEventKind.UNSPECIFIED }),
        event("bad id!"),
        event("e7", { kind: SecurityEventKind.IP_BANNED, address: "nope" }),
      ],
    });
    expect(reported.accepted).toBe(3);
    // A retry is accepted again but stored once, and raises no second alert.
    expect((await mtls.reportSecurityEvents({ events: [event("e1")] })).accepted).toBe(1);
    const stored = await ctx.db
      .select()
      .from(schema.securityEvent)
      .where(eq(schema.securityEvent.nodeId, nodeId))
      .orderBy(schema.securityEvent.nodeEventId);
    expect(stored.map((e) => [e.nodeEventId, e.kind])).toEqual([
      ["e1", "site_level"],
      ["e2", "path_level"],
      ["e3", "ip_banned"],
    ]);
    expect(stored[0]).toMatchObject({
      organizationId,
      siteId,
      level: "js",
      previousLevel: "normal",
      metric: "site_qps",
      observed: 1500,
      threshold: 1000,
      topIps: [{ value: "203.0.113.9", count: 900 }],
      topPaths: [{ value: "/login", count: 800 }],
    });
    expect(stored[1]?.path).toBe("/login");
    expect(stored[2]).toMatchObject({ address: "203.0.113.9", level: "" });
    expect(await alertEvents()).toHaveLength(1);
    expect((await alertEvents())[0]).toMatchObject({ status: "firing", resourceId: siteId });

    // Back to normal and up again within 15 minutes: no new alert.
    await mtls.reportSecurityEvents({
      events: [
        event("e8", { level: "normal", previousLevel: "js", metric: "cooldown" }),
        event("e9"),
      ],
    });
    expect(await alertEvents()).toHaveLength(1);

    // At most 500 events per request.
    const tooMany = await mtls
      .reportSecurityEvents({
        events: Array.from({ length: 501 }, (_, i) => event(`bulk-${i}`)),
      })
      .catch((error: unknown) => error);
    expect(tooMany).toBeInstanceOf(ConnectError);
    expect((tooMany as ConnectError).code).toBe(Code.InvalidArgument);

    const page = await listSecurityEvents(
      ctx.db,
      { id: siteId, page: 1, pageSize: 2 },
      { all: false, organizationId },
    );
    expect(page.total).toBe(5);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]?.node).toEqual({ id: nodeId, name: "edge-events" });
    const banned = await listSecurityEvents(
      ctx.db,
      { id: siteId, kind: "ip_banned", page: 1, pageSize: 50 },
      { all: true },
    );
    expect(banned.items.map((e) => e.address)).toEqual(["203.0.113.9"]);
    await expect(
      listSecurityEvents(
        ctx.db,
        { id: siteId, page: 1, pageSize: 50 },
        { all: false, organizationId: "someone-else" },
      ),
    ).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
  });

  it("keeps each node's current level from the heartbeat and resolves the alert once all are normal", async () => {
    const { nodeId, mtls } = await enroll(clusterId, "edge-state", ["challenge-v1"]);
    await mtls.reportStatus({
      appliedRevision: 0n,
      state: ApplyState.APPLIED,
      dataPlaneHealthy: true,
      security: [
        { siteId, level: "pow", escalatedPaths: 3 },
        { siteId: foreignSiteId.toUpperCase(), level: "normal", escalatedPaths: 0 },
        { siteId: "not-a-site", level: "js", escalatedPaths: 1 },
        { siteId: crypto.randomUUID(), level: "slider", escalatedPaths: 1 },
      ],
    });
    const [row] = await ctx.db.select().from(schema.node).where(eq(schema.node.id, nodeId));
    expect(row?.securityState).toEqual([{ siteId, level: "pow", escalatedPaths: 3 }]);
    const state = await siteSecurityState(ctx.db, siteId, { all: true }, 24);
    expect(state.nodes.find((n) => n.id === nodeId)).toMatchObject({
      name: "edge-state",
      online: true,
      level: "pow",
      escalatedPaths: 3,
    });
    expect(state.nodes.filter((n) => n.id !== nodeId).every((n) => n.level === "normal")).toBe(
      true,
    );
    expect(state.topIps[0]).toEqual({ value: "203.0.113.9", count: 900 * 5 });
    expect(state.topPaths[0]?.value).toBe("/login");
    expect(state.hours).toBe(24);

    // The alert stays while a node reports the site above normal…
    await sweepAlerts(ctx);
    expect((await alertEvents()).map((e) => e.status)).toEqual(["firing"]);
    // …and resolves once none does (and the last raise is older than two minutes).
    // A site back at normal whose attacked paths are still escalated is shown
    // with them, but it no longer holds the alert.
    await ctx.db
      .update(schema.securityEvent)
      .set({ receivedAt: new Date(Date.now() - 600_000) })
      .where(eq(schema.securityEvent.siteId, siteId));
    await mtls.reportStatus({
      appliedRevision: 0n,
      state: ApplyState.APPLIED,
      security: [{ siteId, level: "normal", escalatedPaths: 2 }],
    });
    const [cleared] = await ctx.db.select().from(schema.node).where(eq(schema.node.id, nodeId));
    expect(cleared?.securityState).toEqual([{ siteId, level: "normal", escalatedPaths: 2 }]);
    expect(
      (await siteSecurityState(ctx.db, siteId, { all: true }, 24)).nodes.find(
        (n) => n.id === nodeId,
      ),
    ).toMatchObject({ level: "normal", escalatedPaths: 2 });
    await ctx.db
      .insert(schema.siteDomain)
      .values({ siteId, name: "alerts.guarded.test", verified: true })
      .onConflictDoNothing();
    await sweepAlerts(ctx);
    expect((await alertEvents()).map((e) => e.status)).toEqual(["firing", "resolved"]);

    // A new raise after 15 minutes fires again.
    await ctx.db
      .update(schema.alertEvent)
      .set({ occurredAt: new Date(Date.now() - 16 * 60_000) })
      .where(
        and(eq(schema.alertEvent.siteId, siteId), eq(schema.alertEvent.kind, "cc_mitigation")),
      );
    await mtls.reportSecurityEvents({ events: [event("late-raise")] });
    expect((await alertEvents()).map((e) => e.status)).toEqual(["firing", "resolved", "firing"]);
  });

  it("deletes events past the retention", async () => {
    await ctx.db
      .update(schema.securityEvent)
      .set({ occurredAt: new Date(Date.now() - 31 * 86400_000) })
      .where(eq(schema.securityEvent.nodeEventId, "e1"));
    expect(await pruneSecurityEvents(ctx.db)).toBe(1);
    const left = await ctx.db.select().from(schema.securityEvent);
    expect(left.map((e) => e.nodeEventId)).not.toContain("e1");
    expect(left.length).toBeGreaterThan(0);
    // Events older than the retention are not stored at all.
    const { mtls } = await enroll(clusterId, "edge-old", ["challenge-v1"]);
    const old = await mtls.reportSecurityEvents({
      events: [
        event("ancient", { occurredAt: timestampFromDate(new Date(Date.now() - 40 * 86400_000)) }),
      ],
    });
    expect(old.accepted).toBe(0);
  });

  it("stores JA4 in access logs only while the site records it", async () => {
    await ctx.db
      .update(schema.site)
      .set({ logSampleRate: 10000 })
      .where(eq(schema.site.id, siteId));
    const { nodeId, mtls } = await enroll(clusterId, "edge-logs", ["access-logs-v1", "ja4-v1"]);
    const now = new Date();
    const log = (ja4: string, path: string) =>
      create(AccessLogSchema, {
        siteId,
        time: timestampFromDate(now),
        clientIp: "198.51.100.4",
        method: "GET",
        host: "guarded.test",
        path,
        status: 200,
        bytesSent: 10n,
        durationMs: 3,
        cacheStatus: "HIT",
        sampleRate: 10000,
        ja4,
      });
    await mtls.reportLogs({ batchSequence: 1n, logs: [log(JA4, "/off")] });
    await updateSiteProtection(
      ctx.db,
      { id: siteId, logJa4: true },
      { scope: { all: true }, actor },
    );
    await mtls.reportLogs({
      batchSequence: 2n,
      logs: [log(JA4, "/on"), log("t13d1516h2_<script>_02713d6af862", "/bad")],
    });
    const found = await queryLogs(
      ctx,
      { all: true },
      {
        siteId,
        from: new Date(now.getTime() - 60_000).toISOString(),
        to: new Date(now.getTime() + 60_000).toISOString(),
        ip: "",
        path: "",
        limit: 100,
      },
    );
    const byPath = Object.fromEntries(found.entries.map((e) => [e.path, e.ja4]));
    expect(byPath).toEqual({ "/off": "", "/on": JA4, "/bad": "" });
    expect(found.entries.every((e) => e.nodeId === nodeId)).toBe(true);
    const csv = logsCsv(found.entries);
    expect(csv.split("\r\n")[0]).toMatch(/,ja4$/);
    expect(csv).toContain(JA4);
  });
});
