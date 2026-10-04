import { clone, create, type JsonObject, toJson } from "@bufbuild/protobuf";
import {
  CertificateRefSchema,
  L4Protocol,
  NodeConfigSchema,
  OriginProtocol,
  type RuleAction,
  RuleActionSchema,
} from "@edgeweir/proto";
import {
  type ActionIr,
  cacheConditionExpression,
  type Expression,
  parseExpression,
  validActionIr,
  validExpressionIr,
} from "@edgeweir/rule-engine";
import { describe, expect, it } from "vitest";
import {
  type ActiveHealthCheckModel,
  applyNodeConfigDiff,
  type CcPolicyModel,
  ConfigCapacityError,
  canonicalize,
  compileNodeConfig,
  compileRules,
  contentHash,
  DEFAULT_SITE_PROTECTION,
  decodeNodeConfig,
  diffNodeConfig,
  encodeNodeConfig,
  geoFeatures,
  L4_FEATURE,
  type L4AppModel,
  MAX_SITES_PER_CLUSTER,
  moduleFeatures,
  nodeRequirements,
  type OfflineHostModel,
  ORIGIN_HTTP2_FEATURE,
  type OriginPoolSettingsModel,
  parseDomain,
  poolAndPageFeatures,
  protectionFeatures,
  type RuleModel,
  refreshDerived,
  ruleModelOf,
  rulesFeatures,
  type SiteModel,
  TLS_PENDING_DOMAINS_FEATURE,
  type TlsModel,
  usesChallengeKeys,
  usesChallenges,
} from "../src/index";

const site = (id: string, overrides: Partial<SiteModel> = {}): SiteModel => ({
  id,
  name: `site-${id}`,
  enabled: true,
  cacheGeneration: 1,
  domains: [parseDomain(`${id}.test`)],
  originPool: {
    id: `pool-${id}`,
    policy: "weighted_random",
    origins: [
      {
        id: `o2-${id}`,
        address: "10.0.0.2",
        port: 80,
        scheme: "http",
        weight: 1,
        backup: true,
        hostHeader: "",
        sni: "",
      },
      {
        id: `o1-${id}`,
        address: "whoami",
        port: 80,
        scheme: "http",
        weight: 3,
        backup: false,
        hostHeader: "",
        sni: "",
      },
    ],
  },
  cacheRules: [
    {
      id: "r2",
      priority: 10,
      pathPrefixes: [],
      extensions: ["PNG"],
      expression: "",
      action: "cache",
      edgeTtlSeconds: 86400,
      originCacheControl: "respect",
    },
    {
      id: "r1",
      priority: 10,
      pathPrefixes: ["/"],
      extensions: [],
      expression: "",
      action: "cache",
      edgeTtlSeconds: 60,
      originCacheControl: "override",
    },
  ],
  ...overrides,
});

describe("compileNodeConfig", () => {
  it("bounds published sites while allowing disabled drafts", () => {
    const sites = Array.from({ length: MAX_SITES_PER_CLUSTER }, (_, i) => site(`s${i}`));
    expect(compileNodeConfig({ clusterId: "c", sites }, 1n).sites).toHaveLength(
      MAX_SITES_PER_CLUSTER,
    );
    expect(() =>
      compileNodeConfig({ clusterId: "c", sites: [...sites, site("extra")] }, 1n),
    ).toThrow(ConfigCapacityError);
    expect(
      compileNodeConfig(
        { clusterId: "c", sites: [...sites, site("draft", { enabled: false })] },
        1n,
      ).sites,
    ).toHaveLength(MAX_SITES_PER_CLUSTER);
  });
  it("produces canonical ordering", () => {
    const cfg = compileNodeConfig({ clusterId: "c", sites: [site("b"), site("a")] }, 1n);
    expect(cfg.sites.map((s) => s.id)).toEqual(["a", "b"]);
    expect(cfg.sites[0]?.originPool?.origins.map((o) => o.id)).toEqual(["o1-a", "o2-a"]);
    expect(cfg.sites[0]?.cacheRules.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(cfg.sites[0]?.cacheRules[1]?.match?.extensions).toEqual(["png"]);
    expect(cfg.listeners.map((l) => l.port)).toEqual([80]);
  });

  it("hashes content independently of input order and revision", () => {
    const a = compileNodeConfig({ clusterId: "c", sites: [site("a"), site("b")] }, 1n);
    const b = compileNodeConfig({ clusterId: "c", sites: [site("b"), site("a")] }, 7n);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.contentHash).toBe(b.contentHash);
    expect(contentHash(a)).toBe(a.contentHash);
    const c = compileNodeConfig(
      { clusterId: "c", sites: [site("a"), site("b", { cacheGeneration: 2 })] },
      1n,
    );
    expect(c.contentHash).not.toBe(a.contentHash);
  });

  it("compiles cacheAuthorized per rule, off unless a rule asks for it", () => {
    const cfg = compileNodeConfig(
      {
        clusterId: "c",
        sites: [
          site("a", {
            cacheRules: [
              {
                id: "r1",
                priority: 10,
                pathPrefixes: ["/api/"],
                extensions: [],
                expression: "",
                action: "cache",
                edgeTtlSeconds: 60,
                originCacheControl: "respect",
                cacheAuthorized: true,
              },
              {
                id: "r2",
                priority: 20,
                pathPrefixes: ["/"],
                extensions: [],
                expression: "",
                action: "cache",
                edgeTtlSeconds: 60,
                originCacheControl: "override",
              },
            ],
          }),
        ],
      },
      1n,
    );
    expect(cfg.sites[0]?.cacheRules.map((r) => [r.id, r.cacheAuthorized])).toEqual([
      ["r1", true],
      ["r2", false],
    ]);
    // It is part of the content: switching it publishes a different hash.
    const off = compileNodeConfig({ clusterId: "c", sites: [site("a")] }, 1n);
    expect(off.sites[0]?.cacheRules.every((r) => !r.cacheAuthorized)).toBe(true);
    expect(cfg.contentHash).not.toBe(off.contentHash);
  });

  it("drops disabled sites", () => {
    const cfg = compileNodeConfig(
      { clusterId: "c", sites: [site("a"), site("b", { enabled: false })] },
      1n,
    );
    expect(cfg.sites.map((s) => s.id)).toEqual(["a"]);
  });

  it("round-trips through the binary encoding", () => {
    const cfg = compileNodeConfig({ clusterId: "c", sites: [site("a")] }, 3n);
    const decoded = decodeNodeConfig(encodeNodeConfig(cfg));
    expect(decoded.revision).toBe(3n);
    expect(contentHash(decoded)).toBe(cfg.contentHash);
  });

  it("keeps a stable hash for an empty cluster (cross-language vector)", () => {
    const cfg = compileNodeConfig(
      { clusterId: "00000000-0000-0000-0000-000000000000", sites: [] },
      1n,
    );
    // Recomputed by edgeweir-node with proto.MarshalOptions{Deterministic: true};
    // if this changes, the wire encoding of NodeConfig changed.
    expect(cfg.contentHash).toBe(contentHash(decodeNodeConfig(encodeNodeConfig(cfg))));
    expect(
      Buffer.from(encodeNodeConfig({ ...cfg, revision: 0n, contentHash: "" })).toString("hex"),
    ).toMatchSnapshot();
  });
});

describe("GeoIP capabilities", () => {
  const features = (source: string) => [...new Set(geoFeatures(parseExpression(source)))].sort();
  const requirements = (source: string) =>
    nodeRequirements(
      compileNodeConfig(
        {
          clusterId: "c",
          sites: [],
          platformRules: [
            {
              id: "r",
              phase: "waf-custom",
              expression: parseExpression(source),
              action: { kind: "log" },
            },
          ],
        },
        1n,
      ),
    ).sort();

  it("keeps the requiredFeatures every node version understands", () => {
    expect(features('ip.geoip.country eq "NZ"')).toEqual(["geoip-city-v1"]);
    expect(features('ip.geoip.subdivision eq "AUK"')).toEqual(["geoip-city-v1"]);
    expect(features("ip.geoip.asnum in {13335 15169}")).toEqual(["geoip-asn-v1"]);
    expect(
      features('not (ip.geoip.country in {"NZ" "AU"} and ip.geoip.asnum eq 64512) or ssl eq true'),
    ).toEqual(["geoip-asn-v1", "geoip-city-v1"]);
    expect(features('http.host eq "a.test"')).toEqual([]);
  });

  it("adds the console-only subdivision requirement", () => {
    expect(requirements('ip.geoip.country eq "NZ"')).toEqual(["geoip-city-v1", "rules-v1"]);
    expect(requirements('not (ssl eq true or ip.geoip.subdivision eq "AUK")')).toEqual([
      "geoip-city-v1",
      "geoip-subdivision-v1",
      "rules-v1",
    ]);
  });
});

