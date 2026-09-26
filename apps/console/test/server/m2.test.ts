import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { CacheKeyQuery } from "@edgeweir/proto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  expireCacheTasks,
  pullCacheTasks,
  reportCacheTaskResult,
} from "../../src/server/services/cache-tasks";
import { replaceOriginHealth } from "../../src/server/services/origin-health";
import { latestRevision } from "../../src/server/services/revisions";
import { s3SecretBinding } from "../../src/server/services/sites";
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

describe("M2 origins, cache settings and cache tasks", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let tenant: ApiClient;
  let other: ApiClient;
  let clusterA: string;
  let clusterB: string;

  const addNode = async (clusterId: string, name: string) => {
    const [row] = await ctx.db
      .insert(schema.node)
      .values({ clusterId, name, lastSeenAt: new Date() })
      .returning();
    if (!row) throw new Error("node insert failed");
    return row;
  };

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterA = (await admin.clusters.list())[0]?.id ?? "";
    clusterB = (await admin.clusters.create({ name: "edge-b" })).id;
    const tenantOrg = await admin.organizations.create({
      name: "Tenant",
      defaultClusterId: clusterB,
    });
    const otherOrg = await admin.organizations.create({
      name: "Other",
      defaultClusterId: clusterB,
    });
    await admin.users.create({
      name: "Tina Tenant",
      email: "tina@tenant.test",
      password: PASSWORD,
      organizationId: tenantOrg.id,
    });
    await admin.users.create({
      name: "Otto Other",
      email: "otto@other.test",
      password: PASSWORD,
      organizationId: otherOrg.id,
    });
    tenant = rpcClient(app, origin, await signIn(app, origin, "tina@tenant.test"));
    other = rpcClient(app, origin, await signIn(app, origin, "otto@other.test"));
  });
  afterAll(() => pglite.close());

  it("stores origin settings, cache settings and new rule conditions and compiles them", async () => {
    const { site, revision: pendingRevision } = await tenant.sites.create({
      name: "assets",
      domains: ["assets.test", "*.cdn.test"],
      origins: [
        { address: "origin-a", port: 443, scheme: "https", sni: "origin-a.example.com" },
        { address: "origin-b", backup: true, hostHeader: "b.internal" },
      ],
      originSettings: {
        policy: "consistent_hash",
        tlsVerify: false,
        maxFails: 2,
        recoverySeconds: 5,
        connectTimeoutMs: 1500,
        websocket: false,
      },
      cacheSettings: {
        cacheKey: {
          query: "include",
          queryParams: ["v", "lang"],
          sortQuery: true,
          deviceType: true,
        },
        rangeSlice: true,
      },
      cacheRules: [
        {
          paths: ["/index.html"],
          statusCodes: [404, 200],
          maxSizeBytes: 1024,
          staleWhileRevalidateSeconds: 30,
          staleIfErrorSeconds: 600,
        },
      ],
    });
    const revision = await approveSiteDomains(admin, site.id);
    expect(revision.revision).toBeGreaterThan(pendingRevision.revision);
    expect(site.originSettings).toMatchObject({
      policy: "consistent_hash",
      tlsVerify: false,
      maxFails: 2,
      recoverySeconds: 5,
      connectTimeoutMs: 1500,
      readTimeoutMs: 60_000,
      keepalive: true,
      websocket: false,
    });
    expect(site.cacheSettings.cacheKey).toMatchObject({ query: "include", sortQuery: true });
    expect(site.cacheSettings.rangeSlice).toBe(true);
    expect(site.origins[0]).toMatchObject({ sni: "origin-a.example.com", s3: null });
    expect(site.cacheRules[0]).toMatchObject({ paths: ["/index.html"], maxSizeBytes: 1024 });

    const row = await latestRevision(ctx.db, clusterB);
    expect(row?.revision).toBe(revision.revision);
    const ir = decodeNodeConfig(row?.ir ?? new Uint8Array());
    const compiled = ir.sites.find((s) => s.id === site.id);
    expect(compiled?.originPool?.skipTlsVerify).toBe(true);
    expect(compiled?.originPool?.healthCheck).toMatchObject({ maxFails: 2, recoverySeconds: 5 });
    expect(compiled?.originPool?.connection?.connectTimeoutMs).toBe(1500);
    expect(compiled?.websocketDisabled).toBe(true);
    expect(compiled?.rangeSlice).toBe(true);
    expect(compiled?.cacheKey?.query).toBe(CacheKeyQuery.INCLUDE);
    // Lists without meaning in their order are sorted for a stable hash.
    expect(compiled?.cacheKey?.queryParams).toEqual(["lang", "v"]);
    expect(compiled?.cacheRules[0]?.match?.statusCodes).toEqual([200, 404]);
    expect(compiled?.cacheRules[0]?.staleIfErrorSeconds).toBe(600);

    // Saving only the cache settings keeps the rest.
    const updated = await tenant.sites.update({
      id: site.id,
      cacheSettings: { cacheKey: { query: "ignore" }, rangeSlice: false },
    });
    expect(updated.site.cacheSettings.cacheKey.query).toBe("ignore");
    expect(updated.site.originSettings.policy).toBe("consistent_hash");
    expect(updated.revision.revision).toBe(revision.revision + 1);
  });

  it("stores cacheAuthorized per rule (off by default) and compiles it", async () => {
    const { site } = await tenant.sites.create({
      name: "api",
      domains: ["api.test"],
      origins: [{ address: "origin-api" }],
      cacheRules: [
        {
          priority: 10,
          pathPrefixes: ["/public/"],
          originCacheControl: "respect",
          cacheAuthorized: true,
        },
        { priority: 20, pathPrefixes: ["/"] },
      ],
    });
    await approveSiteDomains(admin, site.id);
    expect(site.cacheRules.map((r) => r.cacheAuthorized)).toEqual([true, false]);
    const compiled = async () =>
      decodeNodeConfig((await latestRevision(ctx.db, clusterB))?.ir ?? new Uint8Array()).sites.find(
        (s) => s.id === site.id,
      );
    expect(
      (await compiled())?.cacheRules.map((r) => [r.match?.pathPrefixes[0], r.cacheAuthorized]),
    ).toEqual([
      ["/public/", true],
      ["/", false],
    ]);

    const updated = await tenant.sites.update({
      id: site.id,
      cacheRules: [{ pathPrefixes: ["/public/"], originCacheControl: "respect" }],
    });
    expect(updated.site.cacheRules[0]?.cacheAuthorized).toBe(false);
    expect((await compiled())?.cacheRules[0]?.cacheAuthorized).toBe(false);
  });

  it("keeps S3 secrets encrypted, write-only and versioned", async () => {
    const created = await tenant.sites.create({
      name: "bucket",
      domains: ["bucket.test"],
      origins: [
        {
          address: "minio",
          port: 9000,
          s3: {
            region: "us-east-1",
            bucket: "assets",
            accessKeyId: "AKIDTENANT",
            secretAccessKey: "s3cr3t-value",
          },
        },
      ],
    });
    await approveSiteDomains(admin, created.site.id);
    expect(created.site.origins[0]?.s3).toEqual({
      region: "us-east-1",
      bucket: "assets",
      accessKeyId: "AKIDTENANT",
    });
    expect(JSON.stringify(created)).not.toContain("s3cr3t-value");
    const [credential] = await ctx.db
      .select()
      .from(schema.originCredential)
      .where(eq(schema.originCredential.siteId, created.site.id));
    expect(credential?.version).toBe(1);
    expect(credential?.secretEnvelope).not.toContain("s3cr3t-value");
    expect(JSON.parse(credential?.secretEnvelope ?? "{}").alg).toBe("A256GCM");
    const audit = await ctx.db.select().from(schema.auditLog);
    expect(JSON.stringify(audit)).not.toContain("s3cr3t-value");

    // Saving without the secret keeps the credential; a new secret rotates it.
    const kept = await tenant.sites.update({
      id: created.site.id,
      origins: [
        {
          address: "minio",
          port: 9000,
          s3: { region: "us-east-1", bucket: "assets", accessKeyId: "AKIDTENANT" },
        },
      ],
    });
    expect(kept.site.origins[0]?.s3?.accessKeyId).toBe("AKIDTENANT");
    await tenant.sites.update({
      id: created.site.id,
      origins: [
        {
          address: "minio",
          port: 9000,
          s3: {
            region: "us-east-1",
            bucket: "assets",
            accessKeyId: "AKIDTENANT",
            secretAccessKey: "rotated",
          },
        },
      ],
    });
    const [rotated] = await ctx.db
      .select()
      .from(schema.originCredential)
      .where(eq(schema.originCredential.siteId, created.site.id));
    expect(rotated?.version).toBe(2);
    expect(
      ctx.masterKey
        .open(JSON.parse(rotated?.secretEnvelope ?? "{}"), s3SecretBinding(rotated?.id ?? ""))
        .toString(),
    ).toBe("rotated");

    const ir = decodeNodeConfig((await latestRevision(ctx.db, clusterB))?.ir ?? new Uint8Array());
    const s3 = ir.sites.find((s) => s.id === created.site.id)?.originPool?.origins[0]?.s3;
    expect(s3).toMatchObject({ region: "us-east-1", bucket: "assets", credentialId: rotated?.id });
    expect(s3?.credentialVersion).toBe(2n);

    // A new access key needs its secret.
    const missing = await rpcError(
      tenant.sites.update({
        id: created.site.id,
        origins: [{ address: "minio", s3: { region: "us-east-1", accessKeyId: "AKIDNEW" } }],
      }),
    );
    expect(missing.code).toBe("S3_SECRET_REQUIRED");
    expect(missing.data).toMatchObject({ accessKeyId: "AKIDNEW" });

    // Removing the S3 origin deletes the credential.
    await tenant.sites.update({ id: created.site.id, origins: [{ address: "origin.internal" }] });
    const left = await ctx.db
      .select()
      .from(schema.originCredential)
      .where(eq(schema.originCredential.siteId, created.site.id));
    expect(left).toHaveLength(0);
  });

  it("aggregates the passive origin health reported by online nodes", async () => {
    const node = await addNode(clusterB, "edge-b-1");
    const { site } = await tenant.sites.create({
      name: "health",
      domains: ["health.test"],
      origins: [{ address: "primary" }, { address: "backup", backup: true }],
    });
    const [primary, backup] = site.origins;
    const failedAt = new Date();
    const stored = await replaceOriginHealth(ctx.db, node, [
      {
        siteId: site.id,
        originId: primary?.id ?? "",
        healthy: false,
        consecutiveFailures: 3,
        lastError: "connect timeout",
        lastFailureAt: failedAt,
        downUntil: new Date(failedAt.getTime() + 30_000),
      },
      // Origins of other clusters and unknown ids are dropped.
      {
        siteId: site.id,
        originId: "00000000-0000-4000-8000-000000000000",
        healthy: false,
        consecutiveFailures: 1,
        lastError: "x",
        lastFailureAt: null,
        downUntil: null,
      },
    ]);
    expect(stored).toBe(1);
    const health = await tenant.sites.originHealth({ id: site.id });
    const p = health.find((h) => h.originId === primary?.id);
    const b = health.find((h) => h.originId === backup?.id);
    expect(p).toMatchObject({ downNodes: 1, lastError: "connect timeout" });
    expect(p?.nodes[0]).toMatchObject({
      nodeName: "edge-b-1",
      healthy: false,
      consecutiveFailures: 3,
    });
    expect(b).toMatchObject({ downNodes: 0, nodes: [] });
    expect(p?.onlineNodes).toBeGreaterThanOrEqual(1);

    // Editing the pool keeps the ids (and the health) of unchanged origins.
    const edited = await tenant.sites.update({
      id: site.id,
      origins: [
        { address: "added" },
        { address: "primary", weight: 5 },
        { address: "backup", backup: true },
      ],
    });
    expect(edited.site.origins.map((o) => o.address)).toEqual(["added", "primary", "backup"]);
    expect(edited.site.origins[1]).toMatchObject({ id: primary?.id, weight: 5 });
    expect(edited.site.origins[2]?.id).toBe(backup?.id);
    expect(edited.site.origins[0]?.id).not.toBe(primary?.id);
    const kept = await tenant.sites.originHealth({ id: site.id });
    expect(kept.find((h) => h.originId === primary?.id)?.downNodes).toBe(1);
    // A changed port is another origin.
    const moved = await tenant.sites.update({
      id: site.id,
      origins: [
        { address: "primary", port: 8080 },
        { address: "backup", backup: true },
      ],
    });
    expect(moved.site.origins[0]?.id).not.toBe(primary?.id);
    expect(moved.site.origins[1]?.id).toBe(backup?.id);

    // The next report without failures clears the state.
    await replaceOriginHealth(ctx.db, node, []);
    expect((await tenant.sites.originHealth({ id: site.id })).every((h) => h.downNodes === 0)).toBe(
      true,
    );
    // Another organization cannot read it.
    expect((await rpcError(other.sites.originHealth({ id: site.id }))).code).toBe("SITE_NOT_FOUND");
  });

  it("fans cache tasks out to the nodes of the site's cluster and tracks their results", async () => {
    const nodeB2 = await addNode(clusterB, "edge-b-2");
    await addNode(clusterA, "edge-a-1");
    await tenant.sites.create({
      name: "purge",
      domains: ["purge.test", "*.wild.test"],
      origins: [{ address: "whoami" }],
    });

    const task = await tenant.cacheTasks.create({
      type: "url",
      urls: [
        "http://purge.test/a/b.js?v=2&x=1#frag",
        "https://img.wild.test/logo.png",
        "http://purge.test/a/b.js?v=2&x=1",
      ],
    });
    expect(task.type).toBe("url");
    expect(task.targets).toEqual([
      "http://purge.test/a/b.js?v=2&x=1",
      "https://img.wild.test/logo.png",
    ]);
    expect(task.sites.map((s) => s.name)).toEqual(["purge"]);
    expect(task.state).toBe("pending");
    // Only nodes of cluster B (edge-b-1 from the previous test, edge-b-2), not edge-a-1.
    expect(task.nodes.map((n) => n.nodeName).sort()).toEqual(["edge-b-1", "edge-b-2"]);

    const [pulled] = await pullCacheTasks(ctx.db, nodeB2, 10);
    expect(pulled?.id).toBe(task.id);
    expect(pulled?.items).toEqual([
      expect.objectContaining({
        type: "url",
        host: "purge.test",
        path: "/a/b.js",
        query: "v=2&x=1",
      }),
      expect.objectContaining({ type: "url", host: "img.wild.test", path: "/logo.png", query: "" }),
    ]);
    // Handed out tasks are not handed out again right away.
    expect(await pullCacheTasks(ctx.db, nodeB2, 10)).toHaveLength(0);
    expect((await tenant.cacheTasks.get({ id: task.id })).state).toBe("running");

    await reportCacheTaskResult(ctx.db, nodeB2, {
      taskId: task.id,
      state: "succeeded",
      message: "",
      succeeded: 2,
      failed: 0,
      finishedAt: new Date(),
    });
    const [nodeB1] = await ctx.db
      .select()
      .from(schema.node)
      .where(eq(schema.node.name, "edge-b-1"));
    await reportCacheTaskResult(ctx.db, nodeB1 ?? { id: "" }, {
      taskId: task.id,
      state: "failed",
      message: "data plane unavailable",
      succeeded: 0,
      failed: 2,
      finishedAt: new Date(),
    });
    const done = await tenant.cacheTasks.get({ id: task.id });
    expect(done.state).toBe("failed");
    expect(done.finishedAt).not.toBeNull();
    expect(done.nodes.find((n) => n.nodeName === "edge-b-1")).toMatchObject({
      state: "failed",
      message: "data plane unavailable",
      failed: 2,
    });

    // Prefixes, whole sites and prefetch.
    const prefix = await tenant.cacheTasks.create({
      type: "prefix",
      urls: ["http://purge.test/static/"],
    });
    expect(prefix.targets).toEqual(["http://purge.test/static/"]);
    const whole = await tenant.cacheTasks.create({
      type: "site",
      siteIds: [task.sites[0]?.id ?? ""],
    });
    expect(whole.targets).toEqual(["purge"]);
    const prefetch = await tenant.cacheTasks.create({
      type: "prefetch",
      urls: ["http://purge.test/big.bin"],
    });
    const pulledAll = await pullCacheTasks(ctx.db, nodeB2, 10);
    expect(pulledAll.map((t) => t.type)).toEqual(["prefix", "site", "prefetch"]);
    expect(pulledAll[2]?.items[0]).toMatchObject({ url: "http://purge.test/big.bin" });
    expect(prefetch.state).toBe("pending");

    const list = await tenant.cacheTasks.list({});
    expect(list.total).toBe(4);
    expect(list.items[0]?.id).toBe(prefetch.id);
    const audit = await admin.auditLogs.list({ action: "cache.purge" });
    expect(audit.items[0]).toMatchObject({ actorName: "Tina Tenant", targetType: "cache_task" });
  });

  it("refuses bad URLs, foreign hosts and other organizations' tasks", async () => {
    const invalid = await rpcError(
      tenant.cacheTasks.create({ type: "url", urls: ["ftp://purge.test/x"] }),
    );
    expect(invalid.code).toBe("CACHE_TASK_URL_INVALID");
    const prefixQuery = await rpcError(
      tenant.cacheTasks.create({ type: "prefix", urls: ["http://purge.test/a?x=1"] }),
    );
    expect(prefixQuery.code).toBe("CACHE_TASK_URL_INVALID");
    const unknown = await rpcError(
      tenant.cacheTasks.create({ type: "url", urls: ["http://nope.test/"] }),
    );
    expect(unknown.code).toBe("CACHE_TASK_HOST_UNKNOWN");
    expect(unknown.data).toMatchObject({ hosts: "nope.test" });
    // purge.test belongs to Tenant: Other cannot purge it, list it or read its tasks.
    const foreign = await rpcError(
      other.cacheTasks.create({ type: "url", urls: ["http://purge.test/"] }),
    );
    expect(foreign.code).toBe("CACHE_TASK_HOST_UNKNOWN");
    expect((await other.cacheTasks.list({})).total).toBe(0);
    const [tenantTask] = (await tenant.cacheTasks.list({})).items;
    expect((await rpcError(other.cacheTasks.get({ id: tenantTask?.id ?? "" }))).code).toBe(
      "CACHE_TASK_NOT_FOUND",
    );
    // Platform administrators see every task; tenants still cannot reach the admin area.
    const adminList = await admin.cacheTasks.list({});
    expect(adminList.total).toBeGreaterThanOrEqual(4);
    expect((await rpcError(tenant.clusters.list())).status).toBe(403);
    expect((await rpcError(tenant.nodes.list({}))).status).toBe(403);
  });

  it("expires deliveries that no node picked up in time", async () => {
    const { items } = await tenant.cacheTasks.list({});
    const pending = items.find((t) =>
      t.nodes.some((n) => n.state !== "succeeded" && n.state !== "failed"),
    );
    expect(pending).toBeDefined();
    const expired = await expireCacheTasks(ctx.db, new Date(Date.now() + 8 * 24 * 3600 * 1000));
    expect(expired).toBeGreaterThan(0);
    const after = await tenant.cacheTasks.get({ id: pending?.id ?? "" });
    expect(after.state).toBe("failed");
    expect(after.nodes.every((n) => n.state === "failed" || n.state === "succeeded")).toBe(true);
    expect(after.finishedAt).not.toBeNull();
  });
});
