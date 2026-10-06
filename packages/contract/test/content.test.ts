import { describe, expect, it } from "vitest";
import {
  cacheKeyPolicy,
  cacheRuleInput,
  clusterCacheInput,
  contentSettings,
  nodeCacheInput,
  originSettings,
  purgeMethodInput,
  S3_PRESETS,
  siteErrorPagesInput,
  siteMaintenanceInput,
  siteUpdateInput,
  validErrorRedirect,
} from "../src/index";

const id = "00000000-0000-4000-8000-000000000001";

describe("site-content-v1 inputs", () => {
  it("excludes cache key parameters with prefix patterns, in the exclude mode only", () => {
    expect(
      cacheKeyPolicy.parse({ query: "exclude", queryParams: ["utm_*", "fbclid"] }).queryParams,
    ).toEqual(["utm_*", "fbclid"]);
    for (const [query, name] of [
      ["include", "utm_*"],
      ["exclude", "*"],
      ["exclude", "a*b"],
      ["exclude", "**"],
      ["all", "x*"],
    ] as const)
      expect(
        cacheKeyPolicy.safeParse({ query, queryParams: [name] }).success,
        `${query} ${name}`,
      ).toBe(false);
    expect(
      cacheKeyPolicy.safeParse({ query: "exclude", queryParams: Array(33).fill("a") }).success,
    ).toBe(false);
  });

  it("caches responses with Set-Cookie only when a rule asks", () => {
    expect(cacheRuleInput.parse({}).cacheSetCookie).toBe(false);
    expect(cacheRuleInput.parse({ cacheSetCookie: true }).cacheSetCookie).toBe(true);
  });

  it("bounds origin tries to 1-5 and retries 502-504 by default", () => {
    expect(originSettings.parse({})).toMatchObject({ tries: 3, statusRetry: true });
    for (const tries of [0, 6, 2.5])
      expect(originSettings.safeParse({ tries }).success).toBe(false);
    expect(originSettings.parse({ tries: 1, statusRetry: false })).toMatchObject({
      tries: 1,
      statusRetry: false,
    });
  });

  it("takes PURGE keys of 16-256 printable characters, write-only", () => {
    expect(purgeMethodInput.parse({})).toEqual({ enabled: false });
    expect(purgeMethodInput.parse({ enabled: true, key: "k".repeat(16) }).key).toBe("k".repeat(16));
    for (const key of ["short", "k".repeat(257), `${"k".repeat(16)} x`, `${"k".repeat(16)}é`])
      expect(purgeMethodInput.safeParse({ enabled: true, key }).success, key).toBe(false);
    // Omitted settings stay as they are on update.
    const omitted = siteUpdateInput.parse({ id, cacheSettings: {} }).cacheSettings;
    expect(omitted?.purgeMethod).toBeUndefined();
    expect(omitted?.xCache).toBeUndefined();
  });

  it("offers the charsets and bounds the body limit to 0-10 GiB", () => {
    expect(contentSettings.parse({ charset: { name: "gb18030", force: true } }).charset).toEqual({
      name: "gb18030",
      force: true,
      uppercase: false,
    });
    expect(contentSettings.safeParse({ charset: { name: "latin1" } }).success).toBe(false);
    expect(contentSettings.parse({ requestBodyLimit: 0 }).requestBodyLimit).toBe(0);
    expect(contentSettings.parse({ requestBodyLimit: 10 * 1024 ** 3 }).requestBodyLimit).toBe(
      10 * 1024 ** 3,
    );
    expect(contentSettings.safeParse({ requestBodyLimit: 10 * 1024 ** 3 + 1 }).success).toBe(false);
    expect(contentSettings.safeParse({ requestBodyLimit: -1 }).success).toBe(false);
  });

  it("sizes cache zones from 1 GiB to 64 TiB, inactive 1-90 days", () => {
    expect(clusterCacheInput.parse({ id, maxSizeGb: 65_536, inactiveDays: 90 }).maxSizeGb).toBe(
      65_536,
    );
    for (const input of [
      { maxSizeGb: 0, inactiveDays: 7 },
      { maxSizeGb: 65_537, inactiveDays: 7 },
      { maxSizeGb: 10, inactiveDays: 0 },
      { maxSizeGb: 10, inactiveDays: 91 },
    ])
      expect(clusterCacheInput.safeParse({ id, ...input }).success, JSON.stringify(input)).toBe(
        false,
      );
    expect(nodeCacheInput.parse({ id, maxSizeGb: null }).maxSizeGb).toBeNull();
    expect(nodeCacheInput.safeParse({ id, maxSizeGb: 0 }).success).toBe(false);
  });
});

