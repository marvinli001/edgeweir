import { describe, expect, it } from "vitest";
import {
  activeHealthCheck,
  cacheTaskCreateInput,
  ERROR_PAGE_MAX_BYTES,
  hostName,
  logEntry,
  logQuery,
  normalizeCacheTag,
  platformErrorPages,
  prefetchFailureReasonDefs,
  sessionAffinity,
  siteErrorPagesInput,
  siteUpdateInput,
  taskErrorDefs,
  utf8Bytes,
} from "../src/index";

const id = "00000000-0000-4000-8000-000000000001";

describe("cache task inputs", () => {
  const ok = (input: Record<string, unknown>) => cacheTaskCreateInput.safeParse(input).success;

  it("requires hosts, sites and tags, and exactly one sitemap URL, for the new types", () => {
    expect(ok({ type: "host", hosts: ["www.example.test"] })).toBe(true);
    expect(ok({ type: "host", urls: ["http://www.example.test/"] })).toBe(false);
    expect(ok({ type: "tag", siteIds: [id], tags: ["product-42"] })).toBe(true);
    expect(ok({ type: "tag", tags: ["product-42"] })).toBe(false);
    expect(ok({ type: "tag", siteIds: [id] })).toBe(false);
    expect(ok({ type: "sitemap", urls: ["https://www.example.test/sitemap.xml"] })).toBe(true);
    expect(ok({ type: "sitemap", urls: [] })).toBe(false);
    expect(
      ok({ type: "sitemap", urls: ["https://a.test/sitemap.xml", "https://a.test/other.xml"] }),
    ).toBe(false);
    // At most 500 hosts and tags and 100 sites per task.
    expect(ok({ type: "host", hosts: Array(501).fill("a.test") })).toBe(false);
    expect(ok({ type: "tag", siteIds: [id], tags: Array(500).fill("t") })).toBe(true);
    expect(ok({ type: "tag", siteIds: [id], tags: Array(501).fill("t") })).toBe(false);
    expect(ok({ type: "tag", siteIds: Array(101).fill(id), tags: ["t"] })).toBe(false);
  });

  it("defaults to the desktop variant and 1000 sitemap URLs and bounds both", () => {
    const parsed = cacheTaskCreateInput.parse({ type: "prefetch", urls: ["http://a.test/"] });
    expect(parsed).toMatchObject({ variants: ["desktop"], maxUrls: 1000, hosts: [], tags: [] });
    expect(
      ok({ type: "prefetch", urls: ["http://a.test/"], variants: ["desktop", "mobile"] }),
    ).toBe(true);
    expect(ok({ type: "prefetch", urls: ["http://a.test/"], variants: [] })).toBe(false);
    expect(ok({ type: "prefetch", urls: ["http://a.test/"], variants: ["tablet"] })).toBe(false);
    for (const [maxUrls, valid] of [
      [1, true],
      [10_000, true],
      [0, false],
      [10_001, false],
    ] as const)
      expect(ok({ type: "sitemap", urls: ["http://a.test/s.xml"], maxUrls }), `${maxUrls}`).toBe(
        valid,
      );
  });

  it("normalizes Cache-Tag values the way nodes compare them and refuses invalid ones", () => {
    expect(normalizeCacheTag("  Product-42 ")).toBe("product-42");
    expect(normalizeCacheTag("Category: Shoes & Boots")).toBe("category: shoes & boots");
    expect(normalizeCacheTag("x".repeat(128))).toBe("x".repeat(128));
    for (const bad of ["", "   ", "a,b", "x".repeat(129), "tag\tname", "café", "K"])
      expect(normalizeCacheTag(bad), JSON.stringify(bad)).toBeNull();
  });

  it("accepts host names without wildcard or port", () => {
    expect(hostName.parse(" WWW.Example.TEST ")).toBe("www.example.test");
    for (const bad of ["*.example.test", "example.test:8080", "http://example.test", "a b.test"])
      expect(hostName.safeParse(bad).success, bad).toBe(false);
  });
});