describe("diffNodeConfig", () => {
  const base = compileNodeConfig({ clusterId: "c", sites: [site("a"), site("b"), site("c")] }, 1n);
  const target = compileNodeConfig(
    { clusterId: "c", sites: [site("a"), site("b", { cacheGeneration: 5 }), site("d")] },
    2n,
  );

  it("upserts changed and new sites, removes deleted ones", () => {
    const diff = diffNodeConfig(base, target);
    expect(diff.baseRevision).toBe(1n);
    expect(diff.revision).toBe(2n);
    expect(diff.upsertedSites.map((s) => s.id).sort()).toEqual(["b", "d"]);
    expect(diff.removedSiteIds).toEqual(["c"]);
  });

  it("applies back to exactly the target", () => {
    const applied = applyNodeConfigDiff(base, diffNodeConfig(base, target));
    expect(applied.contentHash).toBe(target.contentHash);
    expect(applied.sites.map((s) => s.id)).toEqual(["a", "b", "d"]);
  });

  it("carries the origin allow list in full and applies it", () => {
    const allowed = compileNodeConfig(
      {
        clusterId: "c",
        sites: [site("a"), site("b"), site("c")],
        originAllowedCidrs: ["192.168.0.0/16", "10.0.0.0/8", "10.0.0.0/8"],
      },
      2n,
    );
    expect(allowed.originAllowedCidrs).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);
    expect(allowed.contentHash).not.toBe(base.contentHash);
    const diff = diffNodeConfig(base, allowed);
    expect(diff.upsertedSites).toEqual([]);
    expect(diff.originAllowedCidrs).toEqual(["10.0.0.0/8", "192.168.0.0/16"]);
    const applied = applyNodeConfigDiff(base, diff);
    expect(applied.originAllowedCidrs).toEqual(allowed.originAllowedCidrs);
    expect(applied.contentHash).toBe(allowed.contentHash);
    // And back: an empty list in the diff clears it.
    expect(
      applyNodeConfigDiff(allowed, diffNodeConfig(allowed, target)).originAllowedCidrs,
    ).toEqual([]);
  });

  it("rejects a diff whose hash does not match", () => {
    const diff = diffNodeConfig(base, target);
    diff.contentHash = "0".repeat(64);
    expect(() => applyNodeConfigDiff(base, diff)).toThrow(/hash mismatch/);
  });
});

describe("challenges and CC mitigation", () => {
  const keys = [
    { id: "k3", role: "next" },
    { id: "k1", role: "previous" },
    { id: "k2", role: "current" },
  ];
  const cc: CcPolicyModel = {
    maxLevel: "pow",
    highPowInsteadOfCaptcha: true,
    windowSeconds: 10,
    siteQps: 1000,
    urlQps: 200,
    ipQps: 50,
    ipBanSeconds: 600,
    originErrorPercent: 50,
    originErrorMinRequests: 100,
    escalateAfterSeconds: 10,
    cooldownSeconds: 60,
  };
  const rule = (overrides: Partial<RuleModel> = {}): RuleModel => ({
    id: "r1",
    phase: "waf-custom",
    expression: parseExpression('http.request.uri.path eq "/login"'),
    action: { kind: "challenge", type: "pow" },
    ...overrides,
  });
  const plain = compileNodeConfig({ clusterId: "c", sites: [site("a"), site("b")] }, 1n);

  it("leaves protection, keys and features out unless the cluster uses challenges", () => {
    const unused = compileNodeConfig(
      {
        clusterId: "c",
        sites: [
          site("a", { protection: { ...DEFAULT_SITE_PROTECTION, passTtlSeconds: 600 } }),
          // A disabled site's Under Attack does not count.
          site("x", {
            enabled: false,
            protection: { ...DEFAULT_SITE_PROTECTION, underAttack: true },
          }),
          site("b"),
        ],
        platformProtection: { underAttack: false, underAttackChallenge: "pow" },
        challengeKeys: keys,
      },
      1n,
    );
    expect(unused.platformProtection).toBeUndefined();
    expect(unused.challengeKeys).toEqual([]);
    expect(unused.sites.every((s) => s.protection === undefined)).toBe(true);
    expect(unused.requiredFeatures).not.toContain("challenge-v1");
    expect(unused.contentHash).toBe(plain.contentHash);
  });

  it("compiles Under Attack with the keys sorted by id and every site's protection", () => {
    const input = {
      clusterId: "c",
      sites: [
        site("a", { protection: { ...DEFAULT_SITE_PROTECTION, underAttack: true } }),
        site("b"),
      ],
      challengeKeys: keys,
    };
    expect(usesChallenges(input)).toBe(true);
    const config = compileNodeConfig(input, 1n);
    expect(config.challengeKeys.map((k) => [k.id, k.role])).toEqual([
      ["k1", "previous"],
      ["k2", "current"],
      ["k3", "next"],
    ]);
    expect(config.platformProtection).toMatchObject({
      underAttack: false,
      underAttackChallenge: "js",
    });
    expect(config.sites.map((s) => s.protection?.underAttack)).toEqual([true, false]);
    expect(config.sites[1]?.protection).toMatchObject({
      passTtlSeconds: 1800,
      powDifficulty: 16,
      powHighDifficulty: 20,
      underAttackChallenge: "js",
    });
    expect(config.sites[1]?.protection?.cc).toBeUndefined();
    expect(config.requiredFeatures).toContain("challenge-v1");
    expect(config.requiredFeatures).not.toContain("ja4-v1");
    // Input order of the keys does not change the hash.
    const reversed = compileNodeConfig({ ...input, challengeKeys: [...keys].reverse() }, 1n);
    expect(reversed.contentHash).toBe(config.contentHash);
  });

  it("compiles an enabled CC policy and leaves a disabled one out", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c",
        sites: [site("a", { protection: { ...DEFAULT_SITE_PROTECTION, cc } })],
        challengeKeys: keys,
      },
      1n,
    );
    expect(config.sites[0]?.protection?.cc).toMatchObject({ enabled: true, ...cc });
    expect(config.requiredFeatures).toContain("challenge-v1");
    const off = compileNodeConfig(
      { clusterId: "c", sites: [site("a", { protection: DEFAULT_SITE_PROTECTION })] },
      1n,
    );
    expect(off.sites[0]?.protection).toBeUndefined();
  });

  it("uses challenges for a challenge rule and compiles its type", () => {
    const siteRule = compileNodeConfig(
      { clusterId: "c", sites: [site("a", { rules: [rule()] }), site("b")], challengeKeys: keys },
      1n,
    );
    expect(siteRule.sites[0]?.rules[0]?.action).toMatchObject({
      kind: "challenge",
      challenge: "pow",
    });
    expect(siteRule.challengeKeys).toHaveLength(3);
    expect(siteRule.requiredFeatures).toEqual(expect.arrayContaining(["challenge-v1", "rules-v1"]));
    const platformRule = compileNodeConfig(
      { clusterId: "c", sites: [site("a")], platformRules: [rule()], challengeKeys: keys },
      1n,
    );
    expect(platformRule.platformRules[0]?.action?.challenge).toBe("pow");
    expect(platformRule.sites[0]?.protection).toBeDefined();
  });

  it("uses challenges for platform Under Attack", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c",
        sites: [site("a")],
        platformProtection: { underAttack: true, underAttackChallenge: "cookie302" },
        challengeKeys: keys,
      },
      1n,
    );
    expect(config.platformProtection).toMatchObject({
      underAttack: true,
      underAttackChallenge: "cookie302",
    });
    expect(config.sites[0]?.protection?.underAttack).toBe(false);
    expect(config.requiredFeatures).toContain("challenge-v1");
  });

  it("requires ja4-v1 for tls.ja4 rules, JA4 rate limit keys and JA4 logging", () => {
    const expression = compileNodeConfig(
      {
        clusterId: "c",
        sites: [
          site("a", {
            rules: [
              rule({
                expression: parseExpression('tls.ja4 eq "t13d1516h2_8daaf6152771_02713d6af862"'),
                action: { kind: "block", statusCode: 403 },
              }),
            ],
          }),
        ],
      },
      1n,
    );
    expect(expression.requiredFeatures).toContain("ja4-v1");
    expect(expression.requiredFeatures).not.toContain("challenge-v1");
    const key = compileNodeConfig(
      {
        clusterId: "c",
        sites: [],
        platformRules: [
          rule({
            phase: "ratelimit",
            expression: parseExpression("true"),
            action: {
              kind: "rate_limit",
              statusCode: 429,
              limit: 5,
              windowSeconds: 10,
              key: "tls.ja4",
            },
          }),
        ],
      },
      1n,
    );
    expect(key.requiredFeatures).toContain("ja4-v1");
    // JA4 logging alone ships that site's protection, without keys.
    const logging = compileNodeConfig(
      {
        clusterId: "c",
        sites: [site("a", { protection: { ...DEFAULT_SITE_PROTECTION, logJa4: true } }), site("b")],
        challengeKeys: keys,
      },
      1n,
    );
    expect(logging.sites[0]?.protection?.logJa4).toBe(true);
    expect(logging.sites[1]?.protection).toBeUndefined();
    expect(logging.challengeKeys).toEqual([]);
    expect(logging.platformProtection).toBeUndefined();
    expect(logging.requiredFeatures).toEqual(expect.arrayContaining(["challenge-v1", "ja4-v1"]));
  });

  it("carries platform protection and keys in full in diffs", () => {
    const protectedConfig = compileNodeConfig(
      {
        clusterId: "c",
        sites: [site("a"), site("b")],
        platformProtection: { underAttack: true, underAttackChallenge: "js" },
        challengeKeys: keys,
      },
      2n,
    );
    const diff = diffNodeConfig(plain, protectedConfig);
    expect(diff.platformProtection?.underAttack).toBe(true);
    expect(diff.challengeKeys.map((k) => k.id)).toEqual(["k1", "k2", "k3"]);
    expect(applyNodeConfigDiff(plain, diff).contentHash).toBe(protectedConfig.contentHash);
    const back = diffNodeConfig(
      protectedConfig,
      compileNodeConfig({ clusterId: "c", sites: [site("a"), site("b")] }, 3n),
    );
    const applied = applyNodeConfigDiff(protectedConfig, back);
    expect(applied.platformProtection).toBeUndefined();
    expect(applied.challengeKeys).toEqual([]);
  });
});

