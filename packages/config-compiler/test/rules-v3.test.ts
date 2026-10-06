import { create, type JsonObject, toJson } from "@bufbuild/protobuf";
import { type RuleAction, RuleActionSchema } from "@edgeweir/proto";
import {
  type ActionIr,
  type Expression,
  parseExpression,
  validActionIr,
} from "@edgeweir/rule-engine";
import { describe, expect, it } from "vitest";
import {
  compileNodeConfig,
  geoFeatures,
  RULES_V3_FEATURE,
  type RuleModel,
  rulesFeatures,
  type SiteModel,
} from "../src/index";

const site = (id: string, overrides: Partial<SiteModel> = {}): SiteModel => ({
  id,
  name: `site-${id}`,
  enabled: true,
  cacheGeneration: 1,
  domains: [{ name: `${id}.test`, wildcard: false }],
  originPool: {
    id: `pool-${id}`,
    policy: "weighted_random",
    origins: [
      {
        id: `o1-${id}`,
        address: "whoami",
        port: 80,
        scheme: "http",
        weight: 1,
        backup: false,
        hostHeader: "",
        sni: "",
      },
    ],
  },
  cacheRules: [],
  ...overrides,
});
const rule = (phase: string, action: RuleModel["action"], expression = "true"): RuleModel => ({
  id: `r-${phase}-${action.kind}`,
  phase,
  expression: parseExpression(expression, phase as Parameters<typeof parseExpression>[1]),
  action,
});
const compile = (
  rules: RuleModel[],
  overrides: Partial<SiteModel> = {},
  platformRules: RuleModel[] = [],
) =>
  compileNodeConfig(
    { clusterId: "c", sites: [site("a", { rules, ...overrides })], platformRules },
    1n,
  );
/** A compiled action as the node's validator reads it (JSON names, set fields only). */
const toIr = (action: RuleAction | undefined): ActionIr => {
  const json = toJson(RuleActionSchema, action ?? create(RuleActionSchema)) as JsonObject;
  const expression = (e: JsonObject): Expression => ({
    op: String(e.op ?? ""),
    field: String(e.field ?? ""),
    valueType: String(e.valueType ?? ""),
    value: String(e.value ?? ""),
    values: (e.values as string[] | undefined) ?? [],
    children: ((e.children as JsonObject[] | undefined) ?? []).map(expression),
  });
  return {
    ...(json as unknown as ActionIr),
    target: json.target ? expression(json.target as JsonObject) : undefined,
    setQuery: ((json.setQuery as JsonObject[] | undefined) ?? []).map((p) => ({
      name: String(p.name ?? ""),
      value: String(p.value ?? ""),
      expression: p.expression ? expression(p.expression as JsonObject) : undefined,
    })),
  };
};

