import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { ERROR_PAGE_MAX_BYTES } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { sweepAlerts } from "../../src/server/services/alerts";
import { replaceOriginHealth } from "../../src/server/services/origin-health";
import { latestRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  approveSiteDomains,
  createTestContext,
  PASSWORD,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const G4_FEATURES = [
  "rules-v1",
  "tls-v1",
  "access-logs-v1",
  "challenge-v1",
  "active-health-v1",
  "session-affinity-v1",
  "error-pages-v1",
  "purge-tag-v1",
  "prefetch-v2",
];

const healthCheck = {
  enabled: true,
  path: "/healthz?deep=1",
  method: "HEAD" as const,
  expectedStatusMin: 200,
  expectedStatusMax: 299,
  host: "health.store.test",
  intervalSeconds: 10,
  timeoutSeconds: 3,
  healthyThreshold: 2,
  unhealthyThreshold: 4,
};

describe("active health checks, session affinity, Cache-Tag and error pages on the console side", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let owner: ApiClient;
  let member: ApiClient;
  let outsider: ApiClient;
  let clusterId: string;
  let otherClusterId: string;
  let orgId: string;
  let siteId: string;
  let otherSiteId: string;
  let nodeId: string;
  const origins = [{ address: "origin-a.test" }, { address: "origin-b.test", backup: true }];
  const api = (key: string, method: string, path: string, body?: unknown) =>
    app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const config = async (cluster = clusterId) =>
    decodeNodeConfig((await latestRevision(ctx.db, cluster))?.ir ?? new Uint8Array());
  const siteOf = async (id = siteId) => (await config()).sites.find((site) => site.id === id);
  const setNodeFeatures = (features: string[]) =>
    ctx.db
      .update(schema.node)
      .set({ supportedFeatures: features })
      .where(eq(schema.node.id, nodeId));
  const audits = (action: string) =>
    ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, action))
      .orderBy(schema.auditLog.id);

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    otherClusterId = (await admin.clusters.create({ name: "elsewhere", description: "" })).id;
    orgId = (await admin.organizations.create({ name: "Store", defaultClusterId: clusterId })).id;
    const otherOrgId = (
      await admin.organizations.create({ name: "Rival", defaultClusterId: clusterId })
    ).id;
    const users: [string, string, "owner" | "member"][] = [
      ["owner@store.test", orgId, "owner"],
      ["member@store.test", orgId, "member"],
      ["owner@rival.test", otherOrgId, "owner"],
    ];
    for (const [email, organizationId, role] of users)
      await admin.users.create({ name: email, email, password: PASSWORD, organizationId, role });
    owner = rpcClient(app, origin, await signIn(app, origin, "owner@store.test"));
    member = rpcClient(app, origin, await signIn(app, origin, "member@store.test"));
    outsider = rpcClient(app, origin, await signIn(app, origin, "owner@rival.test"));
    siteId = (
      await owner.sites.create({
        name: "store",
        domains: ["www.store.test", "*.cdn.store.test"],
        origins,
      })
    ).site.id;
    otherSiteId = (
      await outsider.sites.create({ name: "rival", domains: ["www.rival.test"], origins })
    ).site.id;
    for (const id of [siteId, otherSiteId]) await approveSiteDomains(admin, id);
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-g4",
        supportedFeatures: G4_FEATURES,
        enrolledAt: new Date(Date.now() - 86_400_000),
        lastSeenAt: new Date(),
      })
      .returning();
    if (!node) throw new Error("node missing");
    nodeId = node.id;
  });
  afterAll(() => pglite.close());

  it("reads the new settings off, no error pages and every feature available", async () => {
    const site = await member.sites.get({ id: siteId });
    expect(site.originSettings.activeHealthCheck).toEqual({
      enabled: false,
      path: "/",
      method: "GET",
      expectedStatusMin: 200,
      expectedStatusMax: 399,
      host: "",
      intervalSeconds: 30,
      timeoutSeconds: 5,
      healthyThreshold: 2,
      unhealthyThreshold: 3,
    });
    expect(site.originSettings.sessionAffinity).toEqual({ enabled: false, ttlSeconds: 3600 });
    expect(site.cacheSettings.keepCacheTag).toBe(false);
    expect(await member.errorPages.get({ id: siteId })).toEqual({
      siteId,
      pages: [],
      interceptOriginErrors: false,
      updatedAt: null,
    });
    expect(await admin.settings.errorPages()).toEqual({
      unknownHost: "",
      siteDisabled: "",
      siteSuspended: "",
    });
    const features = await member.sites.features({ id: siteId });
    for (const key of [
      "activeHealthCheck",
      "sessionAffinity",
      "errorPages",
      "purgeByTag",
      "prefetchVariants",
    ] as const)
      expect(features[key], key).toEqual({ available: true, reason: null });
    const current = await config();
    const compiled = current.sites.find((s) => s.id === siteId);
    expect(compiled?.keepCacheTag).toBe(false);
    expect(compiled?.errorPages).toBeUndefined();
    expect(compiled?.originPool?.activeHealthCheck).toBeUndefined();
    expect(current.platformErrorPages).toBeUndefined();
    expect(current.offlineHosts).toEqual([]);
  });

  it("stores health checks, affinity and keepCacheTag, keeps them when an update omits them and compiles them only while on", async () => {
    const { site, revision } = await owner.sites.update({
      id: siteId,
      originSettings: { activeHealthCheck: healthCheck, sessionAffinity: { enabled: false } },
      cacheSettings: { keepCacheTag: true },
    });
    expect(site.originSettings.activeHealthCheck).toEqual(healthCheck);
    expect(site.cacheSettings.keepCacheTag).toBe(true);
    expect(revision.reasonCode).toBe("site_updated");
    let compiled = await siteOf();
    expect(compiled?.keepCacheTag).toBe(true);
    expect(compiled?.originPool?.activeHealthCheck).toMatchObject({
      path: "/healthz?deep=1",
      method: "HEAD",
      expectedStatusMin: 200,
      expectedStatusMax: 299,
      host: "health.store.test",
      intervalSeconds: 10,
      timeoutSeconds: 3,
      healthyThreshold: 2,
      unhealthyThreshold: 4,
    });
    expect(compiled?.originPool?.sessionAffinity).toBeUndefined();
    expect((await config()).requiredFeatures).toContain("active-health-v1");
    // Clients that predate these settings send pool and cache settings without them.
    const kept = await member.sites.update({
      id: siteId,
      originSettings: { policy: "round_robin" },
      cacheSettings: { rangeSlice: true },
    });
    expect(kept.site.originSettings).toMatchObject({
      policy: "round_robin",
      activeHealthCheck: healthCheck,
      sessionAffinity: { enabled: false, ttlSeconds: 3600 },
    });
    expect(kept.site.cacheSettings).toMatchObject({ rangeSlice: true, keepCacheTag: true });
    // Off keeps the settings but compiles nothing and requires nothing.
    const off = await owner.sites.update({
      id: siteId,
      originSettings: { activeHealthCheck: { ...healthCheck, enabled: false } },
      cacheSettings: { keepCacheTag: false },
    });
    expect(off.site.originSettings.activeHealthCheck).toEqual({ ...healthCheck, enabled: false });
    compiled = await siteOf();
    expect(compiled?.originPool?.activeHealthCheck).toBeUndefined();
    expect(compiled?.keepCacheTag).toBe(false);
    expect((await config()).requiredFeatures).not.toContain("active-health-v1");
    // Invalid checks are refused before anything is stored.
    for (const activeHealthCheck of [
      { intervalSeconds: 5, timeoutSeconds: 6 },
      { expectedStatusMin: 400, expectedStatusMax: 300 },
      { path: "no-slash" },
    ])
      expect(
        (await rpcError(owner.sites.update({ id: siteId, originSettings: { activeHealthCheck } })))
          .status,
      ).toBe(400);
  });

  it("compiles the cluster's challenge keys for session affinity and keeps them on rollback", async () => {
    const before = await config();
    expect(before.challengeKeys).toEqual([]);
    await owner.sites.update({
      id: siteId,
      originSettings: { sessionAffinity: { enabled: true, ttlSeconds: 900 } },
    });
    const withAffinity = await config();
    expect(withAffinity.sites.find((s) => s.id === siteId)?.originPool?.sessionAffinity).toEqual(
      expect.objectContaining({ ttlSeconds: 900 }),
    );
    expect(withAffinity.challengeKeys.map((key) => key.role).sort()).toEqual([
      "current",
      "next",
      "previous",
    ]);
    expect(withAffinity.requiredFeatures).toEqual(
      expect.arrayContaining(["challenge-v1", "session-affinity-v1"]),
    );
    // Keys alone: no platform protection, no site protection.
    expect(withAffinity.platformProtection).toBeUndefined();
    expect(withAffinity.sites.every((site) => !site.protection)).toBe(true);
    const keys = await ctx.db
      .select()
      .from(schema.challengeKey)
      .where(eq(schema.challengeKey.clusterId, clusterId));
    expect(keys).toHaveLength(3);
    // Off again: the keys and both features leave the configuration.
    await owner.sites.update({
      id: siteId,
      originSettings: { sessionAffinity: { enabled: false } },
    });
    const plain = await config();
    expect(plain.challengeKeys).toEqual([]);
    expect(plain.requiredFeatures).not.toContain("session-affinity-v1");
    expect(plain.requiredFeatures).not.toContain("challenge-v1");
    // Rolling back to the affinity revision brings the current keys back.
    await admin.clusters.rollback({ id: clusterId, revision: Number(withAffinity.revision) });
    const restored = await config();
    expect(
      restored.sites.find((s) => s.id === siteId)?.originPool?.sessionAffinity?.ttlSeconds,
    ).toBe(900);
    expect(restored.challengeKeys.map((key) => key.id).sort()).toEqual(
      keys.map((key) => key.id).sort(),
    );
    expect(restored.requiredFeatures).toEqual(
      expect.arrayContaining(["challenge-v1", "session-affinity-v1"]),
    );
    await owner.sites.update({
      id: siteId,
      originSettings: { sessionAffinity: { enabled: false } },
    });
    expect((await config()).challengeKeys).toEqual([]);
  });

  it("refuses tenants health checks, affinity and error pages the cluster's nodes lack; administrators may require them", async () => {
    await setNodeFeatures(["rules-v1", "tls-v1", "access-logs-v1"]);
    const unavailable = { available: false, reason: "nodes" };
    expect(await member.sites.features({ id: siteId })).toMatchObject({
      activeHealthCheck: unavailable,
      sessionAffinity: unavailable,
      errorPages: unavailable,
      purgeByTag: unavailable,
      prefetchVariants: unavailable,
    });
    // Affinity also needs challenge-v1 for the keys it signs with.
    await setNodeFeatures(["rules-v1", "tls-v1", "access-logs-v1", "session-affinity-v1"]);
    expect((await member.sites.features({ id: siteId })).sessionAffinity).toEqual(unavailable);
    await setNodeFeatures(["rules-v1", "tls-v1", "access-logs-v1"]);
    const before = (await config()).revision;
    for (const [call, feature] of [
      [
        () =>
          owner.sites.update({ id: siteId, originSettings: { activeHealthCheck: healthCheck } }),
        "active-health-v1",
      ],
      [
        () =>
          owner.sites.update({
            id: siteId,
            originSettings: { sessionAffinity: { enabled: true } },
          }),
        "challenge-v1, session-affinity-v1",
      ],
      [
        () =>
          owner.errorPages.update({ id: siteId, pages: [{ status: 503, template: "<p>x</p>" }] }),
        "error-pages-v1",
      ],
    ] as const)
      expect(await rpcError(call())).toMatchObject({
        code: "NODE_CAPABILITY_REQUIRED",
        status: 409,
        data: { features: feature },
      });
    expect((await config()).revision).toBe(before);
    expect((await member.sites.get({ id: siteId })).originSettings.activeHealthCheck.enabled).toBe(
      false,
    );
    expect((await member.errorPages.get({ id: siteId })).pages).toEqual([]);
    // Cache-Tag forwarding needs no feature: older nodes forward the header anyway.
    await owner.sites.update({ id: siteId, cacheSettings: { keepCacheTag: true } });
    expect((await siteOf())?.keepCacheTag).toBe(true);
    await owner.sites.update({ id: siteId, cacheSettings: { keepCacheTag: false } });
    // A disabled node does not count; an administrator may require the upgrade.
    await ctx.db.update(schema.node).set({ status: "disabled" }).where(eq(schema.node.id, nodeId));
    expect((await member.sites.features({ id: siteId })).errorPages.available).toBe(true);
    await ctx.db.update(schema.node).set({ status: "active" }).where(eq(schema.node.id, nodeId));
    await admin.errorPages.update({ id: siteId, pages: [{ status: 503, template: "<p>x</p>" }] });
    expect((await config()).requiredFeatures).toContain("error-pages-v1");
    await admin.errorPages.update({ id: siteId, pages: [] });
    expect((await config()).requiredFeatures).not.toContain("error-pages-v1");
    await setNodeFeatures(G4_FEATURES);
  });

  it("lets owners change error pages, members read them and nobody else reach them", async () => {
    const pages = [{ status: 403 as const, template: "<p>denied</p>" }];
    expect(await rpcError(member.errorPages.update({ id: siteId, pages }))).toMatchObject({
      code: "ORG_ADMIN_REQUIRED",
      status: 403,
    });
    for (const call of [
      () => outsider.errorPages.get({ id: siteId }),
      () => outsider.errorPages.update({ id: siteId, pages }),
    ])
      expect(await rpcError(call())).toMatchObject({ code: "SITE_NOT_FOUND", status: 404 });
    // Tenants never reach the platform pages.
    for (const call of [
      () => owner.settings.errorPages(),
      () => owner.settings.setErrorPages({ unknownHost: "<p>mine</p>" }),
    ])
      expect((await rpcError(call())).status).toBe(403);
    // Read-only AccessKeys read but cannot write.
    const reader = await owner.accessKeys.create({ name: "pages-read", scope: "read" });
    expect((await api(reader.key, "GET", `/sites/${siteId}/error-pages`)).status).toBe(200);
    const res = await api(reader.key, "PUT", `/sites/${siteId}/error-pages`, { pages });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "ACCESS_KEY_READ_ONLY" });
    expect((await member.errorPages.get({ id: siteId })).pages).toEqual([]);
  });

  it("replaces a site's error pages through /api/v1, publishes them sorted by status and audits their sizes", async () => {
    const writer = await owner.accessKeys.create({ name: "pages-write", scope: "write" });
    const res = await api(writer.key, "PUT", `/sites/${siteId}/error-pages`, {
      pages: [
        { status: 503, template: "<h1>{{status}}</h1><p>{{request_id}}</p>" },
        { status: 403, template: "<p>{{client_ip}} 被拒绝</p>" },
      ],
      interceptOriginErrors: true,
    });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as { updatedAt: string; pages: { status: number }[] };
    expect(saved).toMatchObject({
      siteId,
      interceptOriginErrors: true,
      pages: [
        { status: 403, template: "<p>{{client_ip}} 被拒绝</p>" },
        { status: 503, template: "<h1>{{status}}</h1><p>{{request_id}}</p>" },
      ],
    });
    expect(saved.updatedAt).not.toBeNull();
    expect(await member.errorPages.get({ id: siteId })).toEqual(saved);
    expect(await latestRevision(ctx.db, clusterId)).toMatchObject({
      reasonCode: "site_error_pages_updated",
      reasonParams: { site: "store" },
    });
    const compiled = await siteOf();
    expect(compiled?.errorPages?.pages.map((page) => page.status)).toEqual([403, 503]);
    expect(compiled?.errorPages?.interceptOriginErrors).toBe(true);
    expect((await config()).requiredFeatures).toContain("error-pages-v1");
    expect((await siteOf(otherSiteId))?.errorPages).toBeUndefined();
    // The latest entry: an administrator saved pages earlier.
    const audit = (await audits("site.error_pages_update")).at(-1);
    expect(audit).toMatchObject({ organizationId: orgId, targetId: siteId, actorType: "api_key" });
    expect(audit?.metadata).toMatchObject({
      from: { statuses: [], interceptOriginErrors: false },
      to: { statuses: [403, 503], interceptOriginErrors: true },
      changed: [403, 503],
      bytes: { "403": 30, "503": 40 },
    });
    // A stale expectedUpdatedAt is refused with the current value.
    const stale = await rpcError(
      owner.errorPages.update({
        id: siteId,
        pages: [],
        expectedUpdatedAt: new Date(Date.parse(saved.updatedAt) - 1000).toISOString(),
      }),
    );
    expect(stale).toMatchObject({
      code: "UPDATED_AT_MISMATCH",
      status: 409,
      data: { updatedAt: saved.updatedAt },
    });
    // Without pages nothing is compiled, whatever the intercept switch says.
    const cleared = await owner.errorPages.update({
      id: siteId,
      pages: [],
      interceptOriginErrors: true,
      expectedUpdatedAt: saved.updatedAt,
    });
    expect(cleared.pages).toEqual([]);
    expect((await siteOf())?.errorPages).toBeUndefined();
    expect((await config()).requiredFeatures).not.toContain("error-pages-v1");
    // Unknown statuses and duplicates are validation errors.
    for (const pages of [
      [{ status: 404, template: "x" }],
      [
        { status: 429, template: "a" },
        { status: 429, template: "b" },
      ],
    ])
      expect(
        (
          await rpcError(
            owner.errorPages.update({
              id: siteId,
              pages: pages as { status: 429; template: string }[],
            }),
          )
        ).status,
      ).toBe(400);
  });

  it("limits templates to 64 KiB of UTF-8, not of characters", async () => {
    // 65536 bytes of ASCII fit exactly.
    const ascii = "a".repeat(ERROR_PAGE_MAX_BYTES);
    const fits = await owner.errorPages.update({
      id: siteId,
      pages: [{ status: 502, template: ascii }],
    });
    expect(fits.pages[0]?.template).toHaveLength(ERROR_PAGE_MAX_BYTES);
    // 30000 CJK characters are 90000 bytes.
    const cjk = "错".repeat(30_000);
    expect(
      await rpcError(
        owner.errorPages.update({ id: siteId, pages: [{ status: 504, template: cjk }] }),
      ),
    ).toMatchObject({
      code: "ERROR_PAGE_TOO_LARGE",
      status: 400,
      data: { status: 504, limit: ERROR_PAGE_MAX_BYTES },
    });
    expect(
      await rpcError(
        owner.errorPages.update({ id: siteId, pages: [{ status: 502, template: `${ascii}b` }] }),
      ),
    ).toMatchObject({ code: "ERROR_PAGE_TOO_LARGE", data: { status: 502 } });
    // Nothing changed.
    expect((await member.errorPages.get({ id: siteId })).pages).toEqual([
      { status: 502, template: ascii },
    ]);
    expect(
      await rpcError(admin.settings.setErrorPages({ siteSuspended: "停".repeat(22_000) })),
    ).toMatchObject({ code: "ERROR_PAGE_TOO_LARGE", data: { status: 503 } });
    await owner.errorPages.update({ id: siteId, pages: [] });
  });

  it("publishes the platform's pages to every cluster and audits them", async () => {
    const before = {
      main: (await config()).revision,
      other: (await config(otherClusterId)).revision,
    };
    const pages = {
      unknownHost: "<h1>{{host}} is not served here</h1>",
      siteDisabled: "",
      siteSuspended: "<h1>suspended</h1><p>{{request_id}}</p>",
    };
    expect(await admin.settings.setErrorPages(pages)).toEqual(pages);
    expect(await admin.settings.errorPages()).toEqual(pages);
    for (const [cluster, revision] of [
      [clusterId, before.main],
      [otherClusterId, before.other],
    ] as const) {
      const current = await config(cluster);
      expect(current.revision).toBeGreaterThan(revision);
      expect(current.platformErrorPages).toMatchObject(pages);
      // Platform pages need no feature: nodes without them keep their built-in pages.
      expect(current.requiredFeatures).not.toContain("error-pages-v1");
      expect(await latestRevision(ctx.db, cluster)).toMatchObject({
        reasonCode: "error_pages_updated",
      });
    }
    const audit = (await audits("system.error_pages_update")).at(-1);
    expect(audit?.metadata).toMatchObject({
      changed: ["unknownHost", "siteSuspended"],
      bytes: { unknownHost: 36, siteDisabled: 0, siteSuspended: 39 },
    });
    // Saving the same pages publishes nothing new.
    const same = (await config()).revision;
    await admin.settings.setErrorPages(pages);
    expect((await config()).revision).toBe(same);
  });

  it("ships the domains of disabled and suspended sites as offline hosts with the reason", async () => {
    await owner.sites.setEnabled({ id: siteId, enabled: false });
    let current = await config();
    expect(current.sites.find((s) => s.id === siteId)).toBeUndefined();
    expect(current.offlineHosts.map((h) => [h.name, h.wildcard, h.reason])).toEqual([
      ["cdn.store.test", true, "disabled"],
      ["www.store.test", false, "disabled"],
    ]);
    // Suspension wins over disabling.
    await admin.admin.sites.suspend({ id: siteId, reason: "abuse" });
    current = await config();
    expect(current.offlineHosts.map((h) => h.reason)).toEqual(["suspended", "suspended"]);
    await owner.sites.setEnabled({ id: siteId, enabled: true });
    expect((await config()).offlineHosts.map((h) => h.reason)).toEqual(["suspended", "suspended"]);
    await admin.admin.sites.resume({ id: siteId });
    current = await config();
    expect(current.offlineHosts).toEqual([]);
    expect(current.sites.find((s) => s.id === siteId)).toBeDefined();
    // Offline hosts need no feature either.
    expect(current.requiredFeatures).not.toContain("error-pages-v1");
  });

  it("rolls back with the current platform pages and offline hosts and recomputes the features", async () => {
    await owner.errorPages.update({
      id: siteId,
      pages: [{ status: 429, template: "<p>slow</p>" }],
    });
    await owner.sites.update({ id: siteId, originSettings: { activeHealthCheck: healthCheck } });
    const target = await config();
    expect(target.requiredFeatures).toEqual(
      expect.arrayContaining(["active-health-v1", "error-pages-v1"]),
    );
    await owner.errorPages.update({ id: siteId, pages: [] });
    await owner.sites.update({
      id: siteId,
      originSettings: { activeHealthCheck: { ...healthCheck, enabled: false } },
    });
    const newer = { unknownHost: "<p>newer</p>", siteDisabled: "<p>off</p>", siteSuspended: "" };
    await admin.settings.setErrorPages(newer);
    await outsider.sites.setEnabled({ id: otherSiteId, enabled: false });
    await admin.clusters.rollback({ id: clusterId, revision: Number(target.revision) });
    let restored = await config();
    // Site content comes back with its features ...
    expect(restored.sites.find((s) => s.id === siteId)?.errorPages?.pages[0]?.status).toBe(429);
    expect(
      restored.sites.find((s) => s.id === siteId)?.originPool?.activeHealthCheck,
    ).toBeDefined();
    expect(restored.requiredFeatures).toEqual(
      expect.arrayContaining(["active-health-v1", "error-pages-v1"]),
    );
    // ... platform pages and offline hosts are the current ones.
    expect(restored.platformErrorPages).toMatchObject(newer);
    expect(restored.sites.find((s) => s.id === otherSiteId)).toBeUndefined();
    expect(restored.offlineHosts.map((h) => [h.name, h.reason])).toEqual([
      ["www.rival.test", "disabled"],
    ]);
    // A site that is offline now leaves its features behind.
    await owner.sites.setEnabled({ id: siteId, enabled: false });
    await admin.clusters.rollback({ id: clusterId, revision: Number(target.revision) });
    restored = await config();
    expect(restored.sites.find((s) => s.id === siteId)).toBeUndefined();
    expect(restored.requiredFeatures).not.toContain("active-health-v1");
    expect(restored.requiredFeatures).not.toContain("error-pages-v1");
    expect(restored.offlineHosts.map((h) => h.name)).toEqual([
      "cdn.store.test",
      "www.rival.test",
      "www.store.test",
    ]);
    await owner.sites.setEnabled({ id: siteId, enabled: true });
    await outsider.sites.setEnabled({ id: otherSiteId, enabled: true });
    await admin.settings.setErrorPages({ unknownHost: "", siteDisabled: "", siteSuspended: "" });
    expect((await config()).platformErrorPages).toBeUndefined();
  });

  it("reports passive and active origin health per node and counts a node down once", async () => {
    const site = await member.sites.get({ id: siteId });
    const [primary, backup] = site.origins;
    if (!primary || !backup) throw new Error("origins missing");
    const node = { id: nodeId, clusterId };
    await ctx.db
      .update(schema.node)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.node.id, nodeId));
    const failedAt = new Date();
    const entry = (
      originId: string,
      source: "passive" | "active" | undefined,
      healthy: boolean,
      lastError: string,
    ) => ({
      siteId,
      originId,
      source,
      healthy,
      consecutiveFailures: healthy ? 1 : 4,
      lastError,
      lastErrorCode: "upstream_status",
      lastErrorParams: { status: "503" },
      lastFailureAt: failedAt,
      downUntil: source === "active" ? null : new Date(failedAt.getTime() + 30_000),
    });
    expect(
      await replaceOriginHealth(ctx.db, node, [
        entry(primary.id, "passive", false, "HTTP 503"),
        entry(primary.id, "active", false, "probe HTTP 503"),
        // Only the first entry per origin and check is kept.
        entry(primary.id, "active", true, "ignored"),
        // Entries without a source come from nodes before G4: passive.
        entry(backup.id, undefined, true, "one failure"),
        entry(backup.id, "active", false, "probe timeout"),
      ]),
    ).toBe(4);
    const health = await member.sites.originHealth({ id: siteId });
    const of = (id: string) => health.find((h) => h.originId === id);
    expect(of(primary.id)?.downNodes).toBe(1);
    expect(of(primary.id)?.nodes.map((n) => [n.source, n.healthy])).toEqual([
      ["active", false],
      ["passive", false],
    ]);
    expect(of(primary.id)?.nodes.find((n) => n.source === "active")?.downUntil).toBeNull();
    // The backup is down on the node through its active check only.
    expect(of(backup.id)?.downNodes).toBe(1);
    expect(of(backup.id)?.nodes.map((n) => [n.source, n.healthy])).toEqual([
      ["active", false],
      ["passive", true],
    ]);
    // Every origin is unavailable on a member node: the alert holds, from either check.
    await sweepAlerts(ctx);
    const state = async () =>
      (
        await ctx.db
          .select()
          .from(schema.alertState)
          .where(
            and(
              eq(schema.alertState.siteId, siteId),
              eq(schema.alertState.kind, "origin_unavailable"),
            ),
          )
      )[0]?.active;
    expect(await state()).toBe(true);
    // Active checks recover the backup: one origin is left, the alert resolves.
    await replaceOriginHealth(ctx.db, node, [entry(primary.id, "active", false, "probe HTTP 503")]);
    await sweepAlerts(ctx);
    expect(await state()).toBe(false);
    await replaceOriginHealth(ctx.db, node, []);
  });
});