describe("Brotli, Zstandard and OWASP CRS", () => {
  const tls: TlsModel = {
    forceHttps: false,
    hstsMaxAge: 0,
    hstsIncludeSubdomains: false,
    hstsPreload: false,
    minimumVersion: "1.2",
    cipherProfile: "modern",
    http2: true,
    http3: false,
    gzip: true,
    gzipMinLength: 256,
    gzipTypes: ["text/html"],
    ocspStapling: false,
  };
  const types = ["text/plain", "text/html", "text/html"];
  const compile = (sites: SiteModel[]) => compileNodeConfig({ clusterId: "c", sites }, 1n);
  const waf = {
    mode: "block" as const,
    paranoiaLevel: 2,
    anomalyThreshold: 7,
    excludedRuleIds: [942100, 920350, 942100],
    requestBodyLimit: 65536,
  };

  it("leaves the fields and features out while off, keeping the content hash", () => {
    const before = compile([site("a", { tls })]);
    const off = compile([
      site("a", {
        tls: {
          ...tls,
          brotli: false,
          brotliLevel: 6,
          brotliMinLength: 256,
          brotliTypes: types,
          zstd: false,
          zstdLevel: 3,
          zstdMinLength: 256,
          zstdTypes: types,
        },
        waf: null,
      }),
    ]);
    expect(off.contentHash).toBe(before.contentHash);
    expect(off.sites[0]?.tls).toMatchObject({ brotli: false, brotliLevel: 0, brotliTypes: [] });
    expect(off.sites[0]?.waf).toBeUndefined();
    expect(off.requiredFeatures).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^(brotli|zstd|modsecurity)-v1$/)]),
    );
  });

  it("compiles Brotli and Zstandard with sorted types and requires their features", () => {
    const config = compile([
      site("a", {
        tls: { ...tls, brotli: true, brotliLevel: 11, brotliMinLength: 512, brotliTypes: types },
      }),
      site("b", {
        tls: { ...tls, zstd: true, zstdLevel: 19, zstdMinLength: 1024, zstdTypes: types },
      }),
    ]);
    expect(config.sites[0]?.tls).toMatchObject({
      brotli: true,
      brotliLevel: 11,
      brotliMinLength: 512,
      brotliTypes: ["text/html", "text/plain"],
      zstd: false,
      zstdTypes: [],
    });
    expect(config.sites[1]?.tls).toMatchObject({
      brotli: false,
      zstd: true,
      zstdLevel: 19,
      zstdMinLength: 1024,
      zstdTypes: ["text/html", "text/plain"],
    });
    expect(config.requiredFeatures).toEqual(
      expect.arrayContaining(["brotli-v1", "zstd-v1", "tls-v1"]),
    );
    expect(config.requiredFeatures).not.toContain("modsecurity-v1");
    // Only enabled sites count.
    const disabled = compile([
      site("a", { enabled: false, tls: { ...tls, brotli: true, brotliLevel: 6 } }),
    ]);
    expect(disabled.requiredFeatures).not.toContain("brotli-v1");
  });

  it("compiles CRS with sorted, unique exclusions and requires modsecurity-v1", () => {
    const config = compile([site("a", { waf }), site("b")]);
    expect(config.sites[0]?.waf).toMatchObject({
      mode: "block",
      paranoiaLevel: 2,
      anomalyThreshold: 7,
      excludedRuleIds: [920350, 942100],
      requestBodyLimit: 65536,
    });
    expect(config.sites[1]?.waf).toBeUndefined();
    expect(config.requiredFeatures).toContain("modsecurity-v1");
    expect(nodeRequirements(config)).toContain("modsecurity-v1");
    // The features follow the compiled sites (rollback recomputes them the same way).
    expect(moduleFeatures(config)).toEqual(["modsecurity-v1"]);
    config.sites = config.sites.filter((s) => s.id !== "a");
    expect(moduleFeatures(config)).toEqual([]);
    const detect = compile([site("a", { waf: { ...waf, mode: "detect", requestBodyLimit: 0 } })]);
    expect(detect.sites[0]?.waf).toMatchObject({ mode: "detect", requestBodyLimit: 0 });
    expect(compile([site("a", { enabled: false, waf })]).requiredFeatures).not.toContain(
      "modsecurity-v1",
    );
  });

  it("hashes and diffs the new fields like every other site field", () => {
    const plain = compile([site("a", { tls }), site("b")]);
    const changed = compileNodeConfig(
      {
        clusterId: "c",
        sites: [
          site("a", {
            tls: { ...tls, zstd: true, zstdLevel: 3, zstdMinLength: 256, zstdTypes: types },
          }),
          site("b", { waf }),
        ],
      },
      2n,
    );
    expect(changed.contentHash).not.toBe(plain.contentHash);
    const diff = diffNodeConfig(plain, changed);
    expect(diff.upsertedSites.map((s) => s.id).sort()).toEqual(["a", "b"]);
    expect(applyNodeConfigDiff(plain, diff).contentHash).toBe(changed.contentHash);
    const decoded = decodeNodeConfig(encodeNodeConfig(changed));
    expect(decoded.sites.find((s) => s.id === "b")?.waf?.excludedRuleIds).toEqual([920350, 942100]);
    expect(contentHash(decoded)).toBe(changed.contentHash);
  });
});

