import { create } from "@bufbuild/protobuf";
import { NodeConfigSchema } from "@edgeweir/proto";
import { parseExpression } from "@edgeweir/rule-engine";
import { describe, expect, it } from "vitest";
import {
  type ActiveHealthCheckModel,
  applyNodeConfigDiff,
  type CcPolicyModel,
  ConfigCapacityError,
  canonicalize,
  compileNodeConfig,
  contentHash,
  DEFAULT_SITE_PROTECTION,
  decodeNodeConfig,
  diffNodeConfig,
  encodeNodeConfig,
  geoFeatures,
  MAX_SITES_PER_CLUSTER,
  moduleFeatures,
  nodeRequirements,
  type OfflineHostModel,
  parseDomain,
  poolAndPageFeatures,
  type RuleModel,
  type SiteModel,
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
    { name: "away.test", wildcard: true, reason: "suspended" },
    { name: "away.test", wildcard: false, reason: "suspended" },
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
        platformErrorPages: { unknownHost: "", siteDisabled: "", siteSuspended: "" },
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
        platformErrorPages: { unknownHost: "", siteDisabled: "", siteSuspended: "<p>later</p>" },
        offlineHosts: offline,
      },
      1n,
    );
    expect(config.sites.map((s) => s.keepCacheTag)).toEqual([true, false]);
    expect(config.platformErrorPages).toMatchObject({
      unknownHost: "",
      siteDisabled: "",
      siteSuspended: "<p>later</p>",
    });
    expect(config.offlineHosts.map((h) => [h.name, h.wildcard, h.reason])).toEqual([
      ["away.test", false, "suspended"],
      ["away.test", true, "suspended"],
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
        { name: "a.test", wildcard: true, reason: "suspended" },
        { name: "a.test", wildcard: false, reason: "suspended" },
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
        platformErrorPages: { unknownHost: "<p>nobody</p>", siteDisabled: "", siteSuspended: "" },
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