describe("error pages and maintenance", () => {
  it("accepts the new statuses, the 4xx and 5xx classes, redirects and replacement statuses", () => {
    const parsed = siteErrorPagesInput.parse({
      id,
      pages: [
        { status: 404, template: "<p>gone</p>", responseStatus: 200 },
        { status: "4xx", template: "<p>{{status}}</p>" },
        {
          status: "5xx",
          redirectUrl: "https://status.example.com/?s={{status}}&id={{request_id}}",
        },
        { status: 410, redirectUrl: "/gone" },
        { status: 400, template: "x" },
        { status: 401, template: "x" },
        { status: 405, template: "x" },
        { status: 500, template: "x" },
      ],
    });
    expect(parsed.pages.find((p) => p.status === "5xx")).toMatchObject({
      template: "",
      responseStatus: 0,
    });
    for (const page of [
      { status: "3xx", template: "x" },
      { status: 404, template: "x", redirectUrl: "/x" },
      { status: 404, redirectUrl: "/x", responseStatus: 200 },
      { status: 404, template: "x", responseStatus: 199 },
      { status: 404, template: "x", responseStatus: 600 },
      { status: 404 },
      { status: 404, redirectUrl: "//evil.example/" },
      { status: 404, redirectUrl: "javascript:alert(1)" },
      { status: 404, redirectUrl: "/a b" },
      { status: 404, redirectUrl: "/x?h={{host}}" },
      { status: 404, redirectUrl: "https://u:p@example.com/" },
      { status: 404, redirectUrl: `/${"a".repeat(2048)}` },
    ])
      expect(
        siteErrorPagesInput.safeParse({ id, pages: [page] }).success,
        JSON.stringify(page),
      ).toBe(false);
  });

  it("validates redirect URLs like nodes do", () => {
    expect(validErrorRedirect("https://example.com/e?code={{status}}")).toBe(true);
    expect(validErrorRedirect("/error/{{request_id}}")).toBe(true);
    expect(validErrorRedirect("/a\\b")).toBe(false);
    expect(validErrorRedirect("ftp://example.com/")).toBe(false);
  });

  it("normalizes maintenance exceptions and bounds them", () => {
    const parsed = siteMaintenanceInput.parse({
      id,
      enabled: true,
      allowedCidrs: ["192.0.2.7/24", "2001:DB8::1/32"],
      allowedPathPrefixes: ["/health"],
    });
    expect(parsed).toMatchObject({
      allowedCidrs: ["192.0.2.0/24", "2001:db8::/32"],
      retryAfterSeconds: 0,
      template: "",
    });
    for (const input of [
      { allowedCidrs: ["not-a-cidr"] },
      { allowedCidrs: Array(65).fill("10.0.0.0/8") },
      { allowedPathPrefixes: ["health"] },
      { allowedPathPrefixes: ["/a?b"] },
      { allowedPathPrefixes: ["/a#b"] },
      { allowedPathPrefixes: Array(33).fill("/a") },
      { retryAfterSeconds: 86_401 },
    ])
      expect(
        siteMaintenanceInput.safeParse({ id, enabled: true, ...input }).success,
        JSON.stringify(input),
      ).toBe(false);
  });
});

describe("object storage presets", () => {
  it("lists only services that document SigV4 on their S3 endpoint", () => {
    expect(S3_PRESETS.map((p) => p.id)).toEqual([
      "aws",
      "r2",
      "b2",
      "minio",
      "oss",
      "cos",
      "bos",
      "kodo",
    ]);
    expect(S3_PRESETS.map((p) => p.id)).not.toContain("obs");
    for (const preset of S3_PRESETS) expect(preset.region).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
  });
});