describe("origin settings", () => {
  it("defaults active health checks and session affinity to off with the documented values", () => {
    expect(activeHealthCheck.parse({})).toEqual({
      enabled: false,
      path: "/",
      method: "GET",
      expectedStatusMin: 200,
      expectedStatusMax: 399,
      host: "",
      intervalSeconds: 30,
      timeoutSeconds: 5,
      healthyThreshold: 2,
      unhealthyThreshold: 3,
    });
    expect(sessionAffinity.parse({})).toEqual({ enabled: false, ttlSeconds: 3600 });
  });

  it("refuses a timeout above the interval, an inverted status range and bad paths or hosts", () => {
    const valid = (input: Record<string, unknown>) => activeHealthCheck.safeParse(input).success;
    expect(
      valid({ enabled: true, path: "/healthz?full=1", method: "HEAD", host: "Origin.Test" }),
    ).toBe(true);
    expect(valid({ intervalSeconds: 5, timeoutSeconds: 5 })).toBe(true);
    for (const input of [
      { intervalSeconds: 10, timeoutSeconds: 11 },
      { expectedStatusMin: 500, expectedStatusMax: 499 },
      { expectedStatusMin: 99 },
      { expectedStatusMax: 600 },
      { intervalSeconds: 4 },
      { intervalSeconds: 301 },
      { timeoutSeconds: 0 },
      { healthyThreshold: 0 },
      { unhealthyThreshold: 11 },
      { path: "healthz" },
      { path: "/health check" },
      { path: `/${"a".repeat(1024)}` },
      { method: "POST" },
      { host: "bad host" },
    ])
      expect(valid(input), JSON.stringify(input)).toBe(false);
    expect(activeHealthCheck.parse({ path: `/${"a".repeat(1023)}` }).path).toHaveLength(1024);
    expect(sessionAffinity.safeParse({ ttlSeconds: 59 }).success).toBe(false);
    expect(sessionAffinity.safeParse({ ttlSeconds: 604_801 }).success).toBe(false);
  });

  it("leaves omitted health check, affinity and Cache-Tag settings out of an update", () => {
    const update = siteUpdateInput.parse({
      id,
      originSettings: { policy: "round_robin" },
      cacheSettings: { rangeSlice: true },
    });
    expect(update.originSettings?.activeHealthCheck).toBeUndefined();
    expect(update.originSettings?.sessionAffinity).toBeUndefined();
    expect(update.cacheSettings?.keepCacheTag).toBeUndefined();
    const given = siteUpdateInput.parse({
      id,
      originSettings: { activeHealthCheck: { enabled: true }, sessionAffinity: { enabled: true } },
      cacheSettings: { keepCacheTag: true },
    });
    expect(given.originSettings?.activeHealthCheck).toMatchObject({ enabled: true, path: "/" });
    expect(given.originSettings?.sessionAffinity).toEqual({ enabled: true, ttlSeconds: 3600 });
    expect(given.cacheSettings?.keepCacheTag).toBe(true);
  });
});

describe("error pages", () => {
  it("accepts one page per allowed status and measures templates in UTF-8 bytes", () => {
    const parsed = siteErrorPagesInput.parse({
      id,
      pages: [
        { status: 503, template: "<h1>{{status}}</h1>" },
        { status: 403, template: "denied {{request_id}}" },
      ],
    });
    expect(parsed).toMatchObject({ interceptOriginErrors: false });
    for (const pages of [
      [{ status: 404, template: "x" }],
      [{ status: 500, template: "x" }],
      [{ status: 403, template: "" }],
      [
        { status: 429, template: "a" },
        { status: 429, template: "b" },
      ],
    ])
      expect(siteErrorPagesInput.safeParse({ id, pages }).success, JSON.stringify(pages)).toBe(
        false,
      );
    // The limit counts bytes: a CJK character takes three, an emoji four.
    expect(ERROR_PAGE_MAX_BYTES).toBe(65_536);
    expect(utf8Bytes("错误")).toBe(6);
    expect(utf8Bytes("😀")).toBe(4);
    expect(utf8Bytes("a".repeat(ERROR_PAGE_MAX_BYTES))).toBe(ERROR_PAGE_MAX_BYTES);
  });

  it("defaults the platform pages to the nodes' built-in ones", () => {
    expect(platformErrorPages.parse({})).toEqual({
      unknownHost: "",
      siteDisabled: "",
      siteSuspended: "",
    });
  });
});

describe("request ids and sitemap outcomes", () => {
  it("filters logs by an optional request id and returns it with every entry", () => {
    const query = logQuery.parse({
      siteId: id,
      from: "2026-10-01T00:00:00Z",
      to: "2026-10-01T01:00:00Z",
      requestId: "a1b2c3d4e5f6",
    });
    expect(query.requestId).toBe("a1b2c3d4e5f6");
    expect(logQuery.safeParse({ ...query, requestId: "x".repeat(129) }).success).toBe(false);
    expect(
      logQuery.parse({ siteId: id, from: query.from, to: query.to }).requestId,
    ).toBeUndefined();
    const entry = logEntry.parse({
      id: "n/1/0",
      time: "2026-10-01T00:00:00Z",
      nodeId: id,
      siteId: id,
      clientIp: "192.0.2.1",
      method: "GET",
      host: "a.test",
      path: "/",
      status: 200,
      bytesSent: 1,
      durationMs: 1,
      cacheStatus: "HIT",
      sampleRate: 10000,
    });
    expect(entry.requestId).toBe("");
  });

  it("names the parameters of the sitemap outcomes and their failure reasons", () => {
    expect(taskErrorDefs.sitemap_failed.params).toEqual(["url", "reason"]);
    expect(taskErrorDefs.sitemap_empty.params).toEqual(["url"]);
    expect(Object.keys(prefetchFailureReasonDefs)).toEqual(
      expect.arrayContaining(["status", "invalid", "too_large", "https_unsupported"]),
    );
  });
});
