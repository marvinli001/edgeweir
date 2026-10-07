import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { CacheKeyQuery } from "@edgeweir/proto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { updateSiteMaintenance } from "../../src/server/services/maintenance";
import { latestRevision } from "../../src/server/services/revisions";
import { updateSite } from "../../src/server/services/sites";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const BASE_FEATURES = ["rules-v1", "tls-v1", "access-logs-v1", "error-pages-v1", "rules-v2"];
const G15_FEATURES = [...BASE_FEATURES, "site-content-v1", "cache-zone-v1"];
const PURGE_KEY = "purge-key-0123456789abcdef";

/** A change without the operator behind it (service accounts, background jobs). */
const service = {
  actor: { type: "service_account" as const, id: "service-account-g15", name: "integration" },
};

describe("cache, origin and content settings (site-content-v1, cache-zone-v1) on the console side", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let siteId: string;
  let nodeId: string;
  const api = (key: string, method: string, path: string, body?: unknown) =>
    app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const revisionRow = () => latestRevision(ctx.db, clusterId);
  const config = async () => decodeNodeConfig((await revisionRow())?.ir ?? new Uint8Array());
  const siteOf = async () => (await config()).sites.find((site) => site.id === siteId);
  const setNodeFeatures = (features: string[]) =>
    ctx.db
      .update(schema.node)
      .set({ supportedFeatures: features })
      .where(eq(schema.node.id, nodeId));
  const audits = (action: string) =>
    ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = (
      await admin.sites.create({
        name: "shop",
        domains: ["www.shop.test"],
        origins: [{ address: "origin-a.shop.test" }],
        cacheRules: [{ pathPrefixes: ["/"] }],
      })
    ).site.id;
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-g15",
        supportedFeatures: G15_FEATURES,
        enrolledAt: new Date(Date.now() - 86_400_000),
        lastSeenAt: new Date(),
      })
      .returning();
    if (!node) throw new Error("node missing");
    nodeId = node.id;
  });
  afterAll(() => pglite.close());

  it("keeps the configuration as it was until a setting is used", async () => {
    const site = await admin.sites.get({ id: siteId });
    expect(site.cacheSettings).toMatchObject({
      xCache: true,
      purgeMethod: { enabled: false, keySet: false },
    });
    expect(site.contentSettings).toEqual({
      charset: { name: "off", force: false, uppercase: false },
      requestBodyLimit: 104_857_600,
    });
    expect(site.originSettings).toMatchObject({ tries: 3, statusRetry: true });
    expect((await admin.clusters.get({ id: clusterId })).cache).toEqual({
      maxSizeGb: 10,
      inactiveDays: 7,
    });
    const current = await config();
    expect(current.requiredFeatures).not.toContain("site-content-v1");
    expect(current.requiredFeatures).not.toContain("cache-zone-v1");
    expect(current.cacheZones).toMatchObject([
      {
        name: "default",
        maxSizeMb: 10240n,
        keysZoneMb: 64,
        inactiveSeconds: 604_800,
        nodeSizes: [],
      },
    ]);
    const compiled = await siteOf();
    expect(compiled?.requestBodyLimit).toBeUndefined();
    expect(compiled?.purge).toBeUndefined();
  });

  it("sizes the cluster's cache zone and a node's own, with keys zones derived from the size", async () => {
    const cluster = await admin.clusters.setCache({
      id: clusterId,
      maxSizeGb: 100,
      inactiveDays: 30,
    });
    expect(cluster.cache).toEqual({ maxSizeGb: 100, inactiveDays: 30 });
    let zone = (await config()).cacheZones[0];
    expect(zone).toMatchObject({
      maxSizeMb: 102_400n,
      keysZoneMb: 512,
      inactiveSeconds: 2_592_000,
    });
    expect((await config()).requiredFeatures).not.toContain("cache-zone-v1");
    expect(await revisionRow()).toMatchObject({ reasonCode: "cluster_cache_updated" });
    expect((await audits("cluster.cache_update")).at(-1)?.metadata).toMatchObject({
      from: { maxSizeGb: 10, inactiveDays: 7 },
      to: { maxSizeGb: 100, inactiveDays: 30 },
    });

    const node = await admin.nodes.setCache({ id: nodeId, maxSizeGb: 2 });
    expect(node.cache).toEqual({ maxSizeGb: 2, usage: null });
    zone = (await config()).cacheZones[0];
    expect(zone?.nodeSizes).toMatchObject([{ nodeId, maxSizeMb: 2048n, keysZoneMb: 16 }]);
    expect((await config()).requiredFeatures).toContain("cache-zone-v1");
    expect(await revisionRow()).toMatchObject({
      reasonCode: "node_cache_updated",
      reasonParams: { node: "edge-g15" },
    });
    expect((await audits("node.cache_update")).at(-1)?.metadata).toMatchObject({
      from: null,
      to: 2,
    });

    await admin.nodes.setCache({ id: nodeId, maxSizeGb: null });
    expect((await config()).cacheZones[0]?.nodeSizes).toEqual([]);
    expect((await config()).requiredFeatures).not.toContain("cache-zone-v1");
    for (const input of [{ maxSizeGb: 0 }, { maxSizeGb: 65_537 }])
      expect((await rpcError(admin.nodes.setCache({ id: nodeId, ...input }))).status).toBe(400);
    await admin.clusters.setCache({ id: clusterId, maxSizeGb: 10, inactiveDays: 7 });
  });

  it("stores the PURGE key sealed, never returns or audits it, and rotates it", async () => {
    expect(
      await rpcError(
        admin.sites.update({ id: siteId, cacheSettings: { purgeMethod: { enabled: true } } }),
      ),
    ).toMatchObject({ code: "PURGE_KEY_REQUIRED", status: 400 });
    const saved = await admin.sites.update({
      id: siteId,
      cacheSettings: { purgeMethod: { enabled: true, key: PURGE_KEY } },
    });
    expect(JSON.stringify(saved)).not.toContain(PURGE_KEY);
    expect(saved.site.cacheSettings.purgeMethod).toEqual({ enabled: true, keySet: true });
    const [secret] = await ctx.db
      .select()
      .from(schema.siteSecret)
      .where(eq(schema.siteSecret.siteId, siteId));
    expect(secret).toMatchObject({ kind: "purge_key", version: 1 });
    expect(secret?.secretEnvelope).not.toContain(PURGE_KEY);
    expect(
      ctx.masterKey
        .open(JSON.parse(secret?.secretEnvelope ?? "{}"), {
          purpose: "site_secret.secret_envelope",
          recordId: secret?.id ?? "",
        })
        .toString(),
    ).toBe(PURGE_KEY);
    // The configuration names the key, never holds it.
    const row = await revisionRow();
    expect(Buffer.from(row?.ir ?? new Uint8Array()).toString("latin1")).not.toContain(PURGE_KEY);
    expect((await siteOf())?.purge).toMatchObject({
      credentialId: secret?.id,
      credentialVersion: 1n,
    });
    expect((await config()).requiredFeatures).toContain("site-content-v1");
    const audit = (await audits("site.update")).at(-1);
    expect(JSON.stringify(audit)).not.toContain(PURGE_KEY);
    expect(audit?.metadata).toMatchObject({
      cacheSettings: { purgeMethod: { enabled: true, keyChanged: true } },
    });
    // Saving without a key keeps it; a new key is the next version.
    await admin.sites.update({ id: siteId, cacheSettings: { purgeMethod: { enabled: true } } });
    expect((await siteOf())?.purge?.credentialVersion).toBe(1n);
    await admin.sites.update({
      id: siteId,
      cacheSettings: { purgeMethod: { enabled: true, key: `${PURGE_KEY}-2` } },
    });
    expect((await siteOf())?.purge?.credentialVersion).toBe(2n);
    // Off: no reference, the key stays for later.
    await admin.sites.update({ id: siteId, cacheSettings: { purgeMethod: { enabled: false } } });
    expect((await siteOf())?.purge).toBeUndefined();
    expect((await admin.sites.get({ id: siteId })).cacheSettings.purgeMethod).toEqual({
      enabled: false,
      keySet: true,
    });
  });

  it("compiles X-Cache, charsets, body limits, origin tries, excluded parameters and Set-Cookie caching", async () => {
    await admin.sites.update({
      id: siteId,
      cacheSettings: {
        xCache: false,
        cacheKey: { query: "exclude", queryParams: ["utm_*", "fbclid"] },
      },
      contentSettings: {
        charset: { name: "gbk", force: true, uppercase: true },
        requestBodyLimit: 0,
      },
      originSettings: { tries: 5, statusRetry: false },
      cacheRules: [{ pathPrefixes: ["/account/"], cacheSetCookie: true }, { pathPrefixes: ["/"] }],
    });
    const site = await admin.sites.get({ id: siteId });
    expect(site.cacheSettings.xCache).toBe(false);
    expect(site.cacheSettings.cacheKey.query).toBe("exclude");
    expect(site.contentSettings).toEqual({
      charset: { name: "gbk", force: true, uppercase: true },
      requestBodyLimit: 0,
    });
    expect(site.originSettings).toMatchObject({ tries: 5, statusRetry: false });
    expect(site.cacheRules.map((rule) => rule.cacheSetCookie)).toEqual([true, false]);
    const compiled = await siteOf();
    expect(compiled?.hideXCache).toBe(true);
    expect(compiled?.charset).toMatchObject({ name: "gbk", force: true, uppercase: true });
    expect(compiled?.requestBodyLimit).toBe(0n);
    expect(compiled?.originPool).toMatchObject({ tries: 5, statusRetryDisabled: true });
    expect(compiled?.cacheKey).toMatchObject({
      query: CacheKeyQuery.EXCLUDE,
      queryParams: ["fbclid", "utm_*"],
    });
    expect(compiled?.cacheRules.map((rule) => rule.cacheSetCookie)).toEqual([true, false]);
    expect((await config()).requiredFeatures).toContain("site-content-v1");
    // Pool settings without tries and status retries keep them, like protocol and gRPC.
    await admin.sites.update({ id: siteId, originSettings: { policy: "round_robin" } });
    expect((await admin.sites.get({ id: siteId })).originSettings).toMatchObject({
      policy: "round_robin",
      tries: 5,
      statusRetry: false,
    });
    // Back to the defaults: no site-content-v1.
    await admin.sites.update({
      id: siteId,
      cacheSettings: { xCache: true, cacheKey: {} },
      contentSettings: {},
      originSettings: { tries: 3, statusRetry: true },
      cacheRules: [{ pathPrefixes: ["/"] }],
    });
    expect((await config()).requiredFeatures).not.toContain("site-content-v1");
    expect((await siteOf())?.requestBodyLimit).toBeUndefined();
  });

  it("compiles the gzip level, the largest compressed response and config rules' body limits", async () => {
    const https = await admin.https.get({ id: siteId });
    await admin.https.update({
      id: siteId,
      settings: { ...https, gzipLevel: 6, compressMaxLength: 8_388_608 },
    });
    expect((await admin.https.get({ id: siteId })).gzipLevel).toBe(6);
    expect((await siteOf())?.tls).toMatchObject({ gzipLevel: 6, compressMaxLength: 8_388_608n });
    expect((await config()).requiredFeatures).toContain("site-content-v1");
    await admin.https.update({
      id: siteId,
      settings: { ...https, gzipLevel: 0, compressMaxLength: 0 },
    });
    expect((await config()).requiredFeatures).not.toContain("site-content-v1");
    for (const settings of [{ gzipLevel: 10 }, { compressMaxLength: -1 }])
      expect(
        (await rpcError(admin.https.update({ id: siteId, settings: { ...https, ...settings } })))
          .status,
      ).toBe(400);

    const saved = await admin.rules.save({
      id: siteId,
      rules: [
        {
          name: "uploads",
          phase: "config",
          enabled: true,
          expression: 'starts_with(http.request.uri.path, "/upload/")',
          action: { kind: "config", requestBodyLimit: 1024 * 1024 * 1024 },
        },
      ],
    });
    expect(saved[0]?.action).toMatchObject({ kind: "config", requestBodyLimit: 1_073_741_824 });
    expect((await siteOf())?.rules[0]?.action?.requestBodyLimit).toBe(1_073_741_824n);
    expect((await config()).requiredFeatures).toContain("site-content-v1");
    // Only the config phase takes it.
    expect(
      (
        await rpcError(
          admin.rules.save({
            id: siteId,
            rules: [
              {
                name: "cached",
                phase: "cache",
                enabled: true,
                expression: "true",
                action: { kind: "config", requestBodyLimit: 1 },
              },
            ],
          }),
        )
      ).status,
    ).toBe(400);
    await admin.rules.save({ id: siteId, rules: [] });
    expect((await config()).requiredFeatures).not.toContain("site-content-v1");
  });

  it("saves error pages of classes, redirects and replacement statuses", async () => {
    const saved = await admin.errorPages.update({
      id: siteId,
      pages: [
        { status: "5xx", redirectUrl: "https://status.shop.test/?s={{status}}&id={{request_id}}" },
        { status: 404, template: "<p>没有</p>", responseStatus: 200 },
        { status: "4xx", template: "<p>{{status}}</p>" },
      ],
      interceptOriginErrors: true,
    });
    expect(saved.pages.map((page) => page.status)).toEqual(["4xx", "5xx", 404]);
    expect(await admin.errorPages.get({ id: siteId })).toEqual(saved);
    const pages = (await siteOf())?.errorPages?.pages ?? [];
    expect(
      pages.map((p) => [p.status, p.template !== "", p.redirectUrl, p.responseStatus]),
    ).toEqual([
      [4, true, "", 0],
      [5, false, "https://status.shop.test/?s={{status}}&id={{request_id}}", 0],
      [404, true, "", 200],
    ]);
    expect((await config()).requiredFeatures).toEqual(
      expect.arrayContaining(["error-pages-v1", "site-content-v1"]),
    );
    expect((await audits("site.error_pages_update")).at(-1)?.metadata).toMatchObject({
      to: { statuses: ["4xx", "5xx", 404] },
      redirects: ["5xx"],
    });
    expect(
      await rpcError(
        admin.errorPages.update({
          id: siteId,
          pages: [{ status: 404, redirectUrl: "//evil.test/" }],
        }),
      ),
    ).toMatchObject({ status: 400 });
    // A class page over the size limit is named by its class, not the stored 4 / 5.
    expect(
      await rpcError(
        admin.errorPages.update({
          id: siteId,
          pages: [{ status: "4xx", template: "a".repeat(65_537) }],
        }),
      ),
    ).toMatchObject({ code: "ERROR_PAGE_TOO_LARGE", data: { status: "4xx" } });
    await admin.errorPages.update({ id: siteId, pages: [] });
    expect((await config()).requiredFeatures).not.toContain("site-content-v1");
  });

  it("turns maintenance on and off, keeps its settings, audits it without the page", async () => {
    expect(await admin.maintenance.get({ id: siteId })).toEqual({
      siteId,
      enabled: false,
      template: "",
      retryAfterSeconds: 0,
      allowedCidrs: [],
      allowedPathPrefixes: [],
      updatedAt: null,
    });
    const on = await admin.maintenance.update({
      id: siteId,
      enabled: true,
      template: "<h1>维护中 {{request_id}}</h1>",
      retryAfterSeconds: 600,
      allowedCidrs: ["198.51.100.7/24", "2001:DB8::/32"],
      allowedPathPrefixes: ["/health"],
    });
    expect(on).toMatchObject({
      enabled: true,
      allowedCidrs: ["198.51.100.0/24", "2001:db8::/32"],
      retryAfterSeconds: 600,
    });
    expect((await siteOf())?.maintenance).toMatchObject({
      template: "<h1>维护中 {{request_id}}</h1>",
      retryAfterSeconds: 600,
      allowedCidrs: ["198.51.100.0/24", "2001:db8::/32"],
      allowedPathPrefixes: ["/health"],
    });
    expect((await config()).requiredFeatures).toContain("site-content-v1");
    expect(await revisionRow()).toMatchObject({
      reasonCode: "site_maintenance_updated",
      reasonParams: { site: "shop" },
    });
    const audit = (await audits("site.maintenance_update")).at(-1);
    expect(JSON.stringify(audit?.metadata)).not.toContain("维护中");
    expect(audit?.metadata).toMatchObject({
      from: { enabled: false },
      to: { enabled: true, templateBytes: Buffer.byteLength(on.template) },
    });
    // A stale expectedUpdatedAt is refused.
    expect(
      await rpcError(
        admin.maintenance.update({
          id: siteId,
          enabled: false,
          expectedUpdatedAt: new Date(Date.parse(on.updatedAt ?? "") - 1000).toISOString(),
        }),
      ),
    ).toMatchObject({ code: "UPDATED_AT_MISMATCH", status: 409 });
    expect(
      await rpcError(
        admin.maintenance.update({ id: siteId, enabled: true, template: "维".repeat(30_000) }),
      ),
    ).toMatchObject({ code: "ERROR_PAGE_TOO_LARGE", data: { status: 503 } });
    const off = await admin.maintenance.update({
      id: siteId,
      enabled: false,
      template: on.template,
      retryAfterSeconds: 600,
      allowedCidrs: on.allowedCidrs,
      allowedPathPrefixes: on.allowedPathPrefixes,
      expectedUpdatedAt: on.updatedAt ?? undefined,
    });
    expect(off).toMatchObject({ enabled: false, template: on.template });
    expect((await siteOf())?.maintenance).toBeUndefined();
    expect((await config()).requiredFeatures).not.toContain("site-content-v1");
  });

  it("holds the settings for changes without the operator while a node lacks site-content-v1", async () => {
    await setNodeFeatures(BASE_FEATURES);
    try {
      expect((await admin.sites.features({ id: siteId })).siteContent).toEqual({
        available: false,
        reason: "nodes",
      });
      const before = (await revisionRow())?.revision;
      expect(
        await rpcError(
          updateSiteMaintenance(
            ctx.db,
            {
              id: siteId,
              enabled: true,
              template: "",
              retryAfterSeconds: 0,
              allowedCidrs: [],
              allowedPathPrefixes: [],
            },
            service,
          ),
        ),
      ).toMatchObject({ code: "NODE_CAPABILITY_REQUIRED" });
      expect(
        await rpcError(
          updateSite(
            ctx.db,
            {
              id: siteId,
              contentSettings: {
                charset: { name: "utf-8", force: false, uppercase: false },
                requestBodyLimit: 104_857_600,
              },
            },
            { ...service, masterKey: ctx.masterKey },
          ),
        ),
      ).toMatchObject({ code: "NODE_CAPABILITY_REQUIRED" });
      expect((await revisionRow())?.revision).toBe(before);
      // The operator may require it (nodes keep their last-known-good configuration).
      await admin.sites.update({ id: siteId, cacheSettings: { xCache: false } });
      expect((await config()).requiredFeatures).toContain("site-content-v1");
      await admin.sites.update({ id: siteId, cacheSettings: { xCache: true } });
    } finally {
      await setNodeFeatures(G15_FEATURES);
    }
  });

  it("lets read-only AccessKeys read but not write, and keeps service accounts out", async () => {
    const reader = await admin.accessKeys.create({ name: "g15-read", scope: "read" });
    expect((await api(reader.key, "GET", `/sites/${siteId}/maintenance`)).status).toBe(200);
    for (const [method, path, payload] of [
      ["PUT", `/sites/${siteId}/maintenance`, { enabled: true }],
      ["PUT", `/clusters/${clusterId}/cache`, { maxSizeGb: 20, inactiveDays: 7 }],
      ["PUT", `/nodes/${nodeId}/cache`, { maxSizeGb: 5 }],
      [
        "PATCH",
        `/sites/${siteId}`,
        { cacheSettings: { purgeMethod: { enabled: true, key: PURGE_KEY } } },
      ],
    ] as const) {
      const refused = await api(reader.key, method, path, payload);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "ACCESS_KEY_READ_ONLY" });
    }
    const writer = await admin.accessKeys.create({ name: "g15-write", scope: "write" });
    const res = await api(writer.key, "PUT", `/clusters/${clusterId}/cache`, {
      maxSizeGb: 20,
      inactiveDays: 3,
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { cache: unknown }).cache).toEqual({
      maxSizeGb: 20,
      inactiveDays: 3,
    });
    expect(
      (await api(writer.key, "PUT", `/sites/${siteId}/maintenance`, { enabled: false })).status,
    ).toBe(200);
    expect(
      (await api(writer.key, "PUT", `/nodes/${nodeId}/cache`, { maxSizeGb: null })).status,
    ).toBe(200);
    const account = await admin.serviceAccounts.create({
      name: "integration-g15",
      scopes: ["sites:read", "sites:write", "clusters:read"],
    });
    const { secret } = await admin.serviceAccounts.createKey({ id: account.id });
    for (const [method, path, payload] of [
      ["GET", `/sites/${siteId}/maintenance`, undefined],
      ["PUT", `/sites/${siteId}/maintenance`, { enabled: false }],
      ["PUT", `/clusters/${clusterId}/cache`, { maxSizeGb: 20, inactiveDays: 7 }],
      ["PUT", `/nodes/${nodeId}/cache`, { maxSizeGb: 5 }],
    ] as const) {
      const refused = await api(secret, method, path, payload);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "SERVICE_ACCOUNT_FORBIDDEN" });
    }
    await admin.clusters.setCache({ id: clusterId, maxSizeGb: 10, inactiveDays: 7 });
  });
});
