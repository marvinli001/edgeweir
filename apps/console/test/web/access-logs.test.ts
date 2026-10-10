import {
  BLOCK_REASONS,
  BROWSERS,
  DEVICES,
  logQuery,
  OPERATING_SYSTEMS,
  STATS_HTTP_VERSIONS,
  STATS_TLS_VERSIONS,
} from "@edgeweir/contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeMoreFilters,
  blockReasonLabel,
  browserLabel,
  countryName,
  deviceLabel,
  emptyMoreFilters,
  headerLines,
  httpVersionLabel,
  type LogFilters,
  logHeadersError,
  logQueryOf,
  normalizeLogHeaders,
  osLabel,
  protocolText,
  tlsVersionLabel,
} from "../../src/web/lib/access-logs";
import { overwriteGetLocale } from "../../src/web/paraglide/runtime.js";

const SITE = "00000000-0000-4000-8005-000000000002";
const FROM = "2026-10-10T00:00:00.000Z";
const TO = "2026-10-10T01:00:00.000Z";

const filters = (change: Partial<LogFilters> = {}): LogFilters => ({
  from: "",
  to: "",
  status: "",
  ip: "",
  path: "",
  requestId: "",
  ...emptyMoreFilters(),
  ...change,
});

afterEach(() => overwriteGetLocale(() => "zh-CN"));

describe("access log labels", () => {
  it("labels every block reason and statistics key in both locales (never the key itself)", () => {
    const tables: [readonly string[], (key: string) => string][] = [
      [BLOCK_REASONS, blockReasonLabel],
      [BROWSERS, browserLabel],
      [OPERATING_SYSTEMS, osLabel],
      [DEVICES, deviceLabel],
      [STATS_HTTP_VERSIONS, httpVersionLabel],
      [STATS_TLS_VERSIONS, tlsVersionLabel],
    ];
    for (const locale of ["zh-CN", "en"] as const) {
      overwriteGetLocale(() => locale);
      for (const [keys, label] of tables) {
        for (const key of keys) {
          expect(label(key), `${locale} ${key}`).not.toBe("");
          if (key !== "1.0" && key !== "1.1" && key !== "2" && key !== "3")
            expect(label(key), `${locale} ${key}`).not.toBe(key);
        }
      }
    }
    // A reason or key newer than the console shows as it is.
    expect(blockReasonLabel("future_reason")).toBe("future_reason");
    expect(browserLabel("toString")).toBe("toString");
  });

  it("names countries in the current locale; empty is unknown, a bad code stays as it is", () => {
    overwriteGetLocale(() => "en");
    expect(countryName("JP")).toBe("Japan");
    expect(countryName("")).toBe("Unknown");
    expect(countryName("not a code")).toBe("not a code");
    overwriteGetLocale(() => "zh-CN");
    expect(countryName("JP")).toBe("日本");
    expect(countryName("")).toBe("未知");
  });

  it("shows the protocol from what a line knows, and headers in name order", () => {
    overwriteGetLocale(() => "en");
    expect(protocolText({ scheme: "https", httpVersion: "2", tlsVersion: "1.3" })).toBe(
      "HTTPS · HTTP/2 · TLS 1.3",
    );
    expect(protocolText({ scheme: "http", httpVersion: "1.1", tlsVersion: "" })).toBe(
      "HTTP · HTTP/1.1",
    );
    expect(protocolText({ scheme: "", httpVersion: "", tlsVersion: "" })).toBe("");
    expect(headerLines({ "x-b": "2", "accept-language": "en" })).toEqual([
      "accept-language: en",
      "x-b: 2",
    ]);
  });
});

describe("recorded request headers", () => {
  it("stores names lowercase without duplicates", () => {
    expect(normalizeLogHeaders(["Accept-Language", "accept-language", " X-Id "])).toEqual([
      "accept-language",
      "x-id",
    ]);
  });

  it("refuses credentials, bad names and more than eight", () => {
    overwriteGetLocale(() => "en");
    expect(logHeadersError(["accept-language", "x-id"])).toBeNull();
    expect(logHeadersError([])).toBeNull();
    expect(logHeadersError(["Authorization"])).toBe("authorization cannot be logged");
    expect(logHeadersError(["cookie"])).toBe("cookie cannot be logged");
    expect(logHeadersError(["proxy-authorization"])).toBe("proxy-authorization cannot be logged");
    expect(logHeadersError(["x_id"])).toBe("Invalid header name: x_id");
    expect(logHeadersError(Array.from({ length: 9 }, (_, i) => `x-${i}`))).toBe(
      "At most 8 headers",
    );
    // Duplicates count once.
    expect(logHeadersError([...Array.from({ length: 8 }, (_, i) => `x-${i}`), "X-0"])).toBeNull();
  });
});

describe("log filters", () => {
  it("sends only the filters that are set, as the API reads them", () => {
    const empty = logQueryOf(SITE, filters(), FROM, TO);
    expect(empty).toEqual({
      query: expect.objectContaining({ siteId: SITE, from: FROM, to: TO, ip: "", path: "" }),
    });
    if (!("query" in empty)) throw new Error("refused");
    expect(Object.entries(empty.query).filter(([, v]) => v !== undefined)).toEqual([
      ["siteId", SITE],
      ["from", FROM],
      ["to", TO],
      ["ip", ""],
      ["path", ""],
      ["limit", 100],
    ]);

    const full = logQueryOf(
      SITE,
      filters({
        status: "403",
        requestId: " abc ",
        host: " shop.example.com ",
        method: "post",
        statusClass: "4xx",
        cacheStatus: "MISS",
        blockReason: "any",
        country: "jp",
        asn: "64496",
        ua: "curl",
        referer: "search.example",
        minDuration: "250",
        cidr: "2001:db8::/32",
      }),
      FROM,
      TO,
    );
    expect(full).toEqual({
      query: {
        siteId: SITE,
        from: FROM,
        to: TO,
        status: 403,
        ip: "",
        path: "",
        requestId: "abc",
        host: "shop.example.com",
        method: "POST",
        statusClass: "4xx",
        cacheStatus: "MISS",
        blockReason: "any",
        country: "JP",
        asn: 64496,
        ua: "curl",
        referer: "search.example",
        minDuration: 250,
        cidr: "2001:db8::/32",
        limit: 100,
      },
    });
    // What the form sends passes the contract.
    if ("query" in full) expect(logQuery.safeParse(full.query).success).toBe(true);
  });

  it("names the first filter the API would refuse", () => {
    expect(logQueryOf(SITE, filters({ country: "JPN" }), FROM, TO)).toEqual({
      invalid: "country",
    });
    expect(logQueryOf(SITE, filters({ asn: "0" }), FROM, TO)).toEqual({ invalid: "asn" });
    expect(logQueryOf(SITE, filters({ asn: "4294967296" }), FROM, TO)).toEqual({
      invalid: "asn",
    });
    expect(logQueryOf(SITE, filters({ minDuration: "1.5" }), FROM, TO)).toEqual({
      invalid: "minDuration",
    });
    expect(logQueryOf(SITE, filters({ cidr: "10.0.0.0/33" }), FROM, TO)).toEqual({
      invalid: "cidr",
    });
    expect(logQueryOf(SITE, filters({ cidr: "10.0.0.0/8" }), FROM, TO)).toHaveProperty("query");
  });

  it("counts the filters behind more filters that are set", () => {
    expect(activeMoreFilters(filters({ status: "404", ip: "192.0.2.1" }))).toBe(0);
    expect(activeMoreFilters(filters({ host: "a.example", cidr: " ", blockReason: "crs" }))).toBe(
      2,
    );
  });
});