describe("Cache-Tag, active health checks, session affinity, error pages and offline hosts", () => {
  const keys = [
    { id: "k2", role: "current" },
    { id: "k1", role: "previous" },
    { id: "k3", role: "next" },
  ];
  const health: ActiveHealthCheckModel = {
    path: "/healthz",
    method: "GET",
    expectedStatusMin: 200,
    expectedStatusMax: 399,
    host: "",
    intervalSeconds: 30,
    timeoutSeconds: 5,
    healthyThreshold: 2,
    unhealthyThreshold: 3,
  };
  const withPool = (
    id: string,
    pool: Partial<SiteModel["originPool"]>,
    overrides: Partial<SiteModel> = {},
  ) => {
    const model = site(id, overrides);
    return { ...model, originPool: { ...model.originPool, ...pool } };
  };
  const pages = [
    { status: 503, template: "<h1>{{status}}</h1>" },
    { status: 403, template: "denied {{request_id}}" },
  ];
  const offline: OfflineHostModel[] = [
    { name: "old.test", wildcard: false, reason: "disabled" },
    { name: "away.test", wildcard: true, reason: "disabled" },
    { name: "away.test", wildcard: false, reason: "disabled" },
  ];
  const plain = compileNodeConfig({ clusterId: "c", sites: [site("a"), site("b")] }, 1n);

  it("leaves every new field out by default, keeping the content hash", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c",
        sites: [
          withPool(
            "a",
            { activeHealthCheck: null, sessionAffinity: null },
            { keepCacheTag: false, errorPages: { pages: [], interceptOriginErrors: true } },
          ),
          site("b", { errorPages: null }),
        ],
        platformErrorPages: { unknownHost: "", siteDisabled: "" },
        offlineHosts: [],
        challengeKeys: keys,
      },
      1n,
    );
    expect(config.contentHash).toBe(plain.contentHash);
    expect(config.sites[0]?.errorPages).toBeUndefined();
    expect(config.platformErrorPages).toBeUndefined();
    expect(config.challengeKeys).toEqual([]);
    expect(poolAndPageFeatures(config)).toEqual([]);
  });

  it("compiles keepCacheTag, platform pages and offline hosts without requiring a feature", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c",
        sites: [site("a", { keepCacheTag: true }), site("b")],
        platformErrorPages: { unknownHost: "", siteDisabled: "<p>later</p>" },
        offlineHosts: offline,
      },
      1n,
    );
    expect(config.sites.map((s) => s.keepCacheTag)).toEqual([true, false]);
    expect(config.platformErrorPages).toMatchObject({
      unknownHost: "",
      siteDisabled: "<p>later</p>",
    });
    expect(config.offlineHosts.map((h) => [h.name, h.wildcard, h.reason])).toEqual([
      ["away.test", false, "disabled"],
      ["away.test", true, "disabled"],
      ["old.test", false, "disabled"],
    ]);
    expect(config.requiredFeatures).toEqual([]);
    expect(nodeRequirements(config)).toEqual([]);
    expect(config.contentHash).not.toBe(plain.contentHash);
  });

  it("compiles enabled active health checks with active-health-v1, served sites only", () => {
    const config = compileNodeConfig(
      { clusterId: "c", sites: [withPool("a", { activeHealthCheck: health }), site("b")] },
      1n,
    );
    expect(config.sites[0]?.originPool?.activeHealthCheck).toMatchObject({
      path: "/healthz",
      method: "GET",
      expectedStatusMin: 200,
      expectedStatusMax: 399,
      host: "",
      intervalSeconds: 30,
      timeoutSeconds: 5,
      healthyThreshold: 2,
      unhealthyThreshold: 3,
    });
    expect(config.sites[1]?.originPool?.activeHealthCheck).toBeUndefined();
    expect(config.requiredFeatures).toEqual(["active-health-v1"]);
    const disabled = compileNodeConfig(
      {
        clusterId: "c",
        sites: [withPool("a", { activeHealthCheck: health }, { enabled: false }), site("b")],
      },
      1n,
    );
    expect(disabled.requiredFeatures).not.toContain("active-health-v1");
  });

  it("carries the cluster's keys for session affinity and requires challenge-v1 with session-affinity-v1", () => {
    const input = {
      clusterId: "c",
      sites: [withPool("a", { sessionAffinity: { ttlSeconds: 600 } }), site("b")],
      challengeKeys: keys,
    };
    expect(usesChallenges(input)).toBe(false);
    expect(usesChallengeKeys(input)).toBe(true);
    const config = compileNodeConfig(input, 1n);
    expect(config.sites[0]?.originPool?.sessionAffinity?.ttlSeconds).toBe(600);
    expect(config.challengeKeys.map((k) => [k.id, k.role])).toEqual([
      ["k1", "previous"],
      ["k2", "current"],
      ["k3", "next"],
    ]);
    // Keys without challenges: no platform or site protection.
    expect(config.platformProtection).toBeUndefined();
    expect(config.sites.every((s) => s.protection === undefined)).toBe(true);
    expect(config.requiredFeatures).toEqual(["challenge-v1", "session-affinity-v1"]);
    // A disabled site's affinity does not count.
    const disabled = {
      ...input,
      sites: [withPool("a", { sessionAffinity: { ttlSeconds: 600 } }, { enabled: false })],
    };
    expect(usesChallengeKeys(disabled)).toBe(false);
    expect(compileNodeConfig(disabled, 1n).challengeKeys).toEqual([]);
  });

  it("compiles a site's error pages sorted by status, only with pages, and requires error-pages-v1", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c",
        sites: [site("a", { errorPages: { pages, interceptOriginErrors: true } }), site("b")],
      },
      1n,
    );
    expect(config.sites[0]?.errorPages?.pages.map((p) => [p.status, p.template])).toEqual([
      [403, "denied {{request_id}}"],
      [503, "<h1>{{status}}</h1>"],
    ]);
    expect(config.sites[0]?.errorPages?.interceptOriginErrors).toBe(true);
    expect(config.sites[1]?.errorPages).toBeUndefined();
    expect(config.requiredFeatures).toEqual(["error-pages-v1"]);
    // The input order of the pages does not change the hash.
    const reversed = compileNodeConfig(
      {
        clusterId: "c",
        sites: [
          site("a", { errorPages: { pages: [...pages].reverse(), interceptOriginErrors: true } }),
          site("b"),
        ],
      },
      1n,
    );
    expect(reversed.contentHash).toBe(config.contentHash);
  });

  it("sorts offline hosts by name and wildcard and error pages by status when canonicalizing", () => {
    const config = create(NodeConfigSchema, {
      clusterId: "c",
      offlineHosts: [
        { name: "b.test", wildcard: false, reason: "disabled" },
        { name: "a.test.example", wildcard: false, reason: "disabled" },
        { name: "a.test", wildcard: true, reason: "disabled" },
        { name: "a.test", wildcard: false, reason: "disabled" },
      ],
      sites: [
        {
          id: "s",
          errorPages: {
            pages: [
              { status: 504, template: "c" },
              { status: 429, template: "b" },
              { status: 403, template: "a" },
            ],
          },
        },
      ],
    });
    const canonical = canonicalize(config);
    expect(canonical.offlineHosts.map((h) => `${h.name}/${h.wildcard}`)).toEqual([
      "a.test/false",
      "a.test/true",
      "a.test.example/false",
      "b.test/false",
    ]);
    expect(canonical.sites[0]?.errorPages?.pages.map((p) => p.status)).toEqual([403, 429, 504]);
    // The input is left as it was.
    expect(config.offlineHosts[0]?.name).toBe("b.test");
  });

  it("carries platform pages and offline hosts in full in diffs and recomputes nothing for them", () => {
    const target = compileNodeConfig(
      {
        clusterId: "c",
        sites: [site("a"), site("b")],
        platformErrorPages: { unknownHost: "<p>nobody</p>", siteDisabled: "" },
        offlineHosts: offline,
      },
      2n,
    );
    const diff = diffNodeConfig(plain, target);
    expect(diff.upsertedSites).toEqual([]);
    expect(diff.platformErrorPages?.unknownHost).toBe("<p>nobody</p>");
    expect(diff.offlineHosts).toHaveLength(3);
    expect(applyNodeConfigDiff(plain, diff).contentHash).toBe(target.contentHash);
    // And back: empty values in the diff clear them.
    const back = applyNodeConfigDiff(target, diffNodeConfig(target, { ...plain, revision: 3n }));
    expect(back.platformErrorPages).toBeUndefined();
    expect(back.offlineHosts).toEqual([]);
    expect(back.contentHash).toBe(plain.contentHash);
  });

  it("compiles HTTP/2 and gRPC towards the origins with origin-http2-v1, HTTP/1.1 as before", () => {
    const settings: OriginPoolSettingsModel = {
      tlsVerify: true,
      maxFails: 3,
      recoverySeconds: 30,
      connectTimeoutMs: 10_000,
      sendTimeoutMs: 60_000,
      readTimeoutMs: 60_000,
      keepalive: true,
      keepaliveIdleSeconds: 60,
      keepaliveMaxRequests: 1000,
    };
    const compile = (extra: Partial<OriginPoolSettingsModel>, overrides: Partial<SiteModel> = {}) =>
      compileNodeConfig(
        {
          clusterId: "c",
          sites: [withPool("a", { settings: { ...settings, ...extra } }, overrides), site("b")],
        },
        1n,
      );
    const bare = compile({});
    const http1 = compile({ protocol: "http1", grpc: false });
    expect(http1.contentHash).toBe(bare.contentHash);
    expect(http1.sites[0]?.originPool?.protocol).toBe(OriginProtocol.UNSPECIFIED);
    expect(http1.requiredFeatures).toEqual([]);
    const h2 = compile({ protocol: "http2" });
    expect(h2.sites[0]?.originPool).toMatchObject({ protocol: OriginProtocol.HTTP2, grpc: false });
    expect(h2.sites[1]?.originPool?.protocol).toBe(OriginProtocol.UNSPECIFIED);
    expect(h2.requiredFeatures).toEqual([ORIGIN_HTTP2_FEATURE]);
    const grpc = compile({ protocol: "http2", grpc: true });
    expect(grpc.sites[0]?.originPool).toMatchObject({ protocol: OriginProtocol.HTTP2, grpc: true });
    expect(poolAndPageFeatures(grpc)).toEqual([ORIGIN_HTTP2_FEATURE]);
    expect(grpc.contentHash).not.toBe(h2.contentHash);
    // The node enables HTTP/2 towards clients for gRPC sites itself.
    expect(grpc.listeners).toEqual(bare.listeners);
    // gRPC goes over HTTP/2 only (the contract refuses it otherwise).
    expect(compile({ grpc: true }).contentHash).toBe(bare.contentHash);
    // A disabled site is not shipped and requires nothing.
    expect(compile({ protocol: "http2", grpc: true }, { enabled: false }).requiredFeatures).toEqual(
      [],
    );
    const decoded = decodeNodeConfig(encodeNodeConfig(grpc));
    expect(decoded.sites[0]?.originPool).toMatchObject({
      protocol: OriginProtocol.HTTP2,
      grpc: true,
    });
    expect(contentHash(decoded)).toBe(grpc.contentHash);
  });

  it("follows the compiled sites when the features are recomputed (rollback)", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c",
        sites: [
          withPool("a", { activeHealthCheck: health, sessionAffinity: { ttlSeconds: 60 } }),
          site("b", { errorPages: { pages, interceptOriginErrors: false } }),
        ],
        challengeKeys: keys,
      },
      1n,
    );
    expect(poolAndPageFeatures(config)).toEqual([
      "active-health-v1",
      "session-affinity-v1",
      "error-pages-v1",
    ]);
    config.sites = config.sites.filter((s) => s.id !== "a");
    expect(poolAndPageFeatures(config)).toEqual(["error-pages-v1"]);
  });
});

