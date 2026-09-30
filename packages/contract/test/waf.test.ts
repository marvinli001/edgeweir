import { describe, expect, it } from "vitest";
import {
  logEntry,
  siteWafUpdateInput,
  tlsSettings,
  WAF_DEFAULTS,
  WAF_MAX_EXCLUSIONS,
  wafSettings,
  wafTopRulesInput,
} from "../src/index";

const id = "00000000-0000-4000-8000-000000000001";

describe("Brotli and Zstandard settings", () => {
  it("default to off with gzip's minimum length and types", () => {
    const settings = tlsSettings.parse({});
    expect(settings).toMatchObject({
      brotli: false,
      brotliLevel: 6,
      brotliMinLength: 256,
      zstd: false,
      zstdLevel: 3,
      zstdMinLength: 256,
      gzip: true,
    });
    expect(settings.brotliTypes).toEqual(settings.gzipTypes);
    expect(settings.zstdTypes).toEqual(settings.gzipTypes);
    // Every parse gets its own list.
    settings.brotliTypes.push("text/csv");
    expect(tlsSettings.parse({}).brotliTypes).not.toContain("text/csv");
  });

  it("accepts switches, levels, minimum lengths and types in range", () => {
    const settings = tlsSettings.parse({
      brotli: true,
      brotliLevel: 11,
      brotliMinLength: 1,
      brotliTypes: ["text/html", "application/wasm"],
      zstd: true,
      zstdLevel: 19,
      zstdMinLength: 1_048_576,
      zstdTypes: [],
    });
    expect(settings).toMatchObject({ brotli: true, brotliLevel: 11, zstd: true, zstdLevel: 19 });
    // Stored settings from before Brotli and Zstandard still parse.
    expect(tlsSettings.parse({ brotli: false, zstd: false }).brotli).toBe(false);
  });

  it("refuses levels, lengths and types out of range", () => {
    for (const input of [
      { brotliLevel: 0 },
      { brotliLevel: 12 },
      { zstdLevel: 0 },
      { zstdLevel: 20 },
      { brotliMinLength: 0 },
      { zstdMinLength: 1_048_577 },
      { brotliTypes: ["text/html; charset=utf-8"] },
      { zstdTypes: ["TEXT/HTML"] },
      { zstdTypes: Array.from({ length: 33 }, (_, i) => `text/x-${i}`) },
      { brotli: "yes" },
    ])
      expect(tlsSettings.safeParse(input).success, JSON.stringify(input)).toBe(false);
  });
});

describe("OWASP CRS settings", () => {
  it("defaults to off, paranoia level 1, threshold 5 and a 128 KiB body limit", () => {
    expect(WAF_DEFAULTS).toEqual({
      mode: "off",
      paranoiaLevel: 1,
      anomalyThreshold: 5,
      excludedRuleIds: [],
      requestBodyLimit: 131_072,
    });
    expect(wafSettings.parse({ tenantCrs: true })).toEqual({ tenantCrs: true });
  });

  it("accepts the modes and every field at its bounds", () => {
    for (const mode of ["off", "detect", "block"])
      expect(siteWafUpdateInput.safeParse({ id, mode }).success, mode).toBe(true);
    const full = siteWafUpdateInput.parse({
      id,
      mode: "block",
      paranoiaLevel: 4,
      anomalyThreshold: 1000,
      excludedRuleIds: [942100, 920350, 999999, 900000],
      requestBodyLimit: 134_217_728,
    });
    expect(full.excludedRuleIds).toEqual([942100, 920350, 999999, 900000]);
    expect(siteWafUpdateInput.parse({ id, requestBodyLimit: 0 }).requestBodyLimit).toBe(0);
    expect(
      siteWafUpdateInput.safeParse({
        id,
        excludedRuleIds: Array.from({ length: WAF_MAX_EXCLUSIONS }, (_, i) => 900000 + i),
      }).success,
    ).toBe(true);
  });

  it("refuses unknown modes, values out of range, duplicate and non-CRS rule ids", () => {
    for (const input of [
      { mode: "on" },
      { paranoiaLevel: 0 },
      { paranoiaLevel: 5 },
      { anomalyThreshold: 0 },
      { anomalyThreshold: 1001 },
      { requestBodyLimit: -1 },
      { requestBodyLimit: 134_217_729 },
      { excludedRuleIds: [942100, 942100] },
      { excludedRuleIds: [899999] },
      { excludedRuleIds: [1_000_000] },
      { excludedRuleIds: [942100.5] },
      { excludedRuleIds: Array.from({ length: WAF_MAX_EXCLUSIONS + 1 }, (_, i) => 900000 + i) },
    ])
      expect(siteWafUpdateInput.safeParse({ id, ...input }).success, JSON.stringify(input)).toBe(
        false,
      );
  });

  it("bounds the top rules query", () => {
    expect(wafTopRulesInput.parse({ id })).toEqual({ id, range: "24h", limit: 10 });
    expect(wafTopRulesInput.safeParse({ id, limit: 51 }).success).toBe(false);
    expect(wafTopRulesInput.safeParse({ id, range: "2d" }).success).toBe(false);
  });

  it("gives access log entries without WAF data empty defaults", () => {
    const entry = logEntry.parse({
      id: "n/1/0",
      time: "2026-10-01T00:00:00.000Z",
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
    expect(entry).toMatchObject({ ja4: "", wafRuleIds: [], wafBlocked: false });
  });
});
