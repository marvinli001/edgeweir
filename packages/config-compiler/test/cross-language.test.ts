import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clone, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { NodeConfigSchema } from "@edgeweir/proto";
import { parseExpression } from "@edgeweir/rule-engine";
import { describe, expect, it } from "vitest";
import { type CompileInput, canonicalize, compileNodeConfig, contentHash } from "../src/index";

// Same vectors as edgeweir-node/internal/configir/testdata/content_hash_vector*.json,
// which the Go agent checks with proto.MarshalOptions{Deterministic: true}.
type Vector = { config: JsonValue; canonical_hex: string; content_hash: string };
const load = (name: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf8")) as Vector;
const vector = load("content_hash_vector.json");
const vectorM2 = load("content_hash_vector_m2.json");
const vectorV021 = load("content_hash_vector_v021.json");
const vectorV0110 = load("content_hash_vector_v0110.json");
const vectorV0120 = load("content_hash_vector_v0120.json");
const vectorV0130 = load("content_hash_vector_v0130.json");

/** The console models behind the M2 vector (pools, S3, cache keys, rule conditions). */
const m2Models = (): CompileInput => ({
  clusterId: "c1",
  listeners: [{ port: 80, protocol: "http" }],
  cacheZones: [{ name: "default", maxSizeMb: 1024, keysZoneMb: 10, inactiveSeconds: 600 }],
  sites: [
    {
      id: "s1",
      name: "demo",
      enabled: true,
      cacheGeneration: 1,
      domains: [{ name: "demo.test", wildcard: false }],
      originPool: {
        id: "p1",
        policy: "round_robin",
        origins: [
          {
            id: "o1",
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
      cacheKey: {
        query: "ignore",
        queryParams: ["ignored-unless-include"],
        sortQuery: false,
        headers: [],
        cookies: [],
        deviceType: false,
        includeHost: true,
      },
    },
    {
      id: "s2",
      name: "bucket",
      enabled: true,
      cacheGeneration: 3,
      domains: [
        { name: "cdn.test", wildcard: true },
        { name: "bucket.test", wildcard: false },
      ],
      originPool: {
        id: "p2",
        policy: "consistent_hash",
        origins: [
          {
            id: "o2",
            address: "backup.example.com",
            port: 443,
            scheme: "https",
            weight: 3,
            backup: true,
            hostHeader: "www.example.com",
            sni: "origin.example.com",
          },
          {
            id: "o3",
            address: "minio",
            port: 9000,
            scheme: "http",
            weight: 1,
            backup: false,
            hostHeader: "",
            sni: "",
            s3: {
              region: "us-east-1",
              bucket: "media",
              credentialId: "cred-1",
              credentialVersion: 2,
            },
          },
        ],
        settings: {
          tlsVerify: false,
          maxFails: 2,
          recoverySeconds: 15,
          connectTimeoutMs: 1500,
          sendTimeoutMs: 60000,
          readTimeoutMs: 90000,
          keepalive: false,
          keepaliveIdleSeconds: 30,
          keepaliveMaxRequests: 500,
        },
      },
      cacheRules: [
        {
          id: "r3",
          priority: 20,
          pathPrefixes: [],
          extensions: ["PNG"],
          statusCodes: [404, 200, 404],
          minSizeBytes: 1,
          maxSizeBytes: 10485760,
          expression: "",
          action: "cache",
          edgeTtlSeconds: 3600,
          originCacheControl: "respect",
          staleWhileRevalidateSeconds: 30,
          staleIfErrorSeconds: 86400,
        },
        {
          id: "r2",
          priority: 10,
          pathPrefixes: ["/static/"],
          paths: ["/index.html"],
          extensions: [],
          expression: "",
          action: "bypass",
          edgeTtlSeconds: 0,
          originCacheControl: "override",
        },
      ],
      cacheKey: {
        query: "include",
        queryParams: ["v", "lang", "v"],
        sortQuery: true,
        headers: ["Accept-Language"],
        cookies: ["ab"],
        deviceType: true,
        includeHost: false,
      },
      rangeSlice: true,
      websocket: false,
    },
  ],
});

/**
 * The console models behind the v0.13.0 vector: the M2 models plus, on site
 * s2, rules with functions, value expression targets, query edits,
 * non-default preserve_query, origin, compression and extended config
 * actions; cache rules whose expressions compile to the structured lists
 * (with a browser TTL) and to a typed condition; bulk redirects whose UTF-8
 * byte order differs from UTF-16; an origin group; and a platform rule with
 * query edits.
 */
const v0130Models = (): CompileInput => {
  const input = m2Models();
  const bucket = input.sites.find((site) => site.id === "s2");
  const backup = bucket?.originPool.origins.find((o) => o.id === "o2");
  if (!bucket || !backup) throw new Error("site s2 missing");
  backup.group = "backup-pool";
  bucket.rules = [
    {
      id: "e1",
      phase: "request-transform",
      expression: parseExpression(
        'starts_with(http.request.uri.path, "/old/")',
        "request-transform",
      ),
      action: {
        kind: "rewrite",
        value: "",
        target: 'regex_replace(http.request.uri.path, "^/old/(.*)$", "/new/${1}")',
        preserveQuery: false,
        setQuery: [
          { name: "v", value: "2" },
          { name: "lang", value: "en us" },
        ],
        removeQuery: ["utm_source", "utm_medium"],
      },
    },
    {
      id: "e2",
      phase: "redirect",
      expression: parseExpression(
        'starts_with(http.request.uri.path, "/go/") and len(http.request.uri.query) lt 100',
        "redirect",
      ),
      action: {
        kind: "redirect",
        value: "",
        target: 'concat("https://", lower(http.host), http.request.uri.path)',
        statusCode: 308,
        preserveQuery: true,
        setQuery: [],
        removeQuery: ["b", "a"],
      },
    },
    {
      id: "e3",
      phase: "redirect",
      expression: parseExpression('http.request.full_uri contains "/legacy"', "redirect"),
      action: {
        kind: "redirect",
        value: "/elsewhere",
        target: "",
        statusCode: 302,
        preserveQuery: false,
        setQuery: [
          { name: "z", value: "1" },
          { name: "a", value: "%" },
        ],
        removeQuery: [],
      },
    },
    {
      id: "e4",
      phase: "config",
      expression: parseExpression('ends_with(lower(http.host), ".test")', "config"),
      action: {
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
      },
    },
    {
      id: "e5",
      phase: "origin",
      expression: parseExpression('http.request.uri.path.extension in {"mp4" "webm"}', "origin"),
      action: {
        kind: "origin",
        originGroup: "backup-pool",
        hostHeader: "media.example.com",
        sni: "sni.example.com",
        port: 8443,
      },
    },
    {
      id: "e6",
      phase: "compression",
      expression: parseExpression(
        'http.response.content_type.media_type eq "text/html"',
        "compression",
      ),
      action: { kind: "compression", algorithms: ["zstd", "gzip"] },
    },
    {
      id: "e7",
      phase: "compression",
      expression: parseExpression(
        'url_decode(http.request.uri.query) contains "raw=1"',
        "compression",
      ),
      action: { kind: "compression", algorithms: [] },
    },
  ];
  bucket.cacheRules.push(
    {
      id: "r4",
      priority: 30,
      pathPrefixes: [],
      extensions: [],
      expression:
        'starts_with(http.request.uri.path, "/media/") and http.request.uri.path.extension in {"png" "jpg"}',
      browserTtlSeconds: 600,
      action: "cache",
      edgeTtlSeconds: 86400,
      originCacheControl: "override",
    },
    {
      id: "r5",
      priority: 40,
      pathPrefixes: [],
      extensions: [],
      expression: 'lower(http.host) eq "cdn.test" or http.request.headers["x-cache"] eq "1"',
      action: "bypass",
      edgeTtlSeconds: 0,
      originCacheControl: "override",
    },
  );
  bucket.bulkRedirects = [
    {
      source: "bucket.test/a",
      target: "https://example.com/a",
      statusCode: 302,
      preserveQuery: true,
    },
    { source: "/\u{1F600}", target: "/emoji", statusCode: 308, preserveQuery: true },
    { source: "/\uFF01", target: "/fullwidth", statusCode: 307, preserveQuery: false },
    { source: "/old", target: "/new", statusCode: 301, preserveQuery: false },
    { source: "/a", target: "/b?x=1", statusCode: 301, preserveQuery: false },
  ];
  input.platformRules = [
    {
      id: "p1",
      phase: "redirect",
      expression: parseExpression('http.request.uri.path eq "/maintenance"', "redirect"),
      action: {
        kind: "redirect",
        value: "https://status.example.com/",
        target: "",
        statusCode: 302,
        preserveQuery: false,
        setQuery: [
          { name: "to", value: "status" },
          { name: "from", value: "edge" },
        ],
        removeQuery: [],
      },
    },
  ];
  return input;
};

describe("content hash matches the Go agent", () => {
  it.each([
    ["phase 0", vector],
    ["M2", vectorM2],
    ["v0.2.1", vectorV021],
    ["v0.11.0", vectorV0110],
    ["v0.12.0", vectorV0120],
    ["v0.13.0", vectorV0130],
  ])("encodes the %s vector to the same canonical bytes and hash", (_, v) => {
    const config = canonicalize(fromJson(NodeConfigSchema, v.config));
    const bare = clone(NodeConfigSchema, config);
    bare.revision = 0n;
    bare.contentHash = "";
    expect(Buffer.from(toBinary(NodeConfigSchema, bare)).toString("hex")).toBe(v.canonical_hex);
    expect(contentHash(config)).toBe(v.content_hash);
  });

  it("compiles M2 console models (pools, S3, cache keys, rule conditions) into the same hash", () => {
    const config = compileNodeConfig(m2Models(), 12n);
    expect(config.contentHash).toBe(vectorM2.content_hash);
  });

  it("compiles the v0.2.1 fields (origin allow list, cacheAuthorized) into the same hash", () => {
    const input = m2Models();
    const rule = input.sites[1]?.cacheRules.find((r) => r.id === "r3");
    if (!rule) throw new Error("rule r3 missing");
    rule.cacheAuthorized = true;
    input.originAllowedCidrs = ["172.16.0.0/12", "10.0.0.0/8", "172.16.0.0/12"];
    const config = compileNodeConfig(input, 12n);
    // Sorted and de-duplicated, exactly as the Go agent canonicalizes it.
    expect(config.originAllowedCidrs).toEqual(["10.0.0.0/8", "172.16.0.0/12"]);
    expect(config.contentHash).toBe(vectorV021.content_hash);
    // Without the new fields the v0.2.1 compiler still yields the M2 hash.
    expect(compileNodeConfig(m2Models(), 12n).contentHash).toBe(vectorM2.content_hash);
  });

  it("canonicalizes the v0.11.0 lists (compression types, excluded CRS rules, features) as the Go agent does", () => {
    const config = canonicalize(fromJson(NodeConfigSchema, vectorV0110.config));
    const tls = config.sites.find((site) => site.tls)?.tls;
    const waf = config.sites.find((site) => site.waf)?.waf;
    expect(tls?.gzipTypes).toEqual(["application/json", "text/css"]);
    expect(tls?.brotliTypes).toEqual(["application/json", "text/css"]);
    expect(tls?.zstdTypes).toEqual(["image/svg+xml", "text/plain"]);
    expect(waf?.excludedRuleIds).toEqual([920350, 942100]);
    expect(config.requiredFeatures).toEqual(["brotli-v1", "modsecurity-v1", "zstd-v1"]);
    expect(contentHash(config)).toBe(vectorV0110.content_hash);
    // Without the v0.11.0 fields it is the M2 vector again.
    for (const site of config.sites) {
      site.tls = undefined;
      site.waf = undefined;
    }
    config.requiredFeatures = [];
    expect(contentHash(config)).toBe(vectorM2.content_hash);
  });

  it("compiles the v0.12.0 fields (Cache-Tag, health check, affinity, error pages, offline hosts) into the same hash", () => {
    const input = m2Models();
    const bucket = input.sites.find((site) => site.id === "s2");
    if (!bucket) throw new Error("site s2 missing");
    bucket.keepCacheTag = true;
    bucket.errorPages = {
      pages: [
        {
          status: 503,
          template: "<h1>{{status}}</h1><p>{{request_id}} {{client_ip}} {{host}}</p>",
        },
        { status: 403, template: "<p>denied {{unknown}} 错误</p>" },
      ],
      interceptOriginErrors: true,
    };
    bucket.originPool.activeHealthCheck = {
      path: "/healthz?full=1",
      method: "HEAD",
      expectedStatusMin: 200,
      expectedStatusMax: 299,
      host: "health.example.com",
      intervalSeconds: 10,
      timeoutSeconds: 3,
      healthyThreshold: 2,
      unhealthyThreshold: 3,
    };
    bucket.originPool.sessionAffinity = { ttlSeconds: 3600 };
    input.challengeKeys = [
      { id: "k3", role: "next" },
      { id: "k1", role: "previous" },
      { id: "k2", role: "current" },
    ];
    input.platformErrorPages = {
      unknownHost: "<h1>{{host}} is not served here</h1>",
      siteDisabled: "",
      siteSuspended: "<h1>suspended</h1><p>{{request_id}}</p>",
    };
    input.offlineHosts = [
      { name: "away.test.example", wildcard: false, reason: "disabled" },
      { name: "away.test", wildcard: false, reason: "suspended" },
      { name: "old.test", wildcard: false, reason: "disabled" },
      { name: "away.test", wildcard: true, reason: "suspended" },
    ];
    const config = compileNodeConfig(input, 12n);
    // Session affinity alone brings the cluster's keys (and challenge-v1), not the protection.
    expect(config.requiredFeatures).toEqual([
      "active-health-v1",
      "challenge-v1",
      "error-pages-v1",
      "session-affinity-v1",
    ]);
    expect(config.platformProtection).toBeUndefined();
    expect(config.contentHash).toBe(vectorV0120.content_hash);
  });

  it("compiles the v0.13.0 fields (rule engine extensions, cache conditions, bulk redirects, origin groups) into the same hash", () => {
    const config = compileNodeConfig(v0130Models(), 12n);
    expect(config.requiredFeatures).toEqual(["rules-v1", "rules-v2"]);
    expect(config.contentHash).toBe(vectorV0130.content_hash);
    const bucket = config.sites.find((site) => site.id === "s2");
    // r4 has the builder's shape: lists for every node; r5 travels as a condition.
    const r4 = bucket?.cacheRules.find((rule) => rule.id === "r4");
    const r5 = bucket?.cacheRules.find((rule) => rule.id === "r5");
    expect(r4?.match).toMatchObject({ pathPrefixes: ["/media/"], extensions: ["jpg", "png"] });
    expect(r4?.match?.condition).toBeUndefined();
    expect(r4?.browserTtlSeconds).toBe(600);
    expect(r5?.match?.condition?.op).toBe("or");
    // Without the v0.13.0 fields the models compile to the M2 hash again.
    expect(compileNodeConfig(m2Models(), 12n).contentHash).toBe(vectorM2.content_hash);
  });

  it("canonicalizes the v0.13.0 lists (bulk redirects by source bytes, set_query by name, remove_query as a set) as the Go agent does", () => {
    const config = canonicalize(fromJson(NodeConfigSchema, vectorV0130.config));
    const bucket = config.sites.find((site) => site.id === "s2");
    expect(bucket?.bulkRedirects.map((r) => r.source)).toEqual([
      "/a",
      "/old",
      "/\uFF01",
      "/\u{1F600}",
      "bucket.test/a",
    ]);
    const rewrite = bucket?.rules.find((rule) => rule.id === "e1")?.action;
    expect(rewrite?.setQuery.map((param) => param.name)).toEqual(["lang", "v"]);
    expect(rewrite?.removeQuery).toEqual(["utm_medium", "utm_source"]);
    expect(config.platformRules[0]?.action?.setQuery.map((param) => param.name)).toEqual([
      "from",
      "to",
    ]);
    expect(config.requiredFeatures).toEqual(["rules-v1", "rules-v2"]);
    expect(contentHash(config)).toBe(vectorV0130.content_hash);
  });

  it("compiles console models into the same hash", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c1",
        listeners: [{ port: 80, protocol: "http" }],
        cacheZones: [{ name: "default", maxSizeMb: 1024, keysZoneMb: 10, inactiveSeconds: 600 }],
        sites: [
          {
            id: "s1",
            name: "demo",
            enabled: true,
            cacheGeneration: 1,
            domains: [{ name: "demo.test", wildcard: false }],
            originPool: {
              id: "p1",
              policy: "weighted_random",
              origins: [
                {
                  id: "o1",
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
            cacheRules: [
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
          },
        ],
      },
      7n,
    );
    expect(config.contentHash).toBe(vector.content_hash);
  });
});