describe("rule engine extensions (rules-v2)", () => {
  const keys = [
    { id: "k2", role: "current" },
    { id: "k1", role: "previous" },
    { id: "k3", role: "next" },
  ];
  const rule = (
    phase: string,
    action: RuleModel["action"],
    expression = "true",
    id = `r-${phase}`,
  ): RuleModel => ({
    id,
    phase,
    expression: parseExpression(expression, phase as Parameters<typeof parseExpression>[1]),
    action,
  });
  const compile = (overrides: Partial<SiteModel> = {}, platformRules: RuleModel[] = []) =>
    compileNodeConfig(
      { clusterId: "c", sites: [site("a", overrides), site("b")], platformRules },
      1n,
    );
  const compiledRules = (config: ReturnType<typeof compile>) =>
    config.sites.find((s) => s.id === "a")?.rules ?? [];
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
      })),
    };
  };
  const plain = compileNodeConfig({ clusterId: "c", sites: [site("a"), site("b")] }, 1n);

  it("keeps the encoding of rules, cache rules and origins that use none of the extensions", () => {
    const legacy = [
      rule("redirect", { kind: "redirect", value: "/new", statusCode: 301 }),
      rule("request-transform", { kind: "rewrite", value: "/index.html" }),
      rule("config", { kind: "config", cacheBypass: true, gzip: false }),
      rule("waf-custom", { kind: "challenge", type: "js" }),
    ];
    // The same rules as the contract parses them now: defaults of the new fields filled in.
    const parsed = [
      rule("redirect", {
        kind: "redirect",
        value: "/new",
        target: "",
        statusCode: 301,
        preserveQuery: false,
        setQuery: [],
        removeQuery: [],
      }),
      rule("request-transform", {
        kind: "rewrite",
        value: "/index.html",
        target: "",
        preserveQuery: true,
        setQuery: [],
        removeQuery: [],
      }),
      rule("config", { kind: "config", cacheBypass: true, gzip: false }),
      rule("waf-custom", { kind: "challenge", type: "js" }),
    ];
    const before = compile({ rules: legacy }, []);
    const after = compileNodeConfig(
      {
        clusterId: "c",
        sites: [
          site("a", {
            rules: parsed,
            bulkRedirects: [],
            originPool: {
              ...site("a").originPool,
              origins: site("a").originPool.origins.map((o) => ({ ...o, group: "" })),
            },
            cacheRules: site("a").cacheRules.map((r) => ({ ...r, browserTtlSeconds: 0 })),
          }),
          site("b"),
        ],
      },
      1n,
    );
    expect(after.contentHash).toBe(before.contentHash);
    expect(rulesFeatures(after)).toEqual([]);
    expect(after.requiredFeatures).not.toContain("rules-v2");
    expect(rulesFeatures(plain)).toEqual([]);
  });

  it("compiles redirect and rewrite targets, query edits and preserve_query only where it differs from the kind's default", () => {
    const config = compile({
      rules: [
        rule(
          "redirect",
          {
            kind: "redirect",
            value: "",
            target: 'concat("https://", lower(http.host), http.request.uri.path)',
            statusCode: 308,
            preserveQuery: true,
            setQuery: [
              { name: "z", value: "last" },
              { name: "a", value: "first one" },
            ],
            removeQuery: ["utm_source", "fbclid", "utm_source"],
          },
          'starts_with(http.request.uri.path, "/go/")',
        ),
        rule("request-transform", {
          kind: "rewrite",
          value: "",
          target: 'regex_replace(http.request.uri.path, "^/old/(.*)$", "/new/${1}")',
          preserveQuery: false,
          setQuery: [],
          removeQuery: [],
        }),
        rule("request-transform", {
          kind: "rewrite",
          value: "/static",
          target: "",
          preserveQuery: true,
          setQuery: [{ name: "v", value: "2" }],
          removeQuery: [],
        }),
      ],
    });
    const [rewrite, staticRewrite, redirect] = compiledRules(config);
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
    expect(redirect?.action?.target).toMatchObject({
      op: "call",
      field: "concat",
      valueType: "string",
      children: [
        { op: "const", value: "https://" },
        { op: "call", field: "lower", children: [{ op: "field", field: "http.host" }] },
        { op: "field", field: "http.request.uri.path" },
      ],
    });
    expect(rewrite?.action?.preserveQuery).toBe(false);
    expect(rewrite?.action?.target?.field).toBe("regex_replace");
    // A rewrite keeps the query by default: true is not encoded.
    expect(staticRewrite?.action?.preserveQuery).toBeUndefined();
    expect(staticRewrite?.action?.target).toBeUndefined();
    for (const compiled of compiledRules(config))
      expect(validActionIr(compiled.phase, toIr(compiled.action)), compiled.id).toBe(true);
    expect(config.requiredFeatures).toEqual(["rules-v1", "rules-v2"]);
  });

  it("compiles origin, compression and extended config actions in their phases", () => {
    const config = compile({
      rules: [
        rule(
          "origin",
          {
            kind: "origin",
            originGroup: "media",
            hostHeader: "media.example.com",
            sni: "sni.example.com",
            port: 8443,
          },
          'http.request.uri.path.extension in {"mp4" "webm"}',
        ),
        rule(
          "compression",
          { kind: "compression", algorithms: ["zstd", "gzip"] },
          'http.response.content_type.media_type eq "text/html"',
        ),
        rule("compression", { kind: "compression", algorithms: [] }, "true", "r-off"),
        rule("config", {
          kind: "config",
          gzip: true,
          brotli: false,
          zstd: true,
          websocket: false,
          underAttack: false,
          ccEnabled: true,
          ccMaxLevel: "pow",
          originConnectTimeoutMs: 2000,
          originSendTimeoutMs: 30000,
          originReadTimeoutMs: 120000,
          logSampleRate: 0,
        }),
      ],
    });
    const compiled = compiledRules(config);
    expect(compiled.map((r) => r.phase)).toEqual([
      "config",
      "origin",
      "compression",
      "compression",
    ]);
    expect(compiled[0]?.action).toMatchObject({
      gzip: true,
      brotli: false,
      zstd: true,
      websocket: false,
      underAttack: false,
      ccEnabled: true,
      ccMaxLevel: "pow",
      originConnectTimeoutMs: 2000,
      originSendTimeoutMs: 30000,
      originReadTimeoutMs: 120000,
      // Present although 0: the rule stops sampling.
      logSampleRate: 0,
    });
    expect(compiled[0]?.action?.cacheBypass).toBeUndefined();
    expect(compiled[1]?.action).toMatchObject({
      kind: "origin",
      originGroup: "media",
      hostHeader: "media.example.com",
      sni: "sni.example.com",
      port: 8443,
    });
    expect(compiled[2]?.action?.compression).toEqual(["zstd", "gzip"]);
    expect(compiled[3]?.action?.compression).toEqual([]);
    for (const r of compiled) expect(validActionIr(r.phase, toIr(r.action)), r.id).toBe(true);
    // Under Attack turned off by a rule challenges nothing.
    expect(config.platformProtection).toBeUndefined();
    expect(config.requiredFeatures).toContain("rules-v2");
  });

  it("requires rules-v2 for every extension, one at a time", () => {
    const cases: [string, Partial<SiteModel>, RuleModel[]][] = [
      [
        "a function",
        { rules: [rule("waf-custom", { kind: "log" }, 'lower(http.host) eq "a"')] },
        [],
      ],
      [
        "a new field",
        { rules: [rule("waf-custom", { kind: "log" }, 'http.request.full_uri contains "x"')] },
        [],
      ],
      ["gzip on", { rules: [rule("config", { kind: "config", gzip: true })] }, []],
      ["a config field", {}, [rule("config", { kind: "config", websocket: true })]],
      ["a timeout", { rules: [rule("config", { kind: "config", originReadTimeoutMs: 500 })] }, []],
      ["the CC level", { rules: [rule("config", { kind: "config", ccMaxLevel: "js" })] }, []],
      [
        "a target",
        {
          rules: [rule("redirect", { kind: "redirect", target: "http.host", statusCode: 302 })],
        },
        [],
      ],
      [
        "a removed query parameter",
        {
          rules: [
            rule("redirect", {
              kind: "redirect",
              value: "/x",
              statusCode: 301,
              removeQuery: ["a"],
            }),
          ],
        },
        [],
      ],
      [
        "a kept redirect query",
        {},
        [rule("redirect", { kind: "redirect", value: "/x", statusCode: 301, preserveQuery: true })],
      ],
      [
        "a dropped rewrite query",
        {
          rules: [rule("request-transform", { kind: "rewrite", value: "/", preserveQuery: false })],
        },
        [],
      ],
      ["an origin action", { rules: [rule("origin", { kind: "origin", port: 8080 })] }, []],
      [
        "the compression phase",
        { rules: [rule("compression", { kind: "compression", algorithms: ["br"] })] },
        [],
      ],
      [
        "a browser TTL",
        {
          cacheRules: [
            {
              ...site("a").cacheRules[0],
              browserTtlSeconds: 60,
            } as SiteModel["cacheRules"][number],
          ],
        },
        [],
      ],
      [
        "a cache condition",
        {
          cacheRules: [
            {
              id: "c1",
              priority: 1,
              pathPrefixes: [],
              extensions: [],
              expression: 'http.host eq "a.test"',
              action: "cache",
              edgeTtlSeconds: 60,
              originCacheControl: "override",
            },
          ],
        },
        [],
      ],
      [
        "a bulk redirect",
        { bulkRedirects: [{ source: "/a", target: "/b", statusCode: 301, preserveQuery: false }] },
        [],
      ],
      [
        "an origin group",
        {
          originPool: {
            ...site("a").originPool,
            origins: [
              ...site("a").originPool.origins,
              {
                ...site("a").originPool.origins[0],
                id: "o3",
                group: "eu",
              } as SiteModel["originPool"]["origins"][number],
            ],
          },
        },
        [],
      ],
    ];
    for (const [name, overrides, platform] of cases) {
      const config = compile(overrides, platform);
      expect(rulesFeatures(config), name).toEqual(["rules-v2"]);
      expect(config.requiredFeatures, name).toContain("rules-v2");
    }
    // A disabled site's extensions are not shipped and require nothing.
    const disabled = compileNodeConfig(
      {
        clusterId: "c",
        sites: [
          site("a", {
            enabled: false,
            bulkRedirects: [{ source: "/a", target: "/b", statusCode: 301, preserveQuery: false }],
          }),
          site("b"),
        ],
      },
      1n,
    );
    expect(disabled.requiredFeatures).not.toContain("rules-v2");
  });

  it("compiles cache rule expressions of the builder's shape to the structured lists, others to a condition", () => {
    const structured = {
      pathPrefixes: ["/b/", "/a/"],
      paths: ["/z", "/index.html"],
      extensions: ["png", "css"],
    };
    const legacy = compile({
      cacheRules: [
        {
          id: "c1",
          priority: 1,
          ...structured,
          expression: "",
          action: "cache",
          edgeTtlSeconds: 60,
          originCacheControl: "override",
        },
      ],
    });
    const expression = cacheConditionExpression(structured);
    const migrated = compile({
      cacheRules: [
        {
          id: "c1",
          priority: 1,
          pathPrefixes: [],
          extensions: [],
          expression,
          action: "cache",
          edgeTtlSeconds: 60,
          originCacheControl: "override",
        },
      ],
    });
    const match = migrated.sites[0]?.cacheRules[0]?.match;
    expect(match?.pathPrefixes).toEqual(["/b/", "/a/"]);
    expect(match?.paths).toEqual(["/index.html", "/z"]);
    // Sets in expressions are sorted: the extensions' order may change once.
    expect(match?.extensions).toEqual(["css", "png"]);
    expect(match?.condition).toBeUndefined();
    expect(match?.expression).toBe("");
    expect(rulesFeatures(migrated)).toEqual([]);
    // With the extensions already in order the migrated rule hashes as before.
    const sorted = { ...structured, extensions: ["css", "png"] };
    const before = compile({
      cacheRules: [
        {
          id: "c1",
          priority: 1,
          ...sorted,
          expression: "",
          action: "cache",
          edgeTtlSeconds: 60,
          originCacheControl: "override",
        },
      ],
    });
    const after = compile({
      cacheRules: [
        {
          id: "c1",
          priority: 1,
          pathPrefixes: [],
          extensions: [],
          expression: cacheConditionExpression(sorted),
          action: "cache",
          edgeTtlSeconds: 60,
          originCacheControl: "override",
        },
      ],
    });
    expect(after.contentHash).toBe(before.contentHash);
    expect(legacy.sites[0]?.cacheRules[0]?.match?.extensions).toEqual(["png", "css"]);
    // "true" matches everything: no lists, no condition.
    const all = compile({
      cacheRules: [
        {
          id: "c1",
          priority: 1,
          pathPrefixes: [],
          extensions: [],
          expression: "true",
          action: "bypass",
          edgeTtlSeconds: 0,
          originCacheControl: "override",
        },
      ],
    });
    expect(all.sites[0]?.cacheRules[0]?.match).toMatchObject({
      pathPrefixes: [],
      paths: [],
      extensions: [],
    });
    expect(all.sites[0]?.cacheRules[0]?.match?.condition).toBeUndefined();
    // Anything else travels as the typed condition, lists bound by the caller.
    const conditionSource = 'lower(http.host) eq "cdn.a.test" or ip.src in $office';
    const condition = parseExpression(conditionSource, "cache");
    condition.children[1] = { ...(condition.children[1] as Expression), value: "list-1" };
    const typed = compile({
      cacheRules: [
        {
          id: "c1",
          priority: 1,
          pathPrefixes: [],
          extensions: [],
          expression: conditionSource,
          condition,
          browserTtlSeconds: 300,
          action: "cache",
          edgeTtlSeconds: 60,
          originCacheControl: "override",
        },
      ],
    });
    const rule = typed.sites[0]?.cacheRules[0];
    expect(rule?.browserTtlSeconds).toBe(300);
    expect(rule?.match).toMatchObject({
      pathPrefixes: [],
      paths: [],
      extensions: [],
      expression: "",
    });
    expect(rule?.match?.condition).toMatchObject({ op: "or" });
    expect(rule?.match?.condition?.children[1]).toMatchObject({ op: "in_list", value: "list-1" });
    expect(validExpressionIr(rule?.match?.condition as Expression, "cache")).toBe(true);
    expect(rulesFeatures(typed)).toEqual(["rules-v2"]);
  });

  it("compiles bulk redirects sorted by their UTF-8 bytes and origin groups", () => {
    const redirects = [
      { source: "a.test/x", target: "https://example.com/x", statusCode: 302, preserveQuery: true },
      { source: "/\u{1F600}", target: "/emoji", statusCode: 308, preserveQuery: false },
      { source: "/\uFF01", target: "/fullwidth", statusCode: 307, preserveQuery: false },
      { source: "/old", target: "/new", statusCode: 301, preserveQuery: false },
    ];
    const origins = site("a").originPool.origins;
    const config = compile({
      bulkRedirects: redirects,
      originPool: {
        ...site("a").originPool,
        origins: [origins[0], { ...origins[1], group: "eu" }] as SiteModel["originPool"]["origins"],
      },
    });
    const compiled = config.sites[0];
    // Byte order puts U+FF01 (EF BC 81) before U+1F600 (F0 9F 98 80); UTF-16 would not.
    expect(compiled?.bulkRedirects.map((r) => r.source)).toEqual([
      "/old",
      "/\uFF01",
      "/\u{1F600}",
      "a.test/x",
    ]);
    expect(compiled?.bulkRedirects[3]).toMatchObject({
      target: "https://example.com/x",
      statusCode: 302,
      preserveQuery: true,
    });
    expect(compiled?.originPool?.origins.map((o) => [o.id, o.group])).toEqual([
      ["o1-a", "eu"],
      ["o2-a", ""],
    ]);
    expect(config.requiredFeatures).toEqual(["rules-v2"]);
  });

  it("canonicalizes bulk redirects, set_query and remove_query of site and platform rules", () => {
    const config = compile(
      {
        rules: [
          rule("redirect", {
            kind: "redirect",
            value: "/x",
            statusCode: 301,
            setQuery: [
              { name: "b", value: "2" },
              { name: "a", value: "1" },
            ],
            removeQuery: ["d", "c", "d"],
          }),
        ],
        bulkRedirects: [
          { source: "/b", target: "/1", statusCode: 301, preserveQuery: false },
          { source: "/a", target: "/2", statusCode: 301, preserveQuery: false },
        ],
      },
      [
        rule("redirect", {
          kind: "redirect",
          value: "/y",
          statusCode: 302,
          setQuery: [
            { name: "y", value: "" },
            { name: "x", value: "" },
          ],
        }),
      ],
    );
    const shuffled = create(NodeConfigSchema, config);
    const site0 = shuffled.sites[0];
    const action = site0?.rules[0]?.action;
    if (!site0 || !action || !shuffled.platformRules[0]?.action) throw new Error("missing");
    site0.bulkRedirects.reverse();
    action.setQuery.reverse();
    action.removeQuery = ["d", "c", "d"];
    shuffled.platformRules[0].action.setQuery.reverse();
    const canonical = canonicalize(shuffled);
    expect(canonical.sites[0]?.bulkRedirects.map((r) => r.source)).toEqual(["/a", "/b"]);
    expect(canonical.sites[0]?.rules[0]?.action?.setQuery.map((p) => p.name)).toEqual(["a", "b"]);
    expect(canonical.sites[0]?.rules[0]?.action?.removeQuery).toEqual(["c", "d"]);
    expect(canonical.platformRules[0]?.action?.setQuery.map((p) => p.name)).toEqual(["x", "y"]);
    expect(contentHash(canonical)).toBe(config.contentHash);
    expect(applyNodeConfigDiff(plain, diffNodeConfig(plain, config)).contentHash).toBe(
      config.contentHash,
    );
  });

  it("reads GeoIP and JA4 in targets and cache conditions", () => {
    const geoTarget = compile({
      rules: [
        rule("redirect", {
          kind: "redirect",
          target: 'concat("/", lower(ip.geoip.country))',
          statusCode: 302,
        }),
      ],
    });
    expect(geoTarget.requiredFeatures).toContain("geoip-city-v1");
    const cache = (expression: string) =>
      compile({
        cacheRules: [
          {
            id: "c1",
            priority: 1,
            pathPrefixes: [],
            extensions: [],
            expression,
            action: "bypass",
            edgeTtlSeconds: 0,
            originCacheControl: "override",
          },
        ],
      });
    expect(cache("ip.geoip.asnum eq 64512").requiredFeatures).toContain("geoip-asn-v1");
    expect(nodeRequirements(cache('ip.geoip.subdivision eq "AUK"'))).toContain(
      "geoip-subdivision-v1",
    );
    const ja4 = cache('starts_with(tls.ja4, "t13d")');
    expect(ja4.requiredFeatures).toContain("ja4-v1");
    expect(protectionFeatures(ja4)).toEqual(["ja4-v1"]);
    // A function's name is never read as a field.
    expect(geoFeatures(parseExpression('starts_with(http.host, "ip.geoip.")'))).toEqual([]);
  });

  it("treats a config rule that turns Under Attack on as using challenges", () => {
    const underAttack = rule(
      "config",
      { kind: "config", underAttack: true },
      'starts_with(http.request.uri.path, "/login")',
    );
    for (const [sites, platformRules] of [
      [[site("a", { rules: [underAttack] }), site("b")], []],
      [[site("a"), site("b")], [underAttack]],
    ] as [SiteModel[], RuleModel[]][]) {
      const input = { clusterId: "c", sites, platformRules, challengeKeys: keys };
      expect(usesChallenges(input)).toBe(true);
      const config = compileNodeConfig(input, 1n);
      expect(config.platformProtection).toMatchObject({
        underAttack: false,
        underAttackChallenge: "js",
      });
      expect(config.challengeKeys.map((key) => key.id)).toEqual(["k1", "k2", "k3"]);
      // Every site carries its protection (defaults here) so that nodes can challenge.
      for (const compiled of config.sites)
        expect(compiled.protection).toMatchObject({
          underAttack: false,
          underAttackChallenge: DEFAULT_SITE_PROTECTION.underAttackChallenge,
          passTtlSeconds: DEFAULT_SITE_PROTECTION.passTtlSeconds,
          powDifficulty: DEFAULT_SITE_PROTECTION.powDifficulty,
          powHighDifficulty: DEFAULT_SITE_PROTECTION.powHighDifficulty,
        });
      expect(config.requiredFeatures).toEqual(expect.arrayContaining(["challenge-v1", "rules-v2"]));
      expect(protectionFeatures(config)).toContain("challenge-v1");
    }
    // Turning it off, or a disabled site's rule, challenges nothing.
    const off = rule("config", { kind: "config", underAttack: false });
    expect(usesChallenges({ clusterId: "c", sites: [site("a", { rules: [off] })] })).toBe(false);
    expect(
      usesChallenges({
        clusterId: "c",
        sites: [site("a", { enabled: false, rules: [underAttack] })],
      }),
    ).toBe(false);
  });
});