describe("rule engine additions (rules-v3)", () => {
  const header = (phase: string, kind: "request_header" | "response_header", extra: object) =>
    rule(phase, { kind, header: "x-a", value: "", expression: "", remove: false, ...extra });

  it("keeps the encoding and features of configurations that use none of the additions", () => {
    const legacy = [
      rule("request-transform", {
        kind: "request_header",
        header: "x-a",
        value: "1",
        remove: false,
      }),
      rule("response-transform", {
        kind: "response_header",
        header: "x-b",
        value: "2",
        remove: false,
      }),
      rule("redirect", {
        kind: "redirect",
        value: "/n",
        statusCode: 302,
        setQuery: [{ name: "a", value: "1" }],
      }),
    ];
    // The same rules as the contract parses them now: the new fields' defaults filled in.
    const parsed = [
      header("request-transform", "request_header", { value: "1" }),
      {
        ...header("response-transform", "response_header", {
          header: "x-b",
          value: "2",
          append: false,
        }),
      },
      rule("redirect", {
        kind: "redirect",
        value: "/n",
        statusCode: 302,
        setQuery: [{ name: "a", value: "1", expression: "" }],
      }),
    ];
    const before = compile(legacy);
    const after = compile(parsed);
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.requiredFeatures).not.toContain(RULES_V3_FEATURE);
    expect(
      compile([], {
        errorPages: {
          pages: [{ status: 403, template: "<p>{{status}} {{request_id}}</p>" }],
          interceptOriginErrors: false,
        },
      }).requiredFeatures,
    ).not.toContain(RULES_V3_FEATURE);
  });

  it("compiles computed header values, response header lines and computed query parameters", () => {
    const config = compile([
      header("origin", "request_header", {
        header: "x-client-country",
        expression: "ip.geoip.country",
      }),
      header("response-transform", "response_header", {
        header: "link",
        value: "</a.css>; rel=preload",
        append: true,
      }),
      header("response-transform", "response_header", {
        header: "x-cache",
        expression: "http.response.cache_status",
      }),
      header("response-transform", "response_header", {
        header: "x-gone",
        remove: true,
        append: true,
        expression: "",
      }),
      rule("redirect", {
        kind: "redirect",
        value: "/signin",
        statusCode: 303,
        setQuery: [
          { name: "z", value: "", expression: 'http.request.uri.args["next"]' },
          { name: "a", value: "1", expression: "" },
        ],
      }),
    ]);
    const rules = config.sites[0]?.rules ?? [];
    const by = (h: string) => rules.find((r) => r.action?.header === h);
    expect(by("x-client-country")?.action?.target).toMatchObject({
      op: "field",
      field: "ip.geoip.country",
    });
    expect(by("link")?.action).toMatchObject({
      value: "</a.css>; rel=preload",
      append: true,
    });
    expect(by("link")?.action?.target).toBeUndefined();
    expect(by("x-cache")?.action?.target?.field).toBe("http.response.cache_status");
    expect(by("x-gone")?.action).toMatchObject({ remove: true, append: false });
    expect(by("x-gone")?.action?.target).toBeUndefined();
    const redirect = rules.find((r) => r.action?.kind === "redirect")?.action;
    expect(redirect?.statusCode).toBe(303);
    expect(redirect?.setQuery.map((p) => [p.name, p.value, p.expression?.field ?? ""])).toEqual([
      ["a", "1", ""],
      ["z", "", "http.request.uri.args.next"],
    ]);
    for (const r of rules) expect(validActionIr(r.phase, toIr(r.action)), r.id).toBe(true);
    // Targets and set_query are rules-v2 fields as well.
    expect(rulesFeatures(config)).toEqual(["rules-v2", RULES_V3_FEATURE]);
    expect(config.requiredFeatures).toContain(RULES_V3_FEATURE);
    expect(config.requiredFeatures).toContain("geoip-city-v1");
  });

  it("requires rules-v3 for each addition on its own", () => {
    const uses = (
      rules: RuleModel[],
      overrides: Partial<SiteModel> = {},
      platform: RuleModel[] = [],
    ) => compile(rules, overrides, platform).requiredFeatures.includes(RULES_V3_FEATURE);
    const log = (expression: string) => rule("waf-custom", { kind: "log" }, expression);
    expect(uses([log('http.user_agent wildcard "*bot*"')])).toBe(true);
    expect(uses([log('http.request.cookies["role"] eq "admin"')])).toBe(true);
    expect(uses([log('http.request.uri.args["a"] eq "1"')])).toBe(true);
    expect(uses([log('md5(http.host) eq ""')])).toBe(true);
    expect(uses([log('substring(http.host, 0, 2) eq "ab"')])).toBe(true);
    expect(uses([log("edge.server_port eq 8443")])).toBe(true);
    expect(uses([log('http.request.headers["user-agent"] contains "bot"')])).toBe(false);
    expect(uses([rule("redirect", { kind: "redirect", value: "/", statusCode: 303 })])).toBe(true);
    expect(uses([rule("redirect", { kind: "redirect", value: "/", statusCode: 301 })])).toBe(false);
    expect(uses([], {}, [log('http.referer wildcard "*"')])).toBe(true);
    expect(
      uses([
        rule("request-transform", {
          kind: "rewrite",
          value: "/b",
          setQuery: [{ name: "s", value: "", expression: "http.host" }],
        }),
      ]),
    ).toBe(true);
    expect(uses([header("request-transform", "request_header", { expression: '"x"' })])).toBe(true);
    expect(
      uses([header("response-transform", "response_header", { value: "x", append: true })]),
    ).toBe(true);
    const page = (template: string) => ({
      errorPages: { pages: [{ status: 503 as const, template }], interceptOriginErrors: false },
    });
    expect(uses([], page("<p>{{time}}</p>"))).toBe(true);
    expect(uses([], page("<p>{{path}}</p>"))).toBe(true);
    const platformPage = compileNodeConfig(
      {
        clusterId: "c",
        sites: [site("a")],
        platformErrorPages: { unknownHost: "{{path}}", siteDisabled: "" },
      },
      1n,
    );
    expect(platformPage.requiredFeatures).toContain(RULES_V3_FEATURE);
  });

  it("asks for the ASN database for ip.geoip.as_name", () => {
    expect(geoFeatures(parseExpression('ip.geoip.as_name contains "Cloud"'))).toEqual([
      "geoip-asn-v1",
    ]);
    const config = compile([
      header("origin", "request_header", { header: "x-as", expression: "ip.geoip.as_name" }),
    ]);
    expect(config.requiredFeatures).toEqual(
      expect.arrayContaining(["geoip-asn-v1", RULES_V3_FEATURE]),
    );
  });
});
