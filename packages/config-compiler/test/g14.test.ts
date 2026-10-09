import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clone, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { NodeConfigSchema } from "@edgeweir/proto";
import { parseExpression } from "@edgeweir/rule-engine";
import { describe, expect, it } from "vitest";
import {
  CHALLENGE_V2_FEATURE,
  type CompileInput,
  canonicalize,
  compileNodeConfig,
  contentHash,
  DEFAULT_SITE_PROTECTION,
  g14Features,
  RULES_BODY_FEATURE,
  type RuleModel,
  type SiteModel,
  splitWafExclusions,
  WAF_V2_FEATURE,
} from "../src/index";
import { site, tls } from "./v0230-models";
import { v0290Models, v0290Protection, v0290Waf } from "./v0290-models";

// Same vector as edgeweir-node/internal/configir/testdata/content_hash_vector_v0290.json.
type Vector = { config: JsonValue; canonical_hex: string; content_hash: string };
const vector = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures", "content_hash_vector_v0290.json"), "utf8"),
) as Vector;

const rule = (phase: string, source: string, action: RuleModel["action"]): RuleModel => ({
  id: `r-${action.kind}`,
  phase,
  expression: parseExpression(source, phase as never),
  action,
});
const input = (extra: Partial<SiteModel> = {}, platformRules: RuleModel[] = []): CompileInput => ({
  clusterId: "c1",
  sites: [site("a", { tls: tls(), ...extra }), site("b", { tls: tls() })],
  platformRules,
});
const features = (config: ReturnType<typeof compileNodeConfig>) =>
  [WAF_V2_FEATURE, RULES_BODY_FEATURE, CHALLENGE_V2_FEATURE].filter((f) =>
    config.requiredFeatures.includes(f),
  );