describe("refreshDerived", () => {
  const tls: TlsModel = {
    forceHttps: false,
    hstsMaxAge: 0,
    hstsIncludeSubdomains: false,
    hstsPreload: false,
    minimumVersion: "1.2",
    cipherProfile: "modern",
    http2: true,
    http3: true,
    gzip: true,
    gzipMinLength: 256,
    gzipTypes: ["text/html"],
    ocspStapling: false,
    brotli: true,
    brotliLevel: 5,
    brotliMinLength: 256,
    brotliTypes: ["text/html"],
  };
  const certificates = [
    create(CertificateRefSchema, { id: "cert-a", names: ["a.test"], sha256Fingerprint: "aa" }),
    create(CertificateRefSchema, { id: "cert-b", names: ["b.test"], sha256Fingerprint: "bb" }),
  ];
  const rule: RuleModel = {
    id: "geo",
    phase: "waf-custom",
    expression: parseExpression('ip.geoip.country eq "NZ"', "waf-custom"),
    action: { kind: "block", statusCode: 403 },
  };
  const sites = [
    site("a", { certificateId: "cert-a", tls, rules: [rule], logSampleRate: 500 }),
    site("b", { certificateId: "cert-b", tls: { ...tls, http3: false, brotli: false } }),
    site("c"),
  ];

  it("matches a compilation of the remaining sites after sites are dropped", () => {
    const config = compileNodeConfig({ clusterId: "c", sites, certificates }, 7n);
    expect(config.requiredFeatures).toEqual(
      expect.arrayContaining(["access-logs-v1", "brotli-v1", "geoip-city-v1", "http3-v1"]),
    );
    for (const keep of [["b", "c"], ["c"], []]) {
      const dropped = clone(NodeConfigSchema, config);
      dropped.sites = dropped.sites.filter((s) => keep.includes(s.id));
      const expected = compileNodeConfig(
        {
          clusterId: "c",
          sites: sites.filter((s) => keep.includes(s.id)),
          certificates: certificates.filter((c) => keep.includes(c.id.slice(-1))),
        },
        7n,
      );
      expect(refreshDerived(dropped), keep.join()).toEqual(expected);
    }
  });

  it("keeps a compiled configuration as it is", () => {
    const config = compileNodeConfig({ clusterId: "c", sites, certificates }, 7n);
    expect(refreshDerived(config)).toEqual(config);
  });
});

