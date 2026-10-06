import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { ruleInput, siteErrorPagesInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { updateSiteErrorPages } from "../../src/server/services/error-pages";
import { latestRevision } from "../../src/server/services/revisions";
import { saveRules } from "../../src/server/services/rules";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const G8_FEATURES = [
  "rules-v1",
  "tls-v1",
  "access-logs-v1",
  "challenge-v1",
  "error-pages-v1",
  "geoip-city-v1",
  "geoip-country-v1",
  "geoip-asn-v1",
  "rules-v2",
  "rules-v3",
];

type RuleSave = Parameters<ApiClient["rules"]["save"]>[0]["rules"];

/** A change without the operator behind it (service accounts, background jobs). */
const service = {
  actor: { type: "service_account" as const, id: "service-account-g8", name: "integration" },
};

describe("rule engine additions (rules-v3) on the console side", async () => {
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
  const config = async () =>
    decodeNodeConfig((await latestRevision(ctx.db, clusterId))?.ir ?? new Uint8Array());
  const siteOf = async () => (await config()).sites.find((site) => site.id === siteId);
  const setNodeFeatures = (features: string[]) =>
    ctx.db
      .update(schema.node)
      .set({ supportedFeatures: features })
      .where(eq(schema.node.id, nodeId));
  const v3Rules: RuleSave = [
    {
      name: "country",
      phase: "origin",
      enabled: true,
      expression: "true",
      action: {
        kind: "request_header",
        header: "X-Client-Country",
        expression: "ip.geoip.country",
      },
    },
    {
      name: "id",
      phase: "request-transform",
      enabled: true,
      expression: 'http.request.cookies["role"] ne "admin"',
      action: { kind: "request_header", header: "x-req", expression: "http.request.id" },
    },
    {
      name: "link",
      phase: "response-transform",
      enabled: true,
      expression: 'http.response.cache_status eq "HIT"',
      action: {
        kind: "response_header",
        header: "link",
        value: "</a.css>; rel=preload",
        append: true,
      },
    },
    {
      name: "login",
      phase: "redirect",
      enabled: true,
      expression: 'http.user_agent wildcard "*curl*"',
      action: {
        kind: "redirect",
        value: "/signin",
        statusCode: 303,
        setQuery: [
          { name: "next", value: "", expression: 'url_encode(http.request.uri.args["next"])' },
        ],
      },
    },
  ];

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = (
      await admin.sites.create({
        name: "shop",
        domains: ["www.shop.test"],
        origins: [{ address: "origin-a.shop.test" }],
      })
    ).site.id;
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-g8",
        supportedFeatures: G8_FEATURES,
        enrolledAt: new Date(Date.now() - 86_400_000),
        lastSeenAt: new Date(),
      })
      .returning();
    if (!node) throw new Error("node missing");
    nodeId = node.id;
  });
  afterAll(() => pglite.close());

  it("saves computed header values, response header lines, 303 redirects and computed query parameters, compiled with rules-v3", async () => {
    expect((await admin.sites.features({ id: siteId })).rulesV3).toEqual({
      available: true,
      reason: null,
    });
    const saved = await admin.rules.save({ id: siteId, rules: v3Rules });
    expect(await admin.rules.get({ id: siteId })).toEqual(saved);
    expect(saved.find((r) => r.name === "country")?.action).toEqual({
      kind: "request_header",
      header: "x-client-country",
      value: "",
      expression: "ip.geoip.country",
      remove: false,
    });
    expect(saved.find((r) => r.name === "link")?.action).toEqual({
      kind: "response_header",
      header: "link",
      value: "</a.css>; rel=preload",
      expression: "",
      remove: false,
      append: true,
    });
    const rules = (await siteOf())?.rules ?? [];
    const action = (header: string) => rules.find((r) => r.action?.header === header)?.action;
    expect(action("x-client-country")?.target).toMatchObject({
      op: "field",
      field: "ip.geoip.country",
    });
    expect(action("x-req")?.target?.field).toBe("http.request.id");
    expect(action("link")).toMatchObject({ append: true, value: "</a.css>; rel=preload" });
    const redirect = rules.find((r) => r.action?.kind === "redirect")?.action;
    expect(redirect?.statusCode).toBe(303);
    expect(redirect?.setQuery[0]?.expression).toMatchObject({ op: "call", field: "url_encode" });
    expect((await config()).requiredFeatures).toEqual(
      expect.arrayContaining(["rules-v2", "rules-v3", "geoip-city-v1"]),
    );
  });

  it("refuses rules-v3 actions the nodes would not run before anything is stored", async () => {
    const before = (await config()).revision;
    for (const action of [
      { kind: "request_header", header: "x-a", value: "a", expression: '"b"' },
      { kind: "request_header", header: "x-a", remove: true, expression: '"b"' },
      { kind: "request_header", header: "x-a", expression: "http.response.cache_status" },
      { kind: "request_header", header: "x-a", expression: 'http.request.cookies["a b"]' },
      { kind: "redirect", value: "/a", statusCode: 304 },
    ]) {
      const phase = action.kind === "redirect" ? "redirect" : "request-transform";
      const error = await rpcError(
        admin.rules.save({
          id: siteId,
          rules: [{ name: "bad", phase, expression: "true", action } as RuleSave[number]],
        }),
      );
      expect(error, JSON.stringify(action)).toMatchObject({ code: "BAD_REQUEST", status: 400 });
    }
    expect((await config()).revision).toBe(before);
    expect(await admin.rules.get({ id: siteId })).toHaveLength(v3Rules.length);
    // Bulk redirects keep 301, 302, 307 and 308.
    expect(
      await rpcError(
        admin.bulkRedirects.save({
          id: siteId,
          redirects: [{ source: "/a", target: "/b", statusCode: 303 as never }],
        }),
      ),
    ).toMatchObject({ code: "BAD_REQUEST" });
  });

  it("validates the new fields, functions and comparisons through rules.validate", async () => {
    const validate = (expression: string, kind: "condition" | "value", phase = "waf-custom") =>
      admin.rules.validate({ expression, kind, phase: phase as "waf-custom" });
    expect(await validate('sha256(http.request.cookies["sid"]) eq ""', "condition")).toMatchObject({
      valid: true,
    });
    expect(
      await validate('http.referer strict wildcard "https://*.shop.test/*"', "condition"),
    ).toMatchObject({
      valid: true,
    });
    expect(
      await validate("substring(to_string(edge.server_port), -2)", "value", "redirect"),
    ).toMatchObject({
      valid: true,
    });
    expect(await validate('substring(http.host, "1") eq ""', "condition")).toMatchObject({
      valid: false,
      code: "integer_argument",
      position: 21,
      params: { min: "-65536", max: "65536" },
    });
    expect(await validate('http.request.uri.args["a&b"] eq ""', "condition")).toMatchObject({
      valid: false,
      code: "argument_name",
    });
  });

  it("keeps configurations without the additions free of rules-v3; {{time}} and {{path}} need it", async () => {
    await admin.rules.save({
      id: siteId,
      rules: [
        {
          name: "plain",
          phase: "request-transform",
          enabled: true,
          expression: 'http.request.headers["user-agent"] contains "curl"',
          action: { kind: "request_header", header: "x-a", value: "1" },
        },
      ],
    });
    expect((await config()).requiredFeatures).not.toContain("rules-v3");
    await admin.errorPages.update({
      id: siteId,
      pages: [{ status: 403, template: "<p>{{status}} {{request_id}}</p>" }],
    });
    expect((await config()).requiredFeatures).not.toContain("rules-v3");
    const pages = await admin.errorPages.get({ id: siteId });
    await admin.errorPages.update({
      id: siteId,
      pages: [{ status: 403, template: "<p>{{time}} {{path}}</p>" }],
      expectedUpdatedAt: pages.updatedAt ?? undefined,
    });
    expect((await config()).requiredFeatures).toContain("rules-v3");
    const later = await admin.errorPages.get({ id: siteId });
    await admin.errorPages.update({
      id: siteId,
      pages: [],
      expectedUpdatedAt: later.updatedAt ?? undefined,
    });
    expect((await config()).requiredFeatures).not.toContain("rules-v3");
    // The platform's pages too: they reach every cluster.
    await admin.settings.setErrorPages({ unknownHost: "<p>{{path}}</p>", siteDisabled: "" });
    expect((await config()).requiredFeatures).toContain("rules-v3");
    await admin.settings.setErrorPages({ unknownHost: "", siteDisabled: "" });
    expect((await config()).requiredFeatures).not.toContain("rules-v3");
  });

  it("holds rules-v3 for changes without the operator while an active node lacks it; the operator may require it", async () => {
    await setNodeFeatures(G8_FEATURES.filter((feature) => feature !== "rules-v3"));
    const features = await admin.sites.features({ id: siteId });
    expect(features.rulesV3).toEqual({ available: false, reason: "nodes" });
    expect(features.rulesV2.available).toBe(true);
    const serviceRules = (rules: unknown[]) =>
      saveRules(
        ctx,
        siteId,
        rules.map((rule) => ruleInput.parse(rule)),
        service,
      );
    const before = (await config()).revision;
    for (const call of [
      () => serviceRules(v3Rules.slice(2, 3)),
      () => serviceRules(v3Rules.slice(3, 4)),
      () =>
        serviceRules([
          {
            name: "ua",
            phase: "waf-custom",
            enabled: true,
            expression: 'http.user_agent wildcard "*bot*"',
            action: { kind: "block" },
          },
        ]),
      () =>
        updateSiteErrorPages(
          ctx.db,
          siteErrorPagesInput.parse({ id: siteId, pages: [{ status: 503, template: "{{path}}" }] }),
          service,
        ),
    ])
      await expect(call()).rejects.toMatchObject({
        code: "NODE_CAPABILITY_REQUIRED",
        status: 409,
        data: { features: "rules-v3" },
      });
    expect((await config()).revision).toBe(before);
    // Changes without the additions still publish.
    await serviceRules([
      {
        name: "plain",
        phase: "waf-custom",
        enabled: true,
        expression: 'http.request.headers["user-agent"] contains "bot"',
        action: { kind: "log" },
      },
    ]);
    expect((await config()).revision).toBeGreaterThan(before);
    // The operator may deliberately require the upgrade; the node keeps its last-known-good.
    await admin.rules.save({ id: siteId, rules: v3Rules });
    expect((await config()).requiredFeatures).toContain("rules-v3");
    await setNodeFeatures(G8_FEATURES);
    await serviceRules(v3Rules.slice(3, 4));
    expect((await config()).requiredFeatures).toContain("rules-v3");
  });

  it("lets AccessKeys save rules-v3 rules as their scope allows and keeps service accounts out", async () => {
    const body = { rules: v3Rules.slice(0, 1) };
    const reader = await admin.accessKeys.create({ name: "rules-read", scope: "read" });
    expect((await api(reader.key, "GET", `/sites/${siteId}/rules`)).status).toBe(200);
    for (const [method, path, payload] of [
      ["PUT", `/sites/${siteId}/rules`, body],
      ["PUT", "/platform-rules", { rules: [] }],
      ["PUT", `/sites/${siteId}/error-pages`, { pages: [{ status: 403, template: "{{time}}" }] }],
    ] as const) {
      const refused = await api(reader.key, method, path, payload);
      expect(refused.status, path).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "ACCESS_KEY_READ_ONLY" });
    }
    const writer = await admin.accessKeys.create({ name: "rules-write", scope: "write" });
    const res = await api(writer.key, "PUT", `/sites/${siteId}/rules`, body);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { action: unknown }[])[0]?.action).toMatchObject({
      kind: "request_header",
      expression: "ip.geoip.country",
    });
    const account = await admin.serviceAccounts.create({
      name: "integration-g8",
      scopes: ["sites:read", "sites:write"],
    });
    const { secret } = await admin.serviceAccounts.createKey({ id: account.id });
    for (const [method, path, payload] of [
      ["GET", `/sites/${siteId}/rules`, undefined],
      ["PUT", `/sites/${siteId}/rules`, body],
      ["PUT", "/platform-rules", { rules: [] }],
      ["GET", `/sites/${siteId}/features`, undefined],
      ["POST", "/rules/validate", { expression: "true", phase: "waf-custom" }],
    ] as const) {
      const refused = await api(secret, method, path, payload);
      expect(refused.status, `${method} ${path}`).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "SERVICE_ACCOUNT_FORBIDDEN" });
    }
  });
});
