import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import { massRemoval } from "../../src/server/services/dns";
import { latestRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const fixture = vi.hoisted(() => ({
  records: [] as { name: string; type: string; data: string; ttl: number }[],
  failAfterWrite: false,
}));
vi.mock("../../src/server/services/certificate-worker", () => ({
  runCertd: vi.fn(
    async (
      _app: unknown,
      command: string,
      input: { credentials: { api_token: string }; records?: typeof fixture.records },
    ) => {
      expect(input.credentials.api_token).toBe("test-dns-secret");
      const same = (a: (typeof fixture.records)[number], b: (typeof fixture.records)[number]) =>
        a.name === b.name && a.type === b.type && a.data === b.data;
      if (command === "dns.list") return structuredClone(fixture.records);
      if (command === "dns.present")
        for (const record of input.records ?? [])
          if (!fixture.records.some((r) => same(r, record))) fixture.records.push({ ...record });
      if (command === "dns.cleanup")
        fixture.records = fixture.records.filter(
          (r) => !input.records?.some((record) => same(r, record)),
        );
      if (fixture.failAfterWrite) {
        fixture.failAfterWrite = false;
        throw new Error("simulated lost DNS response");
      }
      return structuredClone(input.records ?? []);
    },
  ),
}));
describe("M5 independent DNS publication and recovery", async () => {
  const { ctx, client: db } = await createTestContext({
    EDGEWEIR_DNS_TEST_ENDPOINT: "http://fixture.invalid",
  });
  const app = createApp(ctx),
    origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient,
    providerId: string,
    nodeId: string,
    groupId: string,
    clusterId: string,
    siteId: string,
    initialRevision: number;
  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    const created = await admin.sites.create({
      name: "dns",
      domains: ["dns-customer.test"],
      origins: [{ address: "origin.test" }],
    });
    siteId = created.site.id;
    const groups = await admin.nodeGroups.list({ clusterId });
    groupId = groups[0]?.id ?? "";
    const [node] = await ctx.db
      .insert(schema.node)
      .values({ clusterId, nodeGroupId: groupId, name: "edge", lastSeenAt: new Date() })
      .returning();
    if (!node) throw new Error("node missing");
    nodeId = node.id;
    const revision = await latestRevision(ctx.db, clusterId);
    if (!revision) throw new Error("revision missing");
    initialRevision = revision.revision;
    await ctx.db.insert(schema.nodeConfigStatus).values({
      nodeId,
      appliedRevision: revision.revision,
      appliedContentHash: revision.contentHash,
      state: "applied",
      dataPlaneHealthy: true,
    });
  });
  afterAll(() => db.close());
  it("stores provider secrets as bound envelopes", async () => {
    const p = await admin.dns.createProvider({
      name: "Test DNS",
      provider: "test",
      zone: "cdn.test",
      credentials: { api_token: "test-dns-secret" },
    });
    providerId = p.id;
    expect(JSON.stringify(await admin.dns.providers())).not.toContain("test-dns-secret");
    const [stored] = await ctx.db.select().from(schema.platformDnsProvider);
    expect(stored?.credentialEnvelope).not.toContain("test-dns-secret");
    await admin.dns.updateProvider({
      id: providerId,
      name: "Rotated test DNS",
      credentials: { api_token: "test-dns-secret" },
    });
    expect((await rpcError(admin.dns.siteTarget({ siteId: crypto.randomUUID() }))).code).toBe(
      "SITE_NOT_FOUND",
    );
  });
  it("publishes CNAME and line addresses without creating a node revision", async () => {
    fixture.records.push({ name: "unrelated", type: "TXT", data: "preserve", ttl: 600 });
    const revision = await admin.dns.save({
      enabled: true,
      providerId,
      cnameSuffix: "edge.cdn.test",
      ttl: 60,
      lines: [
        {
          name: "default",
          nodeGroupId: groupId,
          overrides: [{ nodeId, addresses: ["10.42.0.10"] }],
        },
      ],
    });
    expect(revision.status).toBe("pending");
    expect((await latestRevision(ctx.db, clusterId))?.revision).toBe(initialRevision);
    await admin.dns.reconcile();
    expect((await admin.dns.get()).revision?.status).toBe("applied");
    expect(fixture.records.filter((r) => r.type === "CNAME")).toEqual([
      { name: `${siteId}.edge`, type: "CNAME", data: `all.${siteId}.edge.cdn.test`, ttl: 60 },
    ]);
    expect(fixture.records.filter((r) => r.type === "A")).toHaveLength(2);
    expect(await admin.dns.siteTarget({ siteId })).toMatchObject({
      target: `${siteId}.edge.cdn.test`,
      published: true,
      healthy: true,
    });
    expect((await rpcError(admin.dns.deleteProvider({ id: providerId }))).code).toBe(
      "DNS_PROVIDER_IN_USE",
    );
  });
  it("keeps a disabled site's records (nodes answer 404 for it)", async () => {
    const before = structuredClone(fixture.records);
    await admin.sites.setEnabled({ id: siteId, enabled: false });
    await admin.dns.reconcile();
    expect(fixture.records).toEqual(before);
    await admin.sites.setEnabled({ id: siteId, enabled: true });
    // The node applies the resulting revision again before the next reconciliation.
    const revision = await latestRevision(ctx.db, clusterId);
    await ctx.db
      .update(schema.nodeConfigStatus)
      .set({ appliedRevision: revision?.revision, appliedContentHash: revision?.contentHash })
      .where(eq(schema.nodeConfigStatus.nodeId, nodeId));
    await admin.dns.reconcile();
    expect(fixture.records).toEqual(before);
  });
  it("keeps the records when every node looks offline, alerts, and removes them only when forced", async () => {
    // All nodes look offline, e.g. the node channel is cut off from the console.
    await ctx.db
      .update(schema.node)
      .set({ lastSeenAt: new Date(0) })
      .where(eq(schema.node.id, nodeId));
    await admin.dns.reconcile();
    await admin.dns.reconcile();
    expect(fixture.records.filter((r) => r.type === "A")).toHaveLength(2);
    expect((await admin.dns.siteTarget({ siteId })).healthy).toBe(true);
    const held = await admin.dns.get();
    expect(held.blocked).toMatchObject({
      status: "blocked",
      lastError: "dns_mass_removal_blocked",
      removedRecords: 2,
      previousRecords: 2,
    });
    expect((await admin.dns.revisions()).filter((r) => r.status === "blocked")).toHaveLength(1);
    const alerts = await admin.alerts.events({});
    expect(alerts.find((e) => e.kind === "dns_mass_removal_blocked")).toMatchObject({
      siteId: null,
      status: "firing",
    });
    expect(
      (await rpcError(admin.dns.forcePublish({ revision: held.revision?.revision ?? 1 }))).code,
    ).toBe("DNS_NOT_BLOCKED");
    await admin.dns.forcePublish({ revision: held.blocked?.revision ?? 0 });
    await admin.dns.reconcile();
    expect(fixture.records.filter((r) => r.type === "A")).toHaveLength(0);
    expect((await admin.dns.siteTarget({ siteId })).healthy).toBe(false);
    expect((await admin.dns.get()).blocked).toBeNull();
    const [entry] = (await admin.auditLogs.list({ action: "dns.force_publish" })).items;
    expect(entry?.metadata).toMatchObject({ blockedRevision: held.blocked?.revision });
    expect(
      (await admin.alerts.events({})).find((e) => e.kind === "dns_mass_removal_blocked")?.status,
    ).toBe("resolved");
  });
  it("restores nodes with fresh health, including drift repair", async () => {
    await ctx.db
      .update(schema.node)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.node.id, nodeId));
    await admin.dns.reconcile();
    expect(fixture.records.filter((r) => r.type === "A")).toHaveLength(2);
    fixture.records = fixture.records.filter((r) => r.type !== "A");
    await admin.dns.reconcile();
    expect(fixture.records.filter((r) => r.type === "A")).toHaveLength(2);
    expect(fixture.records.find((r) => r.name === "unrelated")?.data).toBe("preserve");
  });
  it("measures mass removal by record sets and share, with an adjustable threshold", async () => {
    const a = (name: string, data: string) => ({ name, type: "A" as const, data, ttl: 60 });
    const managed = [
      { name: "all.x", type: "A" },
      { name: "all.y", type: "A" },
    ];
    const previous = [a("all.x", "10.0.0.1"), a("all.x", "10.0.0.2"), a("all.y", "10.0.0.3")];
    // One of three addresses: no set becomes empty, a third is removed.
    expect(
      massRemoval(previous, {
        records: [a("all.x", "10.0.0.1"), a("all.y", "10.0.0.3")],
        managedNames: managed,
      }),
    ).toEqual({ removed: 1, previous: 3, cleared: [] });
    // Emptying all.y blocks even though only one address goes.
    expect(
      massRemoval(previous, {
        records: [a("all.x", "10.0.0.1"), a("all.x", "10.0.0.2")],
        managedNames: managed,
      }).cleared,
    ).toEqual(["all.y"]);
    // Names that are no longer managed (a deleted site) do not count.
    expect(
      massRemoval(previous, {
        records: [a("all.x", "10.0.0.1"), a("all.x", "10.0.0.2")],
        managedNames: [{ name: "all.x", type: "A" }],
      }),
    ).toEqual({ removed: 0, previous: 2, cleared: [] });
    expect(await admin.dns.protection()).toEqual({ massRemovalRatio: 0.5 });
    await admin.dns.setProtection({ massRemovalRatio: 0.3 });
    expect(await admin.dns.protection()).toEqual({ massRemovalRatio: 0.3 });
    expect((await rpcError(admin.dns.setProtection({ massRemovalRatio: 0.01 }))).status).toBe(400);
    expect((await admin.auditLogs.list({ action: "dns.protection_update" })).total).toBe(1);
    await admin.dns.setProtection({ massRemovalRatio: 0.5 });
  });
  it("repairs a partial provider write and rolls back DNS policy independently", async () => {
    const before = await admin.dns.get();
    const oldRevision = before.revision?.revision ?? 0;
    // DNS publication and rollback never publish a node configuration revision.
    const configRevision = (await latestRevision(ctx.db, clusterId))?.revision;
    const next = await admin.dns.save({ ...before.policy, cnameSuffix: "next.cdn.test" });
    fixture.failAfterWrite = true;
    await rpcError(admin.dns.reconcile());
    expect((await admin.dns.get()).revision?.status).toBe("failed");
    await admin.dns.reconcile();
    expect((await admin.dns.get()).revision?.status).toBe("applied");
    expect(fixture.records.some((r) => r.name === `${siteId}.next`)).toBe(true);
    const restored = await admin.dns.rollback({ revision: oldRevision });
    expect(restored.revision).toBeGreaterThan(next.revision);
    await admin.dns.reconcile();
    expect(fixture.records.some((r) => r.name === `${siteId}.edge`)).toBe(true);
    expect(fixture.records.some((r) => r.name === `${siteId}.next`)).toBe(false);
    expect((await latestRevision(ctx.db, clusterId))?.revision).toBe(configRevision);
    expect((await admin.dns.revisions()).some((r) => r.reason === "rollback")).toBe(true);
  });
  it("cleans managed records on disable and allows credential removal", async () => {
    await admin.dns.save({ enabled: false, providerId: null, cnameSuffix: "", lines: [] });
    await admin.dns.reconcile();
    expect(fixture.records).toEqual([
      { name: "unrelated", type: "TXT", data: "preserve", ttl: 600 },
    ]);
    await admin.dns.deleteProvider({ id: providerId });
    expect((await admin.dns.providers()).items).toEqual([]);
  });
});