describe("domains waiting for the site's certificate (tls-pending-domains-v1)", () => {
  const domains = [
    { name: "a.test", wildcard: false },
    { name: "new.a.test", wildcard: false, tlsPending: true },
  ];

  it("marks the domains and requires the feature", () => {
    const config = compileNodeConfig(
      { clusterId: "c", sites: [site("a", { certificateId: "cert-a", domains })] },
      1n,
    );
    expect(
      config.sites[0]?.domains.map((d) => ({ name: d.name, tlsPending: d.tlsPending })),
    ).toEqual([
      { name: "a.test", tlsPending: false },
      { name: "new.a.test", tlsPending: true },
    ]);
    expect(config.requiredFeatures).toContain(TLS_PENDING_DOMAINS_FEATURE);
    expect(TLS_PENDING_DOMAINS_FEATURE).toBe("tls-pending-domains-v1");
  });

  it("ignores the flag on a site without a certificate", () => {
    const config = compileNodeConfig({ clusterId: "c", sites: [site("a", { domains })] }, 1n);
    expect(config.sites[0]?.domains.some((d) => d.tlsPending)).toBe(false);
    expect(config.requiredFeatures).not.toContain(TLS_PENDING_DOMAINS_FEATURE);
  });

  it("encodes a configuration without waiting domains as before", () => {
    const covered = [{ name: "a.test", wildcard: false }];
    const config = compileNodeConfig(
      { clusterId: "c", sites: [site("a", { certificateId: "cert-a", domains: covered })] },
      1n,
    );
    const flagged = compileNodeConfig(
      {
        clusterId: "c",
        sites: [
          site("a", {
            certificateId: "cert-a",
            domains: [{ name: "a.test", wildcard: false, tlsPending: false }],
          }),
        ],
      },
      1n,
    );
    expect(flagged.contentHash).toBe(config.contentHash);
    expect(config.requiredFeatures).not.toContain(TLS_PENDING_DOMAINS_FEATURE);
  });
});

