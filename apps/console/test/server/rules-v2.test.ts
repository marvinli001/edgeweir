import { decodeNodeConfig } from "@edgeweir/config-compiler";
import type { RuleInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { cacheConditionExpression } from "@edgeweir/rule-engine";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
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

const G5_FEATURES = [
  "rules-v1",
  "tls-v1",
  "access-logs-v1",
  "challenge-v1",
  "active-health-v1",
  "session-affinity-v1",
  "error-pages-v1",
  "purge-tag-v1",
  "prefetch-v2",
  "rules-v2",
];

type RuleSave = Parameters<ApiClient["rules"]["save"]>[0]["rules"];

describe("rule engine extensions, cache conditions, origin groups and bulk redirects on the console side", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let owner: ApiClient;
  let member: ApiClient;
  let outsider: ApiClient;
  let clusterId: string;
  let orgId: string;
  let siteId: string;
  let otherSiteId: string;
  let nodeId: string;
  const defaultOrigins = [{ address: "origin-a.shop.test" }];
  const origins = [...defaultOrigins, { address: "origin-eu.shop.test", group: "eu" }];
  const api = (key: string, method: string, path: string, body?: unknown) =>
    app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const config = async () =>
    decodeNodeConfig((await latestRevision(ctx.db, clusterId))?.ir ?? new Uint8Array());
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
  const v2Rules: RuleSave = [
    {
      name: "go",
      phase: "redirect",
      expression: 'starts_with(http.request.uri.path, "/go/")',
      action: {
        kind: "redirect",
        target: 'concat("https://", lower(http.host), http.request.uri.path)',
        statusCode: 308,
        preserveQuery: true,
        setQuery: [
          { name: "z", value: "last" },
          { name: "a", value: "first one" },
        ],
        removeQuery: ["utm_source", "fbclid"],
      },
    },
    {
      name: "old",
      phase: "request-transform",
      expression: "true",
      action: {
        kind: "rewrite",
        target: 'wildcard_replace(http.request.uri.path, "/old/*", "/new/${1}")',
        preserveQuery: false,
      },
    },
    {
      name: "media",
      phase: "origin",
      expression: 'http.request.uri.path.extension in {"mp4" "webm"}',
      action: { kind: "origin", originGroup: "eu", hostHeader: "media.shop.test", port: 8443 },
    },
    {
      name: "html",
      phase: "compression",
      expression: 'http.response.content_type.media_type eq "text/html"',
      action: { kind: "compression", algorithms: ["zstd", "gzip"] },
    },
    {
      name: "settings",
      phase: "config",
      expression: 'ends_with(http.host, ".shop.test")',
      action: {
        kind: "config",
        gzip: true,
        websocket: false,
        ccEnabled: false,
        ccMaxLevel: "js",
        originReadTimeoutMs: 120_000,
        logSampleRate: 500,
      },
    },
  ];

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    orgId = (await admin.organizations.create({ name: "Shop", defaultClusterId: clusterId })).id;
    const otherOrgId = (
      await admin.organizations.create({ name: "Rival", defaultClusterId: clusterId })
    ).id;
    const users: [string, string, "owner" | "member"][] = [
      ["owner@shop.test", orgId, "owner"],
      ["member@shop.test", orgId, "member"],
      ["owner@rival.test", otherOrgId, "owner"],
    ];
    for (const [email, organizationId, role] of users)
      await admin.users.create({ name: email, email, password: PASSWORD, organizationId, role });
    owner = rpcClient(app, origin, await signIn(app, origin, "owner@shop.test"));
    member = rpcClient(app, origin, await signIn(app, origin, "member@shop.test"));
    outsider = rpcClient(app, origin, await signIn(app, origin, "owner@rival.test"));
    siteId = (
      await owner.sites.create({
        name: "shop",
        domains: ["www.shop.test", "*.cdn.shop.test"],
        origins,
      })
    ).site.id;
    otherSiteId = (
      await outsider.sites.create({
        name: "rival",
        domains: ["www.rival.test"],
        origins: defaultOrigins,
      })
    ).site.id;
    for (const id of [siteId, otherSiteId]) await approveSiteDomains(admin, id);
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-g5",
        supportedFeatures: G5_FEATURES,
        enrolledAt: new Date(Date.now() - 86_400_000),
        lastSeenAt: new Date(),
      })
      .returning();
    if (!node) throw new Error("node missing");
    nodeId = node.id;
  });
  afterAll(() => pglite.close());

  it("stores origin groups and compiles them with rules-v2", async () => {
    const site = await member.sites.get({ id: siteId });
    expect(site.origins.map((o) => [o.address, o.group])).toEqual([
      ["origin-a.shop.test", ""],
      ["origin-eu.shop.test", "eu"],
    ]);
    const compiled = await siteOf();
    expect(compiled?.originPool?.origins.map((o) => o.group).sort()).toEqual(["", "eu"]);
    expect((await config()).requiredFeatures).toContain("rules-v2");
    expect((await member.sites.features({ id: siteId })).rulesV2).toEqual({
      available: true,
      reason: null,
    });
    const [row] = await ctx.db
      .select({ group: schema.origin.groupName })
      .from(schema.origin)
      .where(eq(schema.origin.address, "origin-eu.shop.test"));
    expect(row?.group).toBe("eu");
  });

  it("saves every new action kind and compiles targets, query edits, origin, compression and config overrides", async () => {
    const saved = await owner.rules.save({ id: siteId, rules: v2Rules });
    expect(await member.rules.get({ id: siteId })).toEqual(saved);
    expect(saved.find((r) => r.name === "old")?.action).toEqual({
      kind: "rewrite",
      value: "",
      target: 'wildcard_replace(http.request.uri.path, "/old/*", "/new/${1}")',
      preserveQuery: false,
      setQuery: [],
      removeQuery: [],
    });
    expect(saved.find((r) => r.name === "media")?.action).toEqual({
      kind: "origin",
      originGroup: "eu",
      hostHeader: "media.shop.test",
      sni: "",
      port: 8443,
    });
    const rules = (await siteOf())?.rules ?? [];
    expect(rules.map((r) => r.phase)).toEqual([
      "request-transform",
      "redirect",
      "config",
      "origin",
      "compression",
    ]);
    const [rewrite, redirect, settings, media, html] = rules;
    expect(redirect?.action).toMatchObject({
      kind: "redirect",
      value: "",
      statusCode: 308,
      preserveQuery: true,
      setQuery: [
        { name: "a", value: "first one" },
        { name: "z", value: "last" },
      ],
      removeQuery: ["fbclid", "utm_source"],
    });
    expect(redirect?.action?.target).toMatchObject({ op: "call", field: "concat" });
    expect(rewrite?.action?.target).toMatchObject({ op: "call", field: "wildcard_replace" });
    expect(rewrite?.action?.preserveQuery).toBe(false);
    expect(settings?.action).toMatchObject({
      gzip: true,
      websocket: false,
      ccEnabled: false,
      ccMaxLevel: "js",
      originReadTimeoutMs: 120_000,
      logSampleRate: 500,
    });
    expect(settings?.action?.brotli).toBeUndefined();
    expect(media?.action).toMatchObject({
      kind: "origin",
      originGroup: "eu",
      hostHeader: "media.shop.test",
      port: 8443,
    });
    expect(html?.action?.compression).toEqual(["zstd", "gzip"]);
    expect((await config()).requiredFeatures).toEqual(
      expect.arrayContaining(["rules-v1", "rules-v2"]),
    );
    expect((await audits("site.rules_update")).at(-1)?.metadata).toEqual({ count: 5 });
  });

  it("refuses invalid new actions and unknown origin groups before anything is stored", async () => {
    const before = (await config()).revision;
    const invalid: RuleSave = [
      // A value expression that is a condition.
      {
        name: "x",
        phase: "redirect",
        expression: "true",
        action: { kind: "redirect", target: 'http.host eq "a"' },
      },
      // Both a static value and a target.
      {
        name: "x",
        phase: "redirect",
        expression: "true",
        action: { kind: "redirect", value: "/a", target: "http.host" },
      },
      // The new config fields only exist in the config phase.
      {
        name: "x",
        phase: "cache",
        expression: "true",
        action: { kind: "config", websocket: true },
      },
      // Compression rules only run in the compression phase.
      {
        name: "x",
        phase: "response-transform",
        expression: "true",
        action: { kind: "compression", algorithms: [] },
      },
      // A parameter both set and removed.
      {
        name: "x",
        phase: "redirect",
        expression: "true",
        action: {
          kind: "redirect",
          value: "/a",
          setQuery: [{ name: "a", value: "1" }],
          removeQuery: ["a"],
        },
      },
    ];
    for (const rule of invalid)
      expect(
        (await rpcError(owner.rules.save({ id: siteId, rules: [rule] }))).status,
        JSON.stringify(rule.action),
      ).toBe(400);
    expect(
      await rpcError(
        owner.rules.save({
          id: siteId,
          rules: [
            {
              name: "nowhere",
              phase: "origin",
              expression: "true",
              action: { kind: "origin", originGroup: "us" },
            },
          ],
        }),
      ),
    ).toMatchObject({ code: "RULE_INVALID", status: 400 });
    expect((await config()).revision).toBe(before);
    expect(await member.rules.get({ id: siteId })).toHaveLength(v2Rules.length);
  });

  it("keeps the origin groups rules use: a site update that removes one is refused", async () => {
    const error = await rpcError(owner.sites.update({ id: siteId, origins: defaultOrigins }));
    expect(error).toMatchObject({ code: "RULE_INVALID", status: 400 });
    expect(error.message).toContain("eu");
    // Every site keeps an origin in the default group.
    expect(
      (
        await rpcError(
          owner.sites.update({ id: siteId, origins: [{ address: "eu.shop.test", group: "eu" }] }),
        )
      ).status,
    ).toBe(400);
    // Other groups may come and go; the origin keeps its id when only its group changes.
    const before = (await member.sites.get({ id: siteId })).origins;
    const { site } = await owner.sites.update({
      id: siteId,
      origins: [...origins, { address: "origin-us.shop.test", group: "us" }],
    });
    expect(site.origins.map((o) => o.group)).toEqual(["", "eu", "us"]);
    expect(site.origins.slice(0, 2).map((o) => o.id)).toEqual(before.map((o) => o.id));
    await owner.sites.update({ id: siteId, origins });
  });

  it("refuses origin groups in platform rules, allows the other overrides and keeps tenants out", async () => {
    const group: RuleSave = [
      {
        name: "group",
        phase: "origin",
        expression: "true",
        action: { kind: "origin", originGroup: "eu" },
      },
    ];
    expect(await rpcError(admin.platformRules.save({ rules: group }))).toMatchObject({
      code: "RULE_INVALID",
      status: 400,
    });
    const overrides: RuleSave = [
      {
        name: "sni",
        phase: "origin",
        expression: 'http.request.full_uri contains "/upstream/"',
        action: { kind: "origin", sni: "origin.example.com", port: 443 },
      },
      {
        name: "compression",
        phase: "compression",
        expression: "true",
        action: { kind: "compression", algorithms: ["br"] },
      },
    ];
    // Tenants never reach the platform rules, with or without the new actions.
    for (const client of [member, owner])
      expect((await rpcError(client.platformRules.save({ rules: overrides }))).status).toBe(403);
    await admin.platformRules.save({ rules: overrides });
    const compiled = (await config()).platformRules;
    expect(compiled.map((r) => r.action?.kind)).toEqual(["origin", "compression"]);
    expect(compiled[0]?.action).toMatchObject({ sni: "origin.example.com", port: 443 });
    await admin.platformRules.save({ rules: [] });
  });

  it("stores cache rules as expressions, returns the builder's lists when expressible and compiles conditions and browser TTLs", async () => {
    const structured = {
      pathPrefixes: ["/static/", "/assets/"],
      paths: [],
      extensions: ["css", "js"],
    };
    const { site } = await owner.sites.update({
      id: siteId,
      cacheRules: [
        { priority: 10, pathPrefixes: ["/static/", "/assets/"], extensions: ["CSS", ".js"] },
        { priority: 20, expression: 'http.request.uri.path in {"/b" "/a"}' },
        {
          priority: 30,
          expression: 'lower(http.host) eq "img.cdn.shop.test"',
          edgeTtlSeconds: 120,
          browserTtlSeconds: 600,
        },
        { priority: 40, action: "bypass" },
      ],
    });
    expect(
      site.cacheRules.map((r) => ({
        expression: r.expression,
        pathPrefixes: r.pathPrefixes,
        paths: r.paths,
        extensions: r.extensions,
        browserTtlSeconds: r.browserTtlSeconds,
      })),
    ).toEqual([
      { expression: cacheConditionExpression(structured), ...structured, browserTtlSeconds: 0 },
      {
        expression: 'http.request.uri.path in {"/b" "/a"}',
        pathPrefixes: [],
        paths: ["/a", "/b"],
        extensions: [],
        browserTtlSeconds: 0,
      },
      {
        expression: 'lower(http.host) eq "img.cdn.shop.test"',
        pathPrefixes: [],
        paths: [],
        extensions: [],
        browserTtlSeconds: 600,
      },
      { expression: "true", pathPrefixes: [], paths: [], extensions: [], browserTtlSeconds: 0 },
    ]);
    // Only the expression is stored.
    const rows = await ctx.db
      .select()
      .from(schema.cacheRule)
      .where(eq(schema.cacheRule.siteId, siteId));
    expect(rows.every((r) => !r.pathPrefixes.length && !r.paths.length && !r.extensions.length));
    expect(rows.map((r) => r.expression)).toEqual(site.cacheRules.map((r) => r.expression));
    // What sites.get returns saves back unchanged.
    const again = await owner.sites.update({
      id: siteId,
      cacheRules: site.cacheRules.map(({ id: _, ...rule }) => rule),
    });
    expect(again.site.cacheRules.map(({ id: _, ...rule }) => rule)).toEqual(
      site.cacheRules.map(({ id: _, ...rule }) => rule),
    );
    const compiled = (await siteOf())?.cacheRules ?? [];
    expect(compiled.map((r) => r.match?.pathPrefixes)).toEqual([
      ["/static/", "/assets/"],
      [],
      [],
      [],
    ]);
    expect(compiled[0]?.match?.extensions).toEqual(["css", "js"]);
    expect(compiled[1]?.match?.paths).toEqual(["/a", "/b"]);
    expect(compiled.map((r) => !!r.match?.condition)).toEqual([false, false, true, false]);
    expect(compiled[2]?.match?.condition).toMatchObject({
      op: "eq",
      field: "",
      children: [{ op: "call", field: "lower" }],
    });
    expect(compiled[2]?.browserTtlSeconds).toBe(600);
    expect(compiled.every((r) => r.match?.expression === "")).toBe(true);
    // A condition or browser TTL needs rules-v2; the builder's shapes do not.
    expect((await config()).requiredFeatures).toContain("rules-v2");
    // Invalid conditions and mismatched lists are refused.
    for (const cacheRules of [
      [{ expression: "http.response.code eq 200" }],
      [{ expression: 'starts_with(http.request.uri.path, "/a/")', pathPrefixes: ["/b/"] }],
      [{ browserTtlSeconds: 31_536_001 }],
    ])
      expect((await rpcError(owner.sites.update({ id: siteId, cacheRules }))).status).toBe(400);
  });

  it("binds IP lists in cache conditions and keeps the lists they reference", async () => {
    const list = await owner.ipLists.create({ name: "office", entries: ["198.51.100.0/24"] });
    await owner.sites.update({
      id: siteId,
      cacheRules: [{ expression: "ip.src in $office", action: "bypass" }],
    });
    const condition = (await siteOf())?.cacheRules[0]?.match?.condition;
    expect(condition).toMatchObject({ op: "in_list", field: "ip.src", value: list.id });
    expect((await config()).ipLists.some((l) => l.id === list.id)).toBe(true);
    expect(await rpcError(owner.ipLists.delete({ id: list.id }))).toMatchObject({
      code: "IP_LIST_IN_USE",
    });
    expect(
      await rpcError(
        owner.sites.update({
          id: siteId,
          cacheRules: [{ expression: "ip.src in $nowhere", action: "bypass" }],
        }),
      ),
    ).toMatchObject({ code: "IP_LIST_NOT_FOUND" });
    // Another organization's lists are not visible.
    expect(
      await rpcError(
        outsider.sites.update({
          id: otherSiteId,
          cacheRules: [{ expression: "ip.src in $office", action: "bypass" }],
        }),
      ),
    ).toMatchObject({ code: "IP_LIST_NOT_FOUND" });
    await owner.sites.update({ id: siteId, cacheRules: [] });
    await owner.ipLists.delete({ id: list.id });
  });

  it("replaces bulk redirects, publishes them sorted by source and audits the count", async () => {
    const redirects = [
      { source: "/old", target: "/new" },
      { source: "img.cdn.shop.test/logo.png", target: "https://img.shop.test/logo.png" },
      { source: "www.shop.test/sale", target: "/deals", statusCode: 302, preserveQuery: true },
      { source: "/a", target: "https://www.shop.test/b?x=1", statusCode: 308 },
    ] as const;
    const saved = await owner.bulkRedirects.save({ id: siteId, redirects: [...redirects] });
    expect(saved).toEqual([
      { source: "/old", target: "/new", statusCode: 301, preserveQuery: false },
      {
        source: "img.cdn.shop.test/logo.png",
        target: "https://img.shop.test/logo.png",
        statusCode: 301,
        preserveQuery: false,
      },
      { source: "www.shop.test/sale", target: "/deals", statusCode: 302, preserveQuery: true },
      {
        source: "/a",
        target: "https://www.shop.test/b?x=1",
        statusCode: 308,
        preserveQuery: false,
      },
    ]);
    expect(await member.bulkRedirects.get({ id: siteId })).toEqual(saved);
    const compiled = (await siteOf())?.bulkRedirects ?? [];
    expect(compiled.map((r) => r.source)).toEqual([
      "/a",
      "/old",
      "img.cdn.shop.test/logo.png",
      "www.shop.test/sale",
    ]);
    expect(compiled[3]).toMatchObject({ target: "/deals", statusCode: 302, preserveQuery: true });
    expect(await latestRevision(ctx.db, clusterId)).toMatchObject({ reasonCode: "rules_updated" });
    const audit = (await audits("site.bulk_redirects_update")).at(-1);
    expect(audit).toMatchObject({
      organizationId: orgId,
      targetType: "site",
      targetId: siteId,
      targetName: "shop",
    });
    expect(audit?.metadata).toEqual({ count: 4 });
    // The other site's table stays empty.
    expect(await outsider.bulkRedirects.get({ id: otherSiteId })).toEqual([]);
    expect((await siteOf(otherSiteId))?.bulkRedirects).toEqual([]);
  });

  it("refuses foreign hosts, duplicate sources and tables over 5000 entries", async () => {
    const before = (await config()).revision;
    for (const source of ["www.rival.test/x", "deep.img.cdn.shop.test/x", "shop.test/x"])
      expect(
        await rpcError(
          owner.bulkRedirects.save({ id: siteId, redirects: [{ source, target: "/" }] }),
        ),
      ).toMatchObject({
        code: "BULK_REDIRECT_HOST_UNKNOWN",
        status: 400,
        data: { hosts: source.slice(0, source.indexOf("/")) },
      });
    for (const redirects of [
      [
        { source: "/dup", target: "/1" },
        { source: "/dup", target: "/2" },
      ],
      Array.from({ length: 5001 }, (_, i) => ({ source: `/p${i}`, target: "/" })),
      [{ source: "/a", target: "javascript:alert(1)" }],
      [{ source: "/a?b", target: "/" }],
    ])
      expect((await rpcError(owner.bulkRedirects.save({ id: siteId, redirects }))).status).toBe(
        400,
      );
    expect((await config()).revision).toBe(before);
    expect(await member.bulkRedirects.get({ id: siteId })).toHaveLength(4);
    // 5000 entries fit.
    const full = Array.from({ length: 5000 }, (_, i) => ({ source: `/p${i}`, target: `/q${i}` }));
    expect(await owner.bulkRedirects.save({ id: siteId, redirects: full })).toHaveLength(5000);
    expect((await siteOf())?.bulkRedirects).toHaveLength(5000);
    expect((await audits("site.bulk_redirects_update")).at(-1)?.metadata).toEqual({
      count: 5000,
    });
  });

  it("lets owners replace bulk redirects, members read them and nobody else reach them, service accounts included", async () => {
    const redirects = [{ source: "/member", target: "/no" }];
    expect(await rpcError(member.bulkRedirects.save({ id: siteId, redirects }))).toMatchObject({
      code: "ORG_ADMIN_REQUIRED",
      status: 403,
    });
    for (const call of [
      () => outsider.bulkRedirects.get({ id: siteId }),
      () => outsider.bulkRedirects.save({ id: siteId, redirects }),
    ])
      expect(await rpcError(call())).toMatchObject({ code: "SITE_NOT_FOUND", status: 404 });
    // Read-only AccessKeys read but cannot write.
    const reader = await owner.accessKeys.create({ name: "redirects-read", scope: "read" });
    const read = await api(reader.key, "GET", `/sites/${siteId}/bulk-redirects`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as unknown[]).length).toBe(5000);
    const refused = await api(reader.key, "PUT", `/sites/${siteId}/bulk-redirects`, {
      redirects,
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "ACCESS_KEY_READ_ONLY" });
    // A write key replaces the table through /api/v1.
    const writer = await owner.accessKeys.create({ name: "redirects-write", scope: "write" });
    const res = await api(writer.key, "PUT", `/sites/${siteId}/bulk-redirects`, {
      redirects: [{ source: "/api", target: "/v1", preserveQuery: true }],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { source: "/api", target: "/v1", statusCode: 301, preserveQuery: true },
    ]);
    expect((await audits("site.bulk_redirects_update")).at(-1)).toMatchObject({
      actorType: "api_key",
      metadata: { count: 1 },
    });
    // Platform administrators may change any site's table.
    expect(
      await admin.bulkRedirects.save({
        id: otherSiteId,
        redirects: [{ source: "/x", target: "/y" }],
      }),
    ).toHaveLength(1);
    await admin.bulkRedirects.save({ id: otherSiteId, redirects: [] });
    expect((await siteOf(otherSiteId))?.bulkRedirects).toEqual([]);
    // Service accounts reach neither procedure, whatever their scopes.
    const account = await admin.serviceAccounts.create({
      name: "integration",
      scopes: ["sites:read", "sites:write"],
    });
    const { secret } = await admin.serviceAccounts.createKey({ id: account.id });
    for (const [method, body] of [
      ["GET", undefined],
      ["PUT", { redirects }],
    ] as const) {
      const res = await api(secret, method, `/sites/${siteId}/bulk-redirects`, body);
      expect(res.status, method).toBe(403);
      expect(await res.json()).toMatchObject({ code: "SERVICE_ACCOUNT_FORBIDDEN" });
    }
  });

  it("rolls back with the rules-v2 requirement of the restored content", async () => {
    const target = await config();
    expect(target.requiredFeatures).toContain("rules-v2");
    await owner.bulkRedirects.save({ id: siteId, redirects: [] });
    await owner.rules.save({ id: siteId, rules: [] });
    await owner.sites.update({ id: siteId, origins: defaultOrigins });
    const plain = await config();
    expect(plain.requiredFeatures).not.toContain("rules-v2");
    expect(plain.sites.find((s) => s.id === siteId)?.bulkRedirects).toEqual([]);
    await admin.clusters.rollback({ id: clusterId, revision: Number(target.revision) });
    const restored = await config();
    expect(restored.sites.find((s) => s.id === siteId)?.bulkRedirects).toHaveLength(1);
    expect(restored.requiredFeatures).toContain("rules-v2");
    // Publishing again ships the current state.
    await owner.sites.update({ id: siteId, name: "shop" });
    await owner.bulkRedirects.save({ id: siteId, redirects: [] });
    expect((await config()).requiredFeatures).not.toContain("rules-v2");
  });

  it("refuses rules-v2 to tenants while an active node lacks it; administrators may require it", async () => {
    await setNodeFeatures(G5_FEATURES.filter((feature) => feature !== "rules-v2"));
    expect((await member.sites.features({ id: siteId })).rulesV2).toEqual({
      available: false,
      reason: "nodes",
    });
    const before = (await config()).revision;
    for (const call of [
      () => owner.bulkRedirects.save({ id: siteId, redirects: [{ source: "/a", target: "/b" }] }),
      () => owner.rules.save({ id: siteId, rules: v2Rules.slice(0, 1) }),
      () =>
        owner.rules.save({
          id: siteId,
          rules: [
            {
              name: "fn",
              phase: "waf-custom",
              expression: "len(http.request.uri.query) gt 2048",
              action: { kind: "block" },
            },
          ],
        }),
      () => owner.sites.update({ id: siteId, origins }),
      () =>
        owner.sites.update({
          id: siteId,
          cacheRules: [{ pathPrefixes: ["/a/"], browserTtlSeconds: 60 }],
        }),
    ])
      expect(await rpcError(call())).toMatchObject({
        code: "NODE_CAPABILITY_REQUIRED",
        status: 409,
        data: { features: "rules-v2" },
      });
    expect((await config()).revision).toBe(before);
    expect(await member.bulkRedirects.get({ id: siteId })).toEqual([]);
    expect(await member.rules.get({ id: siteId })).toEqual([]);
    expect((await member.sites.get({ id: siteId })).origins).toHaveLength(1);
    // Rules, cache rules and redirects without the extensions still publish.
    const plain: RuleInput["action"] = {
      kind: "redirect",
      value: "/y",
      target: "",
      statusCode: 301,
      preserveQuery: false,
      setQuery: [],
      removeQuery: [],
    };
    await owner.rules.save({
      id: siteId,
      rules: [{ name: "plain", phase: "redirect", expression: "true", action: plain }],
    });
    await owner.sites.update({ id: siteId, cacheRules: [{ pathPrefixes: ["/a/"] }] });
    expect((await config()).revision).toBeGreaterThan(before);
    expect((await config()).requiredFeatures).not.toContain("rules-v2");
    // A disabled node does not count; an administrator may require the upgrade.
    await ctx.db.update(schema.node).set({ status: "disabled" }).where(eq(schema.node.id, nodeId));
    expect((await member.sites.features({ id: siteId })).rulesV2.available).toBe(true);
    await ctx.db.update(schema.node).set({ status: "active" }).where(eq(schema.node.id, nodeId));
    await admin.bulkRedirects.save({ id: siteId, redirects: [{ source: "/adm", target: "/in" }] });
    expect((await config()).requiredFeatures).toContain("rules-v2");
    await admin.bulkRedirects.save({ id: siteId, redirects: [] });
    expect((await config()).requiredFeatures).not.toContain("rules-v2");
    // Once the node reports rules-v2, owners may use it.
    await setNodeFeatures(G5_FEATURES);
    await owner.bulkRedirects.save({ id: siteId, redirects: [{ source: "/a", target: "/b" }] });
    expect((await config()).requiredFeatures).toContain("rules-v2");
    await owner.bulkRedirects.save({ id: siteId, redirects: [] });
  });

  it("treats a config rule that turns Under Attack on as using challenges", async () => {
    const before = await config();
    expect(before.platformProtection).toBeUndefined();
    await owner.rules.save({
      id: siteId,
      rules: [
        {
          name: "login",
          phase: "config",
          expression: 'starts_with(http.request.uri.path, "/login")',
          action: { kind: "config", underAttack: true },
        },
      ],
    });
    const current = await config();
    expect(current.platformProtection).toMatchObject({ underAttack: false });
    expect(current.challengeKeys.map((key) => key.role).sort()).toEqual([
      "current",
      "next",
      "previous",
    ]);
    // Every served site carries its protection, so nodes can challenge what the rule matches.
    for (const site of current.sites)
      expect(site.protection, site.id).toMatchObject({ underAttack: false, passTtlSeconds: 1800 });
    expect(current.requiredFeatures).toEqual(expect.arrayContaining(["challenge-v1", "rules-v2"]));
    await owner.rules.save({ id: siteId, rules: [] });
    const after = await config();
    expect(after.platformProtection).toBeUndefined();
    expect(after.challengeKeys).toEqual([]);
  });

  it("validates value expressions and cache conditions through rules.validate", async () => {
    expect(
      await member.rules.validate({
        expression: 'concat("/", lower(http.host))',
        phase: "redirect",
        kind: "value",
      }),
    ).toEqual({ valid: true, position: 0, message: "" });
    expect(
      await member.rules.validate({ expression: "http.host eq", phase: "redirect", kind: "value" }),
    ).toMatchObject({ valid: false });
    const long = `http.request.uri.path in {${Array.from({ length: 256 }, (_, i) => `"/${"p".repeat(40)}${i}"`).join(" ")}}`;
    expect(long.length).toBeGreaterThan(4096);
    expect(
      await member.rules.validate({ expression: long, phase: "waf-custom", kind: "cacheRule" }),
    ).toMatchObject({ valid: true });
    expect(await member.rules.validate({ expression: long, phase: "cache" })).toMatchObject({
      valid: false,
    });
    // The default stays a condition of the phase.
    expect(
      await member.rules.validate({ expression: "http.host", phase: "waf-custom" }),
    ).toMatchObject({
      valid: false,
      position: 9,
    });
  });
});
