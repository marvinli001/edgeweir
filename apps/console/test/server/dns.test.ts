import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import { massRemoval, reconcileDns } from "../../src/server/services/dns";
import { latestRevision } from "../../src/server/services/revisions";
import { dnsFixture, resolve } from "./dns-fixture";
import {
  type ApiClient,
  createTestContext,
  PASSWORD,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

vi.mock("../../src/server/services/certificate-worker", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/server/services/certificate-worker")>();
  const { makeFakeCertd } = await import("./dns-fixture");
  return { ...actual, runCertd: vi.fn(makeFakeCertd(actual.CertdError)) };
});

describe("cluster DNS bindings", async () => {
  const { ctx, client: db } = await createTestContext({
    EDGEWEIR_DNS_TEST_ENDPOINT: "http://fixture.invalid",
  });
  const app = createApp(ctx),
    origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient, tenant: ApiClient;
  const a = {
    providerId: "",
    clusterId: "",
    groupId: "",
    siteIds: [] as string[],
    nodes: [] as string[],
  };
  const b = {
    providerId: "",
    clusterId: "",
    groupId: "",
    siteIds: [] as string[],
    nodes: [] as string[],
  };
  let initialConfigRevision = 0;
  const records = (token: string, zone: string) =>
    dnsFixture.records(token, zone).filter((r) => r.type !== "TXT");
  const sorted = <T extends { name: string; type: string; data: string }>(xs: T[]) =>
    [...xs].sort((x, y) => {
      const kx = `${x.name}|${x.type}|${x.data}`,
        ky = `${y.name}|${y.type}|${y.data}`;
      return kx < ky ? -1 : kx > ky ? 1 : 0;
    });
  const addNode = async (
    cluster: typeof a,
    name: string,
    address: string,
    lastSeenAt = new Date(),
  ) => {
    const [node] = await ctx.db
      .insert(schema.node)
      .values({ clusterId: cluster.clusterId, nodeGroupId: cluster.groupId, name, lastSeenAt })
      .returning();
    if (!node) throw new Error("node missing");
    await ctx.db.insert(schema.nodeIp).values({ nodeId: node.id, address });
    const revision = await latestRevision(ctx.db, cluster.clusterId);
    if (!revision) throw new Error("revision missing");
    await ctx.db.insert(schema.nodeConfigStatus).values({
      nodeId: node.id,
      appliedRevision: revision.revision,
      appliedContentHash: revision.contentHash,
      state: "applied",
      dataPlaneHealthy: true,
    });
    cluster.nodes.push(node.id);
    return node.id;
  };
  const seen = (nodeId: string, at: Date) =>
    ctx.db.update(schema.node).set({ lastSeenAt: at }).where(eq(schema.node.id, nodeId));
  const bindA = (extra: Record<string, unknown> = {}) =>
    admin.dns.saveBinding({
      clusterId: a.clusterId,
      binding: {
        mode: "auto",
        providerId: a.providerId,
        domain: "edge.a.test",
        ttl: 60,
        lines: [{ name: "east", nodeGroupId: a.groupId, overrides: [] }],
        ...extra,
      },
    });

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    dnsFixture.reset();
    dnsFixture.accounts.set("token-a", { zones: ["a.test", "other-a.test"] });
    dnsFixture.accounts.set("token-b", { zones: ["b.test"] });
    dnsFixture.set("token-a", "a.test", [
      { name: "unrelated", type: "TXT", data: "keep", ttl: 600 },
    ]);
    a.clusterId = (await admin.clusters.list())[0]?.id ?? "";
    b.clusterId = (await admin.clusters.create({ name: "west" })).id;
    a.groupId = (await admin.nodeGroups.list({ clusterId: a.clusterId }))[0]?.id ?? "";
    b.groupId = (await admin.nodeGroups.list({ clusterId: b.clusterId }))[0]?.id ?? "";
    for (const [cluster, names] of [
      [a, ["one.customer.test", "two.customer.test"]],
      [b, ["three.customer.test"]],
    ] as const)
      for (const domain of names)
        cluster.siteIds.push(
          (
            await admin.sites.create({
              name: domain,
              domains: [domain],
              origins: [{ address: "origin.test" }],
              clusterId: cluster.clusterId,
            })
          ).site.id,
        );
    initialConfigRevision = (await latestRevision(ctx.db, a.clusterId))?.revision ?? 0;
    await addNode(a, "a1", "8.8.8.1");
    await addNode(a, "a2", "8.8.8.2");
    await addNode(b, "b1", "9.9.9.1");
    const org = await admin.organizations.create({ name: "Other", defaultClusterId: a.clusterId });
    await admin.users.create({
      name: "Other",
      email: "other@dns.test",
      password: PASSWORD,
      organizationId: org.id,
    });
    tenant = rpcClient(app, origin, await signIn(app, origin, "other@dns.test"));
  });
  afterAll(() => db.close());

  it("serves the provider catalog and validates credentials against it", async () => {
    const catalog = await tenant.dns.catalog();
    const cloudflare = catalog.find((p) => p.id === "cloudflare");
    expect(cloudflare?.fields.map((f) => f.key)).toEqual(["api_token", "zone_token"]);
    expect(cloudflare?.capabilities).toMatchObject({ listZones: true, apex: "cname" });
    expect(catalog.find((p) => p.id === "powerdns")?.capabilities.endpoint).toBe("custom");
    for (const [provider, credentials] of [
      ["cloudflare", {}],
      ["cloudflare", { api_token: "t", unknown: "x" }],
      ["dnspod", { auth_token: "missing-comma" }],
      [
        "ovh",
        { endpoint: "ovh-mars", application_key: "k", application_secret: "s", consumer_key: "c" },
      ],
      ["webhook", { url: "ftp://hook.test/", secret: "0123456789abcdef" }],
      ["webhook", { url: "https://user:pw@hook.test/", secret: "0123456789abcdef" }],
      ["cloudflare", { api_token: "line\nbreak" }],
    ] as const) {
      const error = await rpcError(
        admin.dns.createProvider({ name: "x", provider, zone: "a.test", credentials }),
      );
      expect(error.code, `${provider} ${JSON.stringify(credentials)}`).toBe("DNS_POLICY_INVALID");
    }
  });

  it("lists zones and tests connections with unsaved credentials, mapping provider errors", async () => {
    expect(
      await admin.dns.zones({ provider: "test", credentials: { api_token: "token-a" } }),
    ).toEqual({ zones: ["a.test", "other-a.test"] });
    expect(
      await admin.dns.testProvider({
        provider: "test",
        credentials: { api_token: "token-a" },
        zone: "a.test",
      }),
    ).toEqual({ ok: true, records: 1 });
    expect(
      (
        await rpcError(
          admin.dns.testProvider({
            provider: "test",
            credentials: { api_token: "wrong" },
            zone: "a.test",
          }),
        )
      ).code,
    ).toBe("DNS_PROVIDER_AUTH_FAILED");
    expect(
      (
        await rpcError(
          admin.dns.testProvider({
            provider: "test",
            credentials: { api_token: "token-a" },
            zone: "missing.test",
          }),
        )
      ).code,
    ).toBe("DNS_PROVIDER_ZONE_NOT_FOUND");
    // The fake helper verified that every call carries the outbound policy.
    expect(dnsFixture.calls.length).toBeGreaterThan(0);
  });

  it("stores account secrets as bound envelopes and isolates administration", async () => {
    a.providerId = (
      await admin.dns.createProvider({
        name: "Account A",
        provider: "test",
        zone: "a.test",
        credentials: { api_token: "token-a" },
      })
    ).id;
    b.providerId = (
      await admin.dns.createProvider({
        name: "Account B",
        provider: "test",
        zone: "b.test",
        credentials: { api_token: "token-b" },
      })
    ).id;
    expect(JSON.stringify(await admin.dns.providers())).not.toContain("token-a");
    const stored = await ctx.db.select().from(schema.platformDnsProvider);
    expect(stored.map((p) => p.credentialEnvelope).join()).not.toContain("token-");
    expect(await admin.dns.testProvider({ id: a.providerId })).toEqual({ ok: true, records: 1 });
    expect(await admin.dns.zones({ id: b.providerId })).toEqual({ zones: ["b.test"] });
    await admin.dns.updateProvider({ id: a.providerId, credentials: { api_token: "token-a" } });
    expect((await rpcError(tenant.dns.binding({ clusterId: a.clusterId }))).status).toBe(403);
    expect((await rpcError(tenant.dns.zones({ id: a.providerId }))).status).toBe(403);
    expect((await rpcError(tenant.dns.siteTarget({ siteId: a.siteIds[0] ?? "" }))).code).toBe(
      "SITE_NOT_FOUND",
    );
  });

  it("publishes one address set per cluster and one CNAME per site, without a node revision", async () => {
    expect(await admin.dns.siteTarget({ siteId: a.siteIds[0] ?? "" })).toMatchObject({
      target: null,
      mode: "off",
    });
    const revision = await bindA();
    expect(revision?.status).toBe("pending");
    expect((await latestRevision(ctx.db, a.clusterId))?.revision).toBe(initialConfigRevision);
    await admin.dns.reconcile({ clusterId: a.clusterId });
    const state = await admin.dns.binding({ clusterId: a.clusterId });
    expect(state).toMatchObject({ applied: true, revision: { status: "applied" } });
    expect(state.binding).toMatchObject({ zone: "a.test", domain: "edge.a.test", allLabel: "all" });
    const [one, two] = a.siteIds;
    expect(sorted(records("token-a", "a.test"))).toEqual(
      sorted([
        { name: "all.edge", type: "A", data: "8.8.8.1", ttl: 60 },
        { name: "all.edge", type: "A", data: "8.8.8.2", ttl: 60 },
        { name: "east.edge", type: "A", data: "8.8.8.1", ttl: 60 },
        { name: "east.edge", type: "A", data: "8.8.8.2", ttl: 60 },
        ...[one, two].map((id) => ({
          name: `${id}.edge`,
          type: "CNAME",
          data: "all.edge.a.test",
          ttl: 60,
        })),
      ]),
    );
    expect(dnsFixture.records("token-a", "a.test").find((r) => r.type === "TXT")?.data).toBe(
      "keep",
    );
    expect(await admin.dns.siteTarget({ siteId: one ?? "" })).toEqual({
      target: `${one}.edge.a.test`,
      mode: "auto",
      published: true,
      healthy: true,
      lines: [{ name: "east", target: "east.edge.a.test" }],
    });
    expect((await rpcError(admin.dns.deleteProvider({ id: a.providerId }))).code).toBe(
      "DNS_PROVIDER_IN_USE",
    );
    const [entry] = (await admin.auditLogs.list({ action: "dns.binding_update" })).items;
    expect(entry).toMatchObject({ targetType: "cluster", targetId: a.clusterId });
  });

  it("gives two clusters their own accounts and domains; a failing provider does not block the other", async () => {
    await admin.dns.saveBinding({
      clusterId: b.clusterId,
      binding: {
        mode: "auto",
        providerId: b.providerId,
        domain: "cdn.b.test",
        ttl: 120,
        lines: [{ name: "west", nodeGroupId: b.groupId, overrides: [] }],
      },
    });
    // Account A is down: cluster B still publishes.
    dnsFixture.down.add("token-a");
    await seen(a.nodes[1] ?? "", new Date(Date.now() - 3600_000));
    const result = await reconcileDns(ctx);
    expect(result).toMatchObject({ ok: true, failures: [a.clusterId] });
    expect((await admin.dns.binding({ clusterId: b.clusterId })).applied).toBe(true);
    expect(records("token-b", "b.test")).toEqual(
      expect.arrayContaining([
        { name: "all.cdn", type: "A", data: "9.9.9.1", ttl: 120 },
        { name: `${b.siteIds[0]}.cdn`, type: "CNAME", data: "all.cdn.b.test", ttl: 120 },
      ]),
    );
    const failed = await admin.dns.binding({ clusterId: a.clusterId });
    expect(failed.revision).toMatchObject({
      status: "failed",
      lastError: "dns_provider_unreachable",
    });
    expect((await rpcError(admin.dns.reconcile({ clusterId: a.clusterId }))).code).toBe(
      "DNS_PROVIDER_UNREACHABLE",
    );
    const overview = await admin.dns.bindings();
    expect(overview.find((x) => x.clusterId === b.clusterId)).toMatchObject({
      mode: "auto",
      zone: "b.test",
      domain: "cdn.b.test",
      applied: true,
    });
    dnsFixture.down.delete("token-a");
    await admin.dns.reconcile({});
    expect((await admin.dns.binding({ clusterId: a.clusterId })).applied).toBe(true);
  });

  it("removes an offline node only from its cluster's records and adds it back", async () => {
    // a2 has been offline since the previous test: gone from cluster A only.
    const aRecords = records("token-a", "a.test");
    expect(aRecords.filter((r) => r.type === "A").map((r) => r.data)).toEqual([
      "8.8.8.1",
      "8.8.8.1",
    ]);
    expect(
      records("token-b", "b.test")
        .filter((r) => r.type === "A")
        .map((r) => r.data),
    ).toEqual(["9.9.9.1", "9.9.9.1"]);
    await seen(a.nodes[1] ?? "", new Date());
    await reconcileDns(ctx);
    expect(records("token-a", "a.test").filter((r) => r.type === "A")).toHaveLength(4);
  });

  it("holds a cluster's records when all its nodes look offline, per cluster, until forced", async () => {
    await seen(b.nodes[0] ?? "", new Date(0));
    await reconcileDns(ctx);
    await reconcileDns(ctx);
    expect(records("token-b", "b.test").filter((r) => r.type === "A")).toHaveLength(2);
    const held = await admin.dns.binding({ clusterId: b.clusterId });
    expect(held.blocked).toMatchObject({
      status: "blocked",
      lastError: "dns_mass_removal_blocked",
      removedRecords: 2,
      previousRecords: 2,
    });
    expect((await admin.dns.binding({ clusterId: a.clusterId })).blocked).toBeNull();
    expect((await admin.dns.bindings()).find((x) => x.clusterId === b.clusterId)?.blocked).toBe(
      true,
    );
    const alert = (await admin.alerts.events({})).find(
      (e) => e.kind === "dns_mass_removal_blocked",
    );
    expect(alert).toMatchObject({ siteId: null, status: "firing" });
    expect(
      (
        await rpcError(
          admin.dns.forcePublishBinding({
            clusterId: a.clusterId,
            revision: held.blocked?.revision ?? 0,
          }),
        )
      ).code,
    ).toBe("DNS_NOT_BLOCKED");
    await admin.dns.forcePublishBinding({
      clusterId: b.clusterId,
      revision: held.blocked?.revision ?? 0,
    });
    await admin.dns.reconcile({ clusterId: b.clusterId });
    expect(records("token-b", "b.test").filter((r) => r.type === "A")).toHaveLength(0);
    expect((await admin.dns.siteTarget({ siteId: b.siteIds[0] ?? "" })).healthy).toBe(false);
    const [entry] = (await admin.auditLogs.list({ action: "dns.force_publish" })).items;
    expect(entry?.metadata).toMatchObject({ blockedRevision: held.blocked?.revision });
    expect(
      (await admin.alerts.events({})).find((e) => e.kind === "dns_mass_removal_blocked")?.status,
    ).toBe("resolved");
    await seen(b.nodes[0] ?? "", new Date());
    await reconcileDns(ctx);
    expect(records("token-b", "b.test").filter((r) => r.type === "A")).toHaveLength(2);
  });

  it("repairs drift and a partial write, and rolls a binding back independently", async () => {
    dnsFixture.set(
      "token-a",
      "a.test",
      dnsFixture.records("token-a", "a.test").filter((r) => r.name !== "east.edge"),
    );
    await admin.dns.reconcile({ clusterId: a.clusterId });
    expect(records("token-a", "a.test").filter((r) => r.name === "east.edge")).toHaveLength(2);
    const before = await admin.dns.binding({ clusterId: a.clusterId });
    const oldRevision = before.revision?.revision ?? 0;
    const next = await bindA({ domain: "next.a.test" });
    dnsFixture.failAfterWrite.add("token-a");
    await rpcError(admin.dns.reconcile({ clusterId: a.clusterId }));
    expect((await admin.dns.binding({ clusterId: a.clusterId })).revision?.status).toBe("failed");
    await admin.dns.reconcile({ clusterId: a.clusterId });
    expect((await admin.dns.binding({ clusterId: a.clusterId })).revision?.status).toBe("applied");
    const names = () => records("token-a", "a.test").map((r) => r.name);
    expect(names()).toContain(`${a.siteIds[0]}.next`);
    expect(names()).not.toContain(`${a.siteIds[0]}.edge`);
    const restored = await admin.dns.rollbackBinding({
      clusterId: a.clusterId,
      revision: oldRevision,
    });
    expect(restored.revision).toBeGreaterThan(next?.revision ?? 0);
    await admin.dns.reconcile({ clusterId: a.clusterId });
    expect(names()).toContain(`${a.siteIds[0]}.edge`);
    expect(names()).not.toContain(`${a.siteIds[0]}.next`);
    expect((await latestRevision(ctx.db, a.clusterId))?.revision).toBe(initialConfigRevision);
    expect(
      (await admin.dns.bindingRevisions({ clusterId: a.clusterId })).some(
        (r) => r.reason === "rollback",
      ),
    ).toBe(true);
    // Cluster B's history is separate.
    expect(
      (await admin.dns.bindingRevisions({ clusterId: b.clusterId })).some(
        (r) => r.reason === "rollback",
      ),
    ).toBe(false);
  });

  it("refuses names another cluster manages and names with unmanaged records", async () => {
    // Same zone and domain as cluster A: the all-lines record would collide.
    const conflict = await rpcError(
      admin.dns.saveBinding({
        clusterId: b.clusterId,
        binding: {
          mode: "auto",
          providerId: a.providerId,
          domain: "edge.a.test",
          lines: [{ name: "west", nodeGroupId: b.groupId, overrides: [] }],
        },
      }),
    );
    expect(conflict.code).toBe("DNS_BINDING_CONFLICT");
    expect(
      (
        await rpcError(
          admin.dns.saveBinding({
            clusterId: b.clusterId,
            binding: { mode: "auto", providerId: a.providerId, domain: "edge.other.test" },
          }),
        )
      ).code,
    ).toBe("DNS_ZONE_MISMATCH");
    expect(
      (
        await rpcError(
          admin.dns.saveBinding({
            clusterId: b.clusterId,
            binding: {
              mode: "auto",
              providerId: b.providerId,
              domain: "cdn.b.test",
              lines: [{ name: "east", nodeGroupId: a.groupId, overrides: [] }],
            },
          }),
        )
      ).code,
    ).toBe("NODE_GROUP_NOT_FOUND");
    // A record the console did not write blocks taking the name over.
    dnsFixture.set("token-b", "b.test", [
      ...dnsFixture.records("token-b", "b.test"),
      { name: "south.cdn", type: "A", data: "192.0.2.50", ttl: 300 },
    ]);
    const south = (await admin.nodeGroups.create({ clusterId: b.clusterId, name: "south" })).id;
    await admin.dns.saveBinding({
      clusterId: b.clusterId,
      binding: {
        mode: "auto",
        providerId: b.providerId,
        domain: "cdn.b.test",
        ttl: 120,
        lines: [
          { name: "west", nodeGroupId: b.groupId, overrides: [] },
          { name: "south", nodeGroupId: south, overrides: [] },
        ],
      },
    });
    await rpcError(admin.dns.reconcile({ clusterId: b.clusterId }));
    expect((await admin.dns.binding({ clusterId: b.clusterId })).revision?.lastError).toBe(
      "dns_record_conflict",
    );
    expect(dnsFixture.records("token-b", "b.test").find((r) => r.name === "south.cdn")?.data).toBe(
      "192.0.2.50",
    );
    await admin.dns.saveBinding({
      clusterId: b.clusterId,
      binding: {
        mode: "auto",
        providerId: b.providerId,
        domain: "cdn.b.test",
        ttl: 120,
        lines: [{ name: "west", nodeGroupId: b.groupId, overrides: [] }],
      },
    });
    await admin.dns.reconcile({ clusterId: b.clusterId });
    await admin.nodeGroups.delete({ id: south });
  });

  it("lists manual records and a BIND zone file without writing DNS", async () => {
    await admin.dns.saveBinding({
      clusterId: b.clusterId,
      binding: {
        mode: "manual",
        providerId: b.providerId,
        domain: "cdn.b.test",
        ttl: 300,
        lines: [{ name: "west", nodeGroupId: b.groupId, overrides: [] }],
      },
    });
    const writes = dnsFixture.calls.length;
    // Manual lists every active node, also one that looks offline.
    await seen(b.nodes[0] ?? "", new Date(0));
    await admin.dns.reconcile({ clusterId: b.clusterId });
    await reconcileDns(ctx);
    expect(
      dnsFixture.calls
        .slice(writes)
        .filter((c) => c.token === "token-b" && c.command !== "dns.list"),
    ).toEqual([]);
    const site = b.siteIds[0] ?? "";
    const exported = await admin.dns.exportBinding({ clusterId: b.clusterId });
    expect(exported.origin).toBe("b.test");
    expect(sorted(exported.records)).toEqual(
      sorted([
        { name: "all.cdn.b.test", type: "A", data: "9.9.9.1", ttl: 300 },
        { name: `${site}.cdn.b.test`, type: "CNAME", data: "all.cdn.b.test", ttl: 300 },
        { name: "west.cdn.b.test", type: "A", data: "9.9.9.1", ttl: 300 },
      ]),
    );
    const lines = exported.zoneFile.trim().split("\n");
    expect(lines.slice(0, 2)).toEqual(["$ORIGIN b.test.", "$TTL 300"]);
    expect(
      lines
        .slice(2)
        .map((l) => l.split(/\s+/).join(" "))
        .sort(),
    ).toEqual(
      [
        "all.cdn 300 IN A 9.9.9.1",
        `${site}.cdn 300 IN CNAME all.cdn.b.test.`,
        "west.cdn 300 IN A 9.9.9.1",
      ].sort(),
    );
    expect(await admin.dns.siteTarget({ siteId: site })).toMatchObject({
      target: `${site}.cdn.b.test`,
      mode: "manual",
    });
    await seen(b.nodes[0] ?? "", new Date());
  });

  it("cleans a binding's records when DNS is turned off and releases the account and cluster", async () => {
    await admin.dns.saveBinding({ clusterId: a.clusterId, binding: { mode: "off" } });
    await admin.dns.reconcile({ clusterId: a.clusterId });
    expect(dnsFixture.records("token-a", "a.test")).toEqual([
      { name: "unrelated", type: "TXT", data: "keep", ttl: 600 },
    ]);
    expect(await admin.dns.siteTarget({ siteId: a.siteIds[0] ?? "" })).toMatchObject({
      target: null,
      mode: "off",
    });
    await admin.dns.deleteProvider({ id: a.providerId });
    // Manual cluster B still has managed names from its automatic period.
    const empty = await admin.clusters.create({ name: "empty" });
    await admin.dns.saveBinding({
      clusterId: empty.id,
      binding: { mode: "auto", providerId: b.providerId, domain: "empty.b.test" },
    });
    await admin.dns.reconcile({ clusterId: empty.id });
    expect((await rpcError(admin.clusters.delete({ id: empty.id }))).code).toBe(
      "DNS_BINDING_IN_USE",
    );
    await admin.dns.saveBinding({ clusterId: empty.id, binding: { mode: "off" } });
    await admin.dns.reconcile({ clusterId: empty.id });
    await admin.clusters.delete({ id: empty.id });
  });

  it("measures mass removal by record sets and share, with an adjustable threshold", async () => {
    const rec = (name: string, data: string) => ({ name, type: "A" as const, data, ttl: 60 });
    const managed = [
      { name: "all.x", type: "A" },
      { name: "all.y", type: "A" },
    ];
    const previous = [rec("all.x", "10.0.0.1"), rec("all.x", "10.0.0.2"), rec("all.y", "10.0.0.3")];
    expect(
      massRemoval(previous, {
        records: [rec("all.x", "10.0.0.1"), rec("all.y", "10.0.0.3")],
        managedNames: managed,
      }),
    ).toEqual({ removed: 1, previous: 3, cleared: [] });
    expect(
      massRemoval(previous, {
        records: [rec("all.x", "10.0.0.1"), rec("all.x", "10.0.0.2")],
        managedNames: managed,
      }).cleared,
    ).toEqual(["all.y"]);
    expect(
      massRemoval(previous, {
        records: [rec("all.x", "10.0.0.1"), rec("all.x", "10.0.0.2")],
        managedNames: [{ name: "all.x", type: "A" }],
      }),
    ).toEqual({ removed: 0, previous: 2, cleared: [] });
    expect(await admin.dns.protection()).toEqual({ massRemovalRatio: 0.5 });
    await admin.dns.setProtection({ massRemovalRatio: 0.3 });
    expect(await admin.dns.protection()).toEqual({ massRemovalRatio: 0.3 });
    expect((await rpcError(admin.dns.setProtection({ massRemovalRatio: 0.01 }))).status).toBe(400);
    expect((await rpcError(tenant.dns.protection())).status).toBe(403);
    await admin.dns.setProtection({ massRemovalRatio: 0.5 });
  });

  it("resolves names in a zone by following CNAMEs (test helper)", () => {
    const zone = [
      { name: "x", type: "CNAME", data: "all.a.test.", ttl: 60 },
      { name: "all", type: "A", data: "8.8.8.1", ttl: 60 },
    ];
    expect(resolve(zone, "a.test", "x.a.test")).toEqual(["8.8.8.1"]);
  });
});