describe("ruleModelOf", () => {
  const rules: RuleModel[] = [
    {
      id: "challenge",
      phase: "waf-custom",
      expression: parseExpression('http.request.uri.path contains "/admin/"', "waf-custom"),
      action: { kind: "challenge", type: "pow" },
    },
    {
      id: "redirect",
      phase: "redirect",
      expression: parseExpression('http.request.uri.path eq "/old"', "redirect"),
      action: {
        kind: "redirect",
        target: 'concat("https://", lower(http.host), "/new")',
        statusCode: 308,
        preserveQuery: true,
      },
    },
    {
      id: "attack",
      phase: "config",
      expression: parseExpression('ip.geoip.country eq "NZ"', "config"),
      action: { kind: "config", underAttack: true },
    },
  ];

  it("keeps compiled rules as they are, targets included", () => {
    const compiled = compileRules(rules);
    expect(compileRules(compiled.map(ruleModelOf))).toEqual(compiled);
  });

  it("compiles the same configuration, challenges included", () => {
    const config = compileNodeConfig({ clusterId: "c", sites: [site("a", { rules })] }, 3n);
    const again = compileNodeConfig(
      {
        clusterId: "c",
        sites: [site("a", { rules: config.sites[0]?.rules.map(ruleModelOf) ?? [] })],
      },
      3n,
    );
    expect(again).toEqual(config);
    expect(config.requiredFeatures).toEqual(expect.arrayContaining(["challenge-v1", "rules-v2"]));
  });
});

describe("layer-4 applications (l4-v1)", () => {
  const app = (id: string, overrides: Partial<L4AppModel> = {}): L4AppModel => ({
    id,
    enabled: true,
    protocol: "tcp",
    port: 20000,
    acceptProxyProtocol: false,
    proxyProtocolVersion: 0,
    origins: [
      { id: `${id}-o2`, address: "198.51.100.2", port: 7000, weight: 1, backup: true },
      { id: `${id}-o1`, address: "origin.example.com", port: 7000, weight: 3, backup: false },
    ],
    maxFails: 3,
    failTimeoutSeconds: 30,
    connectTimeoutMs: 5000,
    idleTimeoutSeconds: 600,
    allowListIds: [],
    blockListIds: [],
    maxConnections: 0,
    newConnectionsPerSecond: 0,
    ...overrides,
  });
  const plain = compileNodeConfig({ clusterId: "c", sites: [site("a")] }, 1n);

  it("encodes a configuration without applications exactly as before", () => {
    for (const l4Apps of [undefined, [], [app("x", { enabled: false })]]) {
      const config = compileNodeConfig({ clusterId: "c", sites: [site("a")], l4Apps }, 1n);
      expect(config.l4Apps).toEqual([]);
      expect(config.requiredFeatures).toEqual([]);
      expect(Buffer.from(encodeNodeConfig(config))).toEqual(Buffer.from(encodeNodeConfig(plain)));
    }
  });

  it("compiles TCP applications with PROXY protocol and requires l4-v1", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c",
        sites: [site("a")],
        l4Apps: [
          app("v2", {
            port: 20002,
            acceptProxyProtocol: true,
            proxyProtocolVersion: 2,
            maxFails: 5,
            failTimeoutSeconds: 60,
            connectTimeoutMs: 1500,
            idleTimeoutSeconds: 900,
            allowListIds: ["l2", "l1", "l2"],
            blockListIds: ["l3"],
            maxConnections: 100,
            newConnectionsPerSecond: 10,
          }),
          app("v1", { port: 20001, proxyProtocolVersion: 1 }),
          app("v0", { port: 20000 }),
        ],
      },
      1n,
    );
    expect(config.requiredFeatures).toEqual([L4_FEATURE]);
    expect(nodeRequirements(config)).toEqual(["l4-v1"]);
    expect(config.l4Apps.map((a) => [a.id, a.port, a.proxyProtocolVersion])).toEqual([
      ["v0", 20000, 0],
      ["v1", 20001, 1],
      ["v2", 20002, 2],
    ]);
    expect((toJson(NodeConfigSchema, config) as JsonObject).l4Apps).toEqual([
      expect.objectContaining({ id: "v0", protocol: "L4_PROTOCOL_TCP" }),
      expect.objectContaining({ id: "v1" }),
      {
        id: "v2",
        protocol: "L4_PROTOCOL_TCP",
        port: 20002,
        acceptProxyProtocol: true,
        proxyProtocolVersion: 2,
        origins: [
          { id: "v2-o1", address: "origin.example.com", port: 7000, weight: 3 },
          { id: "v2-o2", address: "198.51.100.2", port: 7000, weight: 1, backup: true },
        ],
        maxFails: 5,
        failTimeoutSeconds: 60,
        connectTimeoutMs: 1500,
        idleTimeoutSeconds: 900,
        allowListIds: ["l1", "l2"],
        blockListIds: ["l3"],
        maxConnections: 100,
        newConnectionsPerSecond: 10,
      },
    ]);
    // The sites are untouched.
    expect(config.sites).toEqual(plain.sites);
  });

  it("compiles UDP applications without PROXY protocol", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c",
        sites: [],
        l4Apps: [
          app("dns", {
            protocol: "udp",
            port: 5353,
            acceptProxyProtocol: true,
            proxyProtocolVersion: 2,
            idleTimeoutSeconds: 30,
          }),
          app("tcp", { port: 5353 }),
        ],
      },
      1n,
    );
    expect(config.l4Apps.map((a) => [a.id, a.protocol, a.port])).toEqual([
      ["dns", L4Protocol.UDP, 5353],
      ["tcp", L4Protocol.TCP, 5353],
    ]);
    expect(config.l4Apps[0]).toMatchObject({
      acceptProxyProtocol: false,
      proxyProtocolVersion: 0,
      idleTimeoutSeconds: 30,
    });
    expect(config.requiredFeatures).toEqual(["l4-v1"]);
  });

  it("sorts applications and origins by the UTF-8 bytes of their ids, independently of input order", () => {
    const apps = [
      app("\u{1F600}", {
        port: 20001,
        origins: [
          { id: "\u{1F600}", address: "a.example", port: 1, weight: 1, backup: false },
          { id: "\uFF01", address: "b.example", port: 2, weight: 1, backup: false },
          { id: "z", address: "c.example", port: 3, weight: 1, backup: false },
        ],
      }),
      app("\uFF01", { port: 20002 }),
      app("b", { port: 20003, allowListIds: ["y", "x"], blockListIds: ["x", "x"] }),
    ];
    const forward = compileNodeConfig({ clusterId: "c", sites: [], l4Apps: apps }, 1n);
    const backward = compileNodeConfig(
      {
        clusterId: "c",
        sites: [],
        l4Apps: [...apps].reverse().map((a) => ({
          ...a,
          origins: [...a.origins].reverse(),
          allowListIds: [...a.allowListIds].reverse(),
        })),
      },
      2n,
    );
    expect(forward.l4Apps.map((a) => a.id)).toEqual(["b", "\uFF01", "\u{1F600}"]);
    expect(forward.l4Apps[2]?.origins.map((o) => o.id)).toEqual(["z", "\uFF01", "\u{1F600}"]);
    expect(forward.l4Apps[0]?.allowListIds).toEqual(["x", "y"]);
    expect(forward.l4Apps[0]?.blockListIds).toEqual(["x"]);
    expect(backward.contentHash).toBe(forward.contentHash);
    // canonicalize brings a shuffled configuration into the same order.
    const shuffled = clone(NodeConfigSchema, forward);
    shuffled.l4Apps.reverse();
    for (const a of shuffled.l4Apps) a.origins.reverse();
    expect(contentHash(canonicalize(shuffled))).toBe(forward.contentHash);
  });

  it("carries applications in full in diffs and applies them", () => {
    const base = compileNodeConfig({ clusterId: "c", sites: [site("a")] }, 1n);
    const target = compileNodeConfig(
      { clusterId: "c", sites: [site("a")], l4Apps: [app("x"), app("y", { port: 20001 })] },
      2n,
    );
    const diff = diffNodeConfig(base, target);
    expect(diff.upsertedSites).toEqual([]);
    expect(diff.l4Apps.map((a) => a.id)).toEqual(["x", "y"]);
    expect(applyNodeConfigDiff(base, diff)).toEqual(target);
    const removed = compileNodeConfig({ clusterId: "c", sites: [site("a")] }, 3n);
    const back = diffNodeConfig(target, removed);
    expect(back.l4Apps).toEqual([]);
    expect(applyNodeConfigDiff(target, back)).toEqual(removed);
  });

  it("follows the applications when the features are recomputed (rollback)", () => {
    const config = compileNodeConfig(
      { clusterId: "c", sites: [site("a")], l4Apps: [app("x")] },
      4n,
    );
    expect(refreshDerived(config)).toEqual(config);
    const dropped = clone(NodeConfigSchema, config);
    dropped.l4Apps = [];
    const refreshed = refreshDerived(dropped);
    expect(refreshed.requiredFeatures).toEqual([]);
    expect(refreshed.contentHash).toBe(
      compileNodeConfig({ clusterId: "c", sites: [site("a")] }, 4n).contentHash,
    );
  });
});
