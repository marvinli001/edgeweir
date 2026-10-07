import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clone, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { CacheKeyQuery, NodeConfigSchema } from "@edgeweir/proto";
import { parseExpression } from "@edgeweir/rule-engine";
import { describe, expect, it } from "vitest";
import {
  CACHE_ZONE_FEATURE,
  type CompileInput,
  canonicalize,
  compileNodeConfig,
  contentHash,
  DEFAULT_ORIGIN_TRIES,
  DEFAULT_REQUEST_BODY_LIMIT,
  keysZoneMbFor,
  SITE_CONTENT_FEATURE,
  type SiteModel,
} from "../src/index";

type Vector = { config: JsonValue; canonical_hex: string; content_hash: string };
const vectorV0240 = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures", "content_hash_vector_v0240.json"), "utf8"),
) as Vector;

const baseSite = (id: string): SiteModel => ({
  id,
  name: id,
  enabled: true,
  cacheGeneration: 1,
  domains: [{ name: `${id}.test`, wildcard: false }],
  originPool: {
    id: `p-${id}`,
    policy: "weighted_random",
    origins: [
      {
        id: "o1",
        address: "origin.example.com",
        port: 80,
        scheme: "http",
        weight: 1,
        backup: false,
        hostHeader: "",
        sni: "",
      },
    ],
    settings: {
      tlsVerify: true,
      maxFails: 3,
      recoverySeconds: 30,
      connectTimeoutMs: 10000,
      sendTimeoutMs: 60000,
      readTimeoutMs: 60000,
      keepalive: true,
      keepaliveIdleSeconds: 60,
      keepaliveMaxRequests: 1000,
    },
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
  tls: {
    forceHttps: false,
    hstsMaxAge: 0,
    hstsIncludeSubdomains: false,
    hstsPreload: false,
    minimumVersion: "1.2",
    http2: true,
    gzip: true,
    gzipMinLength: 256,
    gzipTypes: ["text/css"],
    ocspStapling: false,
    cipherProfile: "modern",
    http3: false,
  },
});

const compile = (sites: SiteModel[], extra: Partial<CompileInput> = {}) =>
  compileNodeConfig({ clusterId: "c1", sites, ...extra }, 1n);

/**
 * The models behind the v0.24.0 vector: one site with every site-content-v1
 * setting (unsorted maintenance lists with a duplicate), a platform rule
 * with a body limit and per-node cache sizes (unsorted).
 */
const v0240Models = (): CompileInput => {
  const site = baseSite("s1");
  site.purge = { credentialId: "purge-key-1", credentialVersion: 2 };
  site.hideXCache = true;
  site.maintenance = {
    template: "<h1>{{status}}</h1><p>{{request_id}} 维护中</p>",
    retryAfterSeconds: 600,
    allowedCidrs: ["2001:db8::/32", "192.0.2.0/24", "2001:db8::/32"],
    // "/😀" before "/！" in UTF-16, after it in UTF-8 byte order (as nodes sort).
    allowedPathPrefixes: ["/status", "/health", "/status", "/😀", "/！"],
  };
  site.charset = { name: "gbk", force: true, uppercase: true };
  site.requestBodyLimit = 0;
  if (site.tls) {
    site.tls.gzipLevel = 6;
    site.tls.compressMaxLength = 8 * 1024 * 1024;
  }
  if (site.originPool.settings) {
    site.originPool.settings.tries = 5;
    site.originPool.settings.statusRetry = false;
  }
  site.cacheRules.push({
    id: "r2",
    priority: 5,
    pathPrefixes: ["/account/"],
    extensions: [],
    expression: "",
    action: "cache",
    edgeTtlSeconds: 30,
    originCacheControl: "respect",
    cacheSetCookie: true,
  });
  site.cacheKey = {
    query: "exclude",
    queryParams: ["utm_*", "fbclid", "gclid"],
    sortQuery: true,
    headers: [],
    cookies: [],
    deviceType: false,
    includeHost: true,
  };
  site.errorPages = {
    pages: [
      {
        status: 5,
        template: "",
        redirectUrl: "https://status.example.com/?s={{status}}&id={{request_id}}",
      },
      { status: 404, template: "<p>没有这个页面</p>", responseStatus: 200 },
      { status: 4, template: "<p>{{status}}</p>" },
      { status: 403, template: "<p>denied</p>" },
    ],
    interceptOriginErrors: true,
  };
  site.rules = [
    {
      id: "big-uploads",
      phase: "config",
      expression: parseExpression('starts_with(http.request.uri.path, "/upload/")', "config"),
      action: { kind: "config", requestBodyLimit: 1024 * 1024 * 1024 },
    },
  ];
  return {
    clusterId: "c1",
    listeners: [{ port: 80, protocol: "http" }],
    cacheZones: [
      {
        name: "default",
        maxSizeMb: 20480,
        keysZoneMb: keysZoneMbFor(20480),
        inactiveSeconds: 14 * 86400,
        nodeSizes: [
          { nodeId: "node-b", maxSizeMb: 2048, keysZoneMb: keysZoneMbFor(2048) },
          { nodeId: "node-a", maxSizeMb: 1048576, keysZoneMb: keysZoneMbFor(1048576) },
        ],
      },
    ],
    sites: [site],
    platformRules: [
      {
        id: "p-limit",
        phase: "config",
        expression: parseExpression('http.request.method eq "PUT"', "config"),
        action: { kind: "config", requestBodyLimit: 0 },
      },
    ],
  };
};

describe("site-content-v1 and cache-zone-v1 (proto v0.24.0)", () => {
  it("keeps configurations without the settings as they were, explicit defaults included", () => {
    const plain = compile([baseSite("s1")]);
    expect(plain.requiredFeatures).not.toContain(SITE_CONTENT_FEATURE);
    expect(plain.requiredFeatures).not.toContain(CACHE_ZONE_FEATURE);
    const site = baseSite("s1");
    site.hideXCache = false;
    site.purge = null;
    site.maintenance = null;
    site.charset = null;
    site.requestBodyLimit = DEFAULT_REQUEST_BODY_LIMIT;
    if (site.tls) {
      site.tls.gzipLevel = 0;
      site.tls.compressMaxLength = 0;
    }
    if (site.originPool.settings) {
      site.originPool.settings.tries = DEFAULT_ORIGIN_TRIES;
      site.originPool.settings.statusRetry = true;
    }
    for (const rule of site.cacheRules) rule.cacheSetCookie = false;
    site.errorPages = {
      pages: [{ status: 403, template: "x", redirectUrl: "", responseStatus: 0 }],
      interceptOriginErrors: false,
    };
    const explicit = compile([site]);
    expect(explicit.requiredFeatures).not.toContain(SITE_CONTENT_FEATURE);
    const withPages = baseSite("s1");
    withPages.errorPages = {
      pages: [{ status: 403, template: "x" }],
      interceptOriginErrors: false,
    };
    expect(explicit.contentHash).toBe(compile([withPages]).contentHash);
  });

  it("requires site-content-v1 for each setting on its own", () => {
    const pages = (page: NonNullable<SiteModel["errorPages"]>["pages"][number]) => ({
      pages: [page],
      interceptOriginErrors: false,
    });
    const edits: [string, (site: SiteModel) => void][] = [
      [
        "PURGE",
        (s) => {
          s.purge = { credentialId: "k", credentialVersion: 1 };
        },
      ],
      [
        "X-Cache",
        (s) => {
          s.hideXCache = true;
        },
      ],
      [
        "maintenance",
        (s) => {
          s.maintenance = {
            template: "",
            retryAfterSeconds: 0,
            allowedCidrs: [],
            allowedPathPrefixes: [],
          };
        },
      ],
      [
        "charset",
        (s) => {
          s.charset = { name: "utf-8", force: false, uppercase: false };
        },
      ],
      [
        "body limit",
        (s) => {
          s.requestBodyLimit = 1024;
        },
      ],
      [
        "no body limit",
        (s) => {
          s.requestBodyLimit = 0;
        },
      ],
      [
        "gzip level",
        (s) => {
          if (s.tls) s.tls.gzipLevel = 9;
        },
      ],
      [
        "largest compressed",
        (s) => {
          if (s.tls) s.tls.compressMaxLength = 1;
        },
      ],
      [
        "tries",
        (s) => {
          if (s.originPool.settings) s.originPool.settings.tries = 1;
        },
      ],
      [
        "status retries",
        (s) => {
          if (s.originPool.settings) s.originPool.settings.statusRetry = false;
        },
      ],
      [
        "Set-Cookie",
        (s) => {
          for (const rule of s.cacheRules) rule.cacheSetCookie = true;
        },
      ],
      [
        "exclude",
        (s) => {
          s.cacheKey = {
            query: "exclude",
            queryParams: ["utm_*"],
            sortQuery: false,
            headers: [],
            cookies: [],
            deviceType: false,
            includeHost: true,
          };
        },
      ],
      [
        "404 page",
        (s) => {
          s.errorPages = pages({ status: 404, template: "x" });
        },
      ],
      [
        "5xx class",
        (s) => {
          s.errorPages = pages({ status: 5, template: "x" });
        },
      ],
      [
        "redirect page",
        (s) => {
          s.errorPages = pages({ status: 403, template: "", redirectUrl: "/denied" });
        },
      ],
      [
        "page status",
        (s) => {
          s.errorPages = pages({ status: 503, template: "x", responseStatus: 200 });
        },
      ],
      [
        "rule body limit",
        (s) => {
          s.rules = [
            {
              id: "r",
              phase: "config",
              expression: parseExpression("true", "config"),
              action: { kind: "config", requestBodyLimit: 5 },
            },
          ];
        },
      ],
    ];
    for (const [name, edit] of edits) {
      const site = baseSite("s1");
      edit(site);
      const config = compile([site]);
      expect(config.requiredFeatures, name).toContain(SITE_CONTENT_FEATURE);
      expect(config.requiredFeatures, name).not.toContain(CACHE_ZONE_FEATURE);
    }
  });

  it("compiles the settings: unset defaults, sorted lists, redirects without templates", () => {
    const input = v0240Models();
    input.sites.push(baseSite("plain"));
    const config = compileNodeConfig(input, 1n);
    const site = config.sites.find((s) => s.id === "s1");
    if (!site) throw new Error("site s1 missing");
    expect(site.maintenance?.allowedCidrs).toEqual(["192.0.2.0/24", "2001:db8::/32"]);
    expect(site.maintenance?.allowedPathPrefixes).toEqual(["/health", "/status", "/！", "/😀"]);
    expect(site.requestBodyLimit).toBe(0n);
    expect(site.originPool?.tries).toBe(5);
    expect(site.originPool?.statusRetryDisabled).toBe(true);
    expect(site.cacheKey?.query).toBe(CacheKeyQuery.EXCLUDE);
    expect(site.cacheKey?.queryParams).toEqual(["fbclid", "gclid", "utm_*"]);
    expect(
      site.errorPages?.pages.map((p) => [
        p.status,
        p.template !== "",
        p.redirectUrl !== "",
        p.responseStatus,
      ]),
    ).toEqual([
      [4, true, false, 0],
      [5, false, true, 0],
      [403, true, false, 0],
      [404, true, false, 200],
    ]);
    expect(site.cacheRules.find((r) => r.id === "r2")?.cacheSetCookie).toBe(true);
    expect(site.rules[0]?.action?.requestBodyLimit).toBe(1073741824n);
    expect(config.cacheZones[0]?.nodeSizes.map((n) => n.nodeId)).toEqual(["node-a", "node-b"]);
    expect(config.requiredFeatures).toEqual(
      expect.arrayContaining([SITE_CONTENT_FEATURE, CACHE_ZONE_FEATURE]),
    );
    const other = config.sites.find((s) => s.id === "plain");
    expect(other?.requestBodyLimit).toBeUndefined();
    expect(other?.originPool?.tries).toBe(0);
  });

  it("requires cache-zone-v1 for node sizes only; a platform rule's limit needs site-content-v1", () => {
    const zone = { name: "default", maxSizeMb: 10240, keysZoneMb: 64, inactiveSeconds: 604800 };
    const zones = [zone];
    expect(compile([baseSite("s1")], { cacheZones: zones }).requiredFeatures).not.toContain(
      CACHE_ZONE_FEATURE,
    );
    const sized = compile([baseSite("s1")], {
      cacheZones: [{ ...zone, nodeSizes: [{ nodeId: "n1", maxSizeMb: 2048, keysZoneMb: 16 }] }],
    });
    expect(sized.requiredFeatures).toContain(CACHE_ZONE_FEATURE);
    expect(sized.requiredFeatures).not.toContain(SITE_CONTENT_FEATURE);
    const platform = compile([baseSite("s1")], { platformRules: v0240Models().platformRules });
    expect(platform.requiredFeatures).toContain(SITE_CONTENT_FEATURE);
  });

  it("derives keys_zone from the size: 64 MiB for 10 GiB, 16-512 MiB", () => {
    expect(keysZoneMbFor(10240)).toBe(64);
    expect(keysZoneMbFor(1024)).toBe(16);
    expect(keysZoneMbFor(5000)).toBe(32);
    expect(keysZoneMbFor(100 * 1024)).toBe(512);
    expect(keysZoneMbFor(64 * 1024 * 1024)).toBe(512);
  });
});

describe("content hash matches the Go agent (v0.24.0)", () => {
  it("encodes the v0.24.0 vector to the same canonical bytes and hash", () => {
    const config = canonicalize(fromJson(NodeConfigSchema, vectorV0240.config));
    const bare = clone(NodeConfigSchema, config);
    bare.revision = 0n;
    bare.contentHash = "";
    expect(Buffer.from(toBinary(NodeConfigSchema, bare)).toString("hex")).toBe(
      vectorV0240.canonical_hex,
    );
    expect(contentHash(config)).toBe(vectorV0240.content_hash);
  });

  it("compiles the v0.24.0 models into the vector's hash", () => {
    const config = compileNodeConfig(v0240Models(), 12n);
    expect(config.requiredFeatures).toEqual([
      CACHE_ZONE_FEATURE,
      "error-pages-v1",
      "rules-v1",
      "rules-v2",
      SITE_CONTENT_FEATURE,
      "tls-v1",
    ]);
    expect(config.contentHash).toBe(vectorV0240.content_hash);
  });
});
