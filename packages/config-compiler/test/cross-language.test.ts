import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clone, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { NodeConfigSchema } from "@edgeweir/proto";
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

describe("content hash matches the Go agent", () => {
  it.each([
    ["phase 0", vector],
    ["M2", vectorM2],
    ["v0.2.1", vectorV021],
    ["v0.11.0", vectorV0110],
    ["v0.12.0", vectorV0120],
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