describe("G14 compilation", () => {
  it("keeps configurations without G14 features encoded as before", () => {
    const before = compileNodeConfig(input(), 1n);
    const unused = compileNodeConfig(
      input({
        rulesBodyLimit: 1_048_576,
        rules: [rule("waf-custom", 'http.request.uri.path eq "/x"', { kind: "log" })],
        waf: { ...v0290Waf(), exclusions: [] },
      }),
      1n,
    );
    expect(unused.sites[0]?.rulesBodyLimit).toBe(0);
    expect(unused.sites[0]?.rules[0]?.action).toMatchObject({ accessLog: false, banSeconds: 0 });
    expect(features(unused)).toEqual([]);
    expect(features(before)).toEqual([]);
    // Whole-site exclusions without targets are the excluded_rule_ids of before.
    const legacy = compileNodeConfig(
      input({
        waf: {
          ...v0290Waf(),
          exclusions: [{ path: "", exact: true, ruleIds: [942100, 920350], targets: [] }],
        },
      }),
      1n,
    );
    expect(legacy.sites[0]?.waf?.excludedRuleIds).toEqual([920350, 942100]);
    expect(legacy.sites[0]?.waf?.exclusions).toEqual([]);
    expect(features(legacy)).toEqual([]);
  });

  it("compiles the waf-v2 actions with only their own fields, defaults as zero values", () => {
    const actions = compileNodeConfig(
      input({
        rules: [
          rule("waf-custom", "true", {
            kind: "ban",
            banSeconds: 600,
            banScope: "site",
            banPrefixV4: 32,
            banPrefixV6: 64,
          }),
          rule("waf-custom", "true", {
            kind: "respond",
            statusCode: 503,
            contentType: "text/html",
            body: "<p>x</p>",
            errorPage: true,
          }),
          rule("waf-custom", "true", { kind: "skip", skip: ["rules", "challenges"] }),
        ],
      }),
      1n,
    ).sites[0]?.rules.map((r) => r.action);
    expect(actions?.[0]).toMatchObject({
      kind: "ban",
      banSeconds: 600,
      banScope: "",
      banPrefixV4: 0,
      banPrefixV6: 0,
    });
    // An error page has neither type nor body.
    expect(actions?.[1]).toMatchObject({
      statusCode: 503,
      errorPage: true,
      contentType: "",
      body: "",
    });
    expect(actions?.[2]?.skip).toEqual(["challenges", "rules"]);
    for (const action of [
      { kind: "close" },
      { kind: "log", accessLog: true },
      { kind: "ban", banSeconds: 60 },
    ] as RuleModel["action"][])
      expect(
        features(compileNodeConfig(input({ rules: [rule("waf-custom", "true", action)] }), 1n)),
      ).toEqual([WAF_V2_FEATURE]);
    const rate = (banSeconds: number) =>
      compileNodeConfig(
        input({
          rules: [
            rule("ratelimit", "true", {
              kind: "rate_limit",
              statusCode: 429,
              limit: 5,
              windowSeconds: 10,
              key: "ip.src",
              banSeconds,
            }),
          ],
        }),
        1n,
      );
    expect(features(rate(0))).toEqual([]);
    expect(features(rate(120))).toEqual([WAF_V2_FEATURE]);
    const crs = compileNodeConfig(
      input({ rules: [rule("config", "true", { kind: "config", crs: "off" })] }),
      1n,
    );
    expect(crs.sites[0]?.rules[0]?.action?.crs).toBe("off");
    expect(features(crs)).toEqual([WAF_V2_FEATURE]);
  });

  it("splits CRS exclusions and requires waf-v2 for paths and targets", () => {
    expect(
      splitWafExclusions([
        { path: "", exact: false, ruleIds: [942100], targets: [] },
        { path: "/a", exact: true, ruleIds: [941100, 920350, 941100], targets: [] },
        { path: "", exact: true, ruleIds: [920350], targets: ["ARGS:b", "ARGS:a"] },
        { path: "", exact: false, ruleIds: [920350, 942100], targets: [] },
      ]),
    ).toEqual({
      excludedRuleIds: [920350, 942100],
      exclusions: [
        { path: "/a", exact: true, ruleIds: [920350, 941100], targets: [] },
        { path: "", exact: false, ruleIds: [920350], targets: ["ARGS:a", "ARGS:b"] },
      ],
    });
    const config = compileNodeConfig(input({ waf: v0290Waf() }), 1n);
    expect(config.sites[0]?.waf?.exclusions.map((e) => e.path)).toEqual(["/api/", "/login", ""]);
    expect(features(config)).toEqual([WAF_V2_FEATURE]);
  });

  it("gives the rules body limit only to sites whose rules (or the platform's) read the body", () => {
    const body = rule("waf-custom", 'form_value("q") eq "1"', { kind: "block", statusCode: 403 });
    const own = compileNodeConfig(input({ rules: [body], rulesBodyLimit: 2048 }), 1n);
    expect(own.sites.map((s) => [s.id, s.rulesBodyLimit])).toEqual([
      ["a", 2048],
      ["b", 0],
    ]);
    expect(features(own)).toEqual([RULES_BODY_FEATURE]);
    const platform = compileNodeConfig(input({ rulesBodyLimit: 4096 }, [body]), 1n);
    expect(platform.sites.map((s) => [s.id, s.rulesBodyLimit])).toEqual([
      ["a", 4096],
      ["b", 65536],
    ]);
    // A computed header value reading the body counts as well.
    const header = compileNodeConfig(
      input({
        rules: [
          rule("origin", "true", {
            kind: "request_header",
            header: "x-tenant",
            expression: 'json_value("tenant")',
          }),
        ],
      }),
      1n,
    );
    expect(header.sites[0]?.rulesBodyLimit).toBe(65536);
    // The size alone reads no body but needs the feature.
    const size = compileNodeConfig(
      input({ rules: [rule("waf-custom", "http.request.body.size gt 10", { kind: "log" })] }),
      1n,
    );
    expect(features(size)).toEqual([RULES_BODY_FEATURE]);
  });

  it("compiles the challenge-v2 protection fields only when used", () => {
    const protection = (extra: Partial<typeof DEFAULT_SITE_PROTECTION>) =>
      compileNodeConfig(
        input({ protection: { ...DEFAULT_SITE_PROTECTION, underAttack: true, ...extra } }),
        1n,
      );
    const plain = protection({});
    expect(plain.sites[0]?.protection).toMatchObject({
      allowVerifiedBots: false,
      failureThreshold: 0,
      failureBanSeconds: 0,
    });
    expect(plain.sites[0]?.protection?.challengeText).toBeUndefined();
    expect(features(plain)).toEqual([]);
    const empty = protection({
      challengeText: { titleZh: "", hintZh: "", titleEn: "", hintEn: "" },
      failureBan: null,
    });
    expect(empty.contentHash).toBe(plain.contentHash);
    const full = protection(v0290Protection());
    expect(full.sites[0]?.protection).toMatchObject({
      allowVerifiedBots: true,
      failureThreshold: 5,
      failureBanSeconds: 900,
      challengeText: { titleZh: "访问验证", titleEn: "Checking your browser", hintEn: "" },
    });
    expect(features(full)).toEqual([CHALLENGE_V2_FEATURE]);
    expect(features(protection({ allowVerifiedBots: true }))).toEqual([CHALLENGE_V2_FEATURE]);
    const bots = compileNodeConfig(
      input({
        rules: [rule("waf-custom", "http.request.bot.verified eq true", { kind: "allow" })],
      }),
      1n,
    );
    expect(features(bots)).toEqual([CHALLENGE_V2_FEATURE]);
    expect(g14Features(bots)).toEqual([CHALLENGE_V2_FEATURE]);
  });
});

describe("content hash matches the Go agent (v0.29.0)", () => {
  it("encodes the v0.29.0 vector to the same canonical bytes and hash", () => {
    const raw = fromJson(NodeConfigSchema, vector.config);
    expect(raw.sites.map((s) => s.id)).toEqual(["b", "a"]);
    const config = canonicalize(raw);
    const a = config.sites[0];
    expect(a?.waf?.excludedRuleIds).toEqual([920350, 942100]);
    expect(a?.waf?.exclusions.map((e) => e.ruleIds)).toEqual([
      [941100, 942100],
      [942100],
      [932100],
    ]);
    expect(a?.waf?.exclusions[1]?.targets).toEqual(["ARGS:next", "ARGS:password"]);
    expect(a?.rules.find((r) => r.action?.kind === "skip")?.action?.skip).toEqual([
      "challenges",
      "crs",
      "rules",
    ]);
    const bare = clone(NodeConfigSchema, config);
    bare.revision = 0n;
    bare.contentHash = "";
    expect(Buffer.from(toBinary(NodeConfigSchema, bare)).toString("hex")).toBe(
      vector.canonical_hex,
    );
    expect(contentHash(config)).toBe(vector.content_hash);
  });

  it("compiles the v0.29.0 models into the vector's hash", () => {
    const config = compileNodeConfig(v0290Models(), 12n);
    expect(config.requiredFeatures).toEqual([
      "challenge-v1",
      CHALLENGE_V2_FEATURE,
      "modsecurity-v1",
      RULES_BODY_FEATURE,
      "rules-v1",
      "rules-v2",
      "tls-v1",
      WAF_V2_FEATURE,
    ]);
    expect(config.contentHash).toBe(vector.content_hash);
  });
});
