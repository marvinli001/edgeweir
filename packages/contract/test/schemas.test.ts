import { MAX_HOST_HEADER_LENGTH } from "@edgeweir/rule-engine";
import { describe, expect, it } from "vitest";
import {
  auditLogListInput,
  cacheKeyPolicy,
  cacheRuleInput,
  cacheTaskCreateInput,
  contract,
  domainName,
  errorCodes,
  errorDefs,
  extension,
  isErrorCode,
  originInput,
  originSettings,
  reasonText,
  regionCode,
  revisionReasonCodes,
  revisionReasonDefs,
  siteCreateInput,
  siteListInput,
  siteUpdateInput,
} from "../src/index";

describe("domainName", () => {
  it("normalises case and whitespace", () => {
    expect(domainName.parse("  Demo.TEST ")).toBe("demo.test");
  });

  it("accepts wildcards and rejects garbage", () => {
    expect(domainName.parse("*.example.com")).toBe("*.example.com");
    for (const bad of ["", "example", "-a.com", "a..com", "*.*.a.com", "a b.com", "http://a.com"]) {
      expect(domainName.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("extension", () => {
  it("strips a leading dot", () => {
    expect(extension.parse(".PNG")).toBe("png");
    expect(extension.safeParse("tar.gz").success).toBe(false);
  });
});

describe("siteCreateInput", () => {
  it("applies defaults", () => {
    const parsed = siteCreateInput.parse({
      name: "demo",
      domains: ["demo.test"],
      origins: [{ address: "whoami" }],
    });
    expect(parsed.origins[0]).toEqual({
      address: "whoami",
      port: 80,
      scheme: "http",
      weight: 1,
      backup: false,
      hostHeader: "",
      sni: "",
      s3: null,
      group: "",
    });
    expect(parsed.cacheRules).toEqual([]);
    expect(parsed.originSettings).toEqual({
      policy: "weighted_random",
      tlsVerify: true,
      maxFails: 3,
      recoverySeconds: 30,
      connectTimeoutMs: 10_000,
      sendTimeoutMs: 60_000,
      readTimeoutMs: 60_000,
      keepalive: true,
      keepaliveIdleSeconds: 60,
      keepaliveMaxRequests: 1000,
      websocket: true,
      protocol: "http1",
      grpc: false,
      activeHealthCheck: {
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
      },
      sessionAffinity: { enabled: false, ttlSeconds: 3600 },
    });
    expect(parsed.cacheSettings).toEqual({
      cacheKey: {
        query: "all",
        queryParams: [],
        sortQuery: false,
        headers: [],
        cookies: [],
        deviceType: false,
        includeHost: true,
      },
      rangeSlice: false,
      keepCacheTag: false,
    });
  });

  it("leaves the name to the server (the first domain) when it is missing, never empty", () => {
    const input = { domains: ["demo.test"], origins: [{ address: "whoami" }] };
    expect(siteCreateInput.parse(input).name).toBeUndefined();
    expect(siteCreateInput.safeParse({ ...input, name: " " }).success).toBe(false);
  });

  it("rejects out-of-range ports and empty origins", () => {
    expect(siteCreateInput.safeParse({ name: "x", domains: ["a.test"], origins: [] }).success).toBe(
      false,
    );
    expect(
      siteCreateInput.safeParse({
        name: "x",
        domains: ["a.test"],
        origins: [{ address: "10.0.0.1", port: 70000 }],
      }).success,
    ).toBe(false);
  });
});

describe("contract", () => {
  it("routes every procedure with a method and path", () => {
    const routes: string[] = [];
    const walk = (node: unknown) => {
      if (node && typeof node === "object" && "~orpc" in node) {
        const route = (node as { "~orpc": { route: { method?: string; path?: string } } })["~orpc"]
          .route;
        expect(route.method).toBeTruthy();
        expect(route.path?.startsWith("/")).toBe(true);
        routes.push(`${route.method} ${route.path}`);
        return;
      }
      for (const child of Object.values(node as Record<string, unknown>)) walk(child);
    };
    walk(contract);
    expect(new Set(routes).size).toBe(routes.length);
    expect(routes).toContain("POST /sites");
  });
});

describe("siteUpdateInput", () => {
  it("accepts partial updates and validates what is present", () => {
    expect(siteUpdateInput.parse({ id: "8f2f9c3a-2c61-4f6b-9f68-2f43b8a3a0d1" })).toEqual({
      id: "8f2f9c3a-2c61-4f6b-9f68-2f43b8a3a0d1",
    });
    const parsed = siteUpdateInput.parse({
      id: "8f2f9c3a-2c61-4f6b-9f68-2f43b8a3a0d1",
      domains: ["*.Demo.test"],
    });
    expect(parsed.domains).toEqual(["*.demo.test"]);
    expect(
      siteUpdateInput.safeParse({ id: "8f2f9c3a-2c61-4f6b-9f68-2f43b8a3a0d1", domains: [] })
        .success,
    ).toBe(false);
    expect(
      siteUpdateInput.safeParse({ id: "8f2f9c3a-2c61-4f6b-9f68-2f43b8a3a0d1", origins: [] })
        .success,
    ).toBe(false);
  });
});

describe("origin protocol", () => {
  const id = "8f2f9c3a-2c61-4f6b-9f68-2f43b8a3a0d1";
  const create = { domains: ["demo.test"], origins: [{ address: "whoami" }] };

  it("defaults to HTTP/1.1 on create and keeps the stored values when an update omits them", () => {
    const h2 = siteCreateInput.parse({
      ...create,
      originSettings: { protocol: "http2", grpc: true },
    });
    expect(h2.originSettings).toMatchObject({ protocol: "http2", grpc: true });
    const kept = siteUpdateInput.parse({ id, originSettings: { policy: "round_robin" } });
    expect(kept.originSettings?.protocol).toBeUndefined();
    expect(kept.originSettings?.grpc).toBeUndefined();
    const update = siteUpdateInput.parse({
      id,
      originSettings: { protocol: "http1", grpc: false },
    });
    expect(update.originSettings).toMatchObject({ protocol: "http1", grpc: false });
    for (const protocol of ["h2c", "http3", ""])
      expect(siteUpdateInput.safeParse({ id, originSettings: { protocol } }).success).toBe(false);
  });
});

describe("list inputs", () => {
  it("coerce query-string numbers and apply defaults", () => {
    expect(siteListInput.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(siteListInput.parse({ page: "3", pageSize: "50" })).toMatchObject({
      page: 3,
      pageSize: 50,
    });
    expect(siteListInput.safeParse({ pageSize: 1000 }).success).toBe(false);
    expect(auditLogListInput.parse({ offset: "40" })).toMatchObject({ limit: 50, offset: 40 });
    expect(auditLogListInput.safeParse({ from: "yesterday" }).success).toBe(false);
  });
});

describe("identity inputs", () => {
  it("normalise region codes", () => {
    expect(regionCode.parse(" CN-East ")).toBe("cn-east");
    expect(regionCode.safeParse("east asia").success).toBe(false);
  });
});

describe("error and reason codes", () => {
  it("are stable identifiers with HTTP error statuses", () => {
    expect(errorCodes.length).toBeGreaterThan(10);
    for (const code of errorCodes) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(errorDefs[code].status).toBeGreaterThanOrEqual(400);
      expect(errorDefs[code].status).toBeLessThan(600);
    }
    // Provider delivery failures are server-side HTTP errors, not invalid input.
    expect(errorDefs.ALERT_SEND_FAILED.status).toBe(502);
    expect(isErrorCode("DOMAIN_IN_USE")).toBe(true);
    expect(isErrorCode("toString")).toBe(false);
  });

  it("render revision reasons in English with every declared parameter", () => {
    expect(reasonText("site_updated", { site: "demo" })).toBe("site demo updated");
    expect(reasonText("rollback", { revision: 3 })).toBe("rollback to revision 3");
    for (const code of revisionReasonCodes) {
      const placeholders = [...revisionReasonDefs[code].en.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      expect(placeholders.sort(), code).toEqual([...revisionReasonDefs[code].params].sort());
    }
  });
});

describe("M2 origin and cache inputs", () => {
  it("validates S3 origins and keeps the secret optional (write-only)", () => {
    const parsed = originInput.parse({
      address: "minio",
      port: 9000,
      s3: { region: "US-East-1", bucket: "assets", accessKeyId: "AKID" },
    });
    expect(parsed.s3).toEqual({ region: "us-east-1", bucket: "assets", accessKeyId: "AKID" });
    expect(
      originInput.safeParse({ address: "minio", s3: { region: "x y", accessKeyId: "A" } }).success,
    ).toBe(false);
    expect(
      originInput.safeParse({
        address: "minio",
        s3: { region: "r", bucket: "Bad_Bucket", accessKeyId: "A" },
      }).success,
    ).toBe(false);
  });

  it("defaults an origin's port to its scheme's", () => {
    expect(originInput.parse({ address: "10.0.0.1" })).toMatchObject({ scheme: "http", port: 80 });
    expect(originInput.parse({ address: "10.0.0.1", scheme: "https" }).port).toBe(443);
    expect(originInput.parse({ address: "10.0.0.1", scheme: "https", port: 8443 }).port).toBe(8443);
  });

  it("accepts SNI host names only", () => {
    expect(originInput.parse({ address: "10.0.0.1", sni: "Origin.Example.com" }).sni).toBe(
      "origin.example.com",
    );
    expect(originInput.safeParse({ address: "10.0.0.1", sni: "bad host" }).success).toBe(false);
  });

  it("trims an origin's Host header and bounds it to a 253-byte name with a port", () => {
    const host = (hostHeader: string) => originInput.safeParse({ address: "10.0.0.1", hostHeader });
    expect(host(" Shop.Example.test:8080 ").data?.hostHeader).toBe("Shop.Example.test:8080");
    expect(host("[2001:db8::1]:443").success).toBe(true);
    expect(host(`${"a".repeat(253)}:65535`).success).toBe(true);
    expect(host("a".repeat(MAX_HOST_HEADER_LENGTH + 1)).success).toBe(false);
    // Nodes skip an origin whose Host header they refuse: sites.create and sites.update refuse
    // it with ORIGIN_HOST_HEADER_INVALID (validHostHeader); stored values still read back.
    expect(host("bad host").success).toBe(true);
    expect(errorDefs.ORIGIN_HOST_HEADER_INVALID).toEqual({ status: 400, params: ["hostHeader"] });
  });

  it("bounds origin connection settings", () => {
    expect(originSettings.safeParse({ connectTimeoutMs: 50 }).success).toBe(false);
    expect(originSettings.safeParse({ maxFails: 0 }).success).toBe(false);
    expect(originSettings.parse({ policy: "consistent_hash" }).policy).toBe("consistent_hash");
    expect(originSettings.safeParse({ policy: "least_conn" }).success).toBe(false);
  });

  it("validates cache rule conditions", () => {
    const rule = cacheRuleInput.parse({
      paths: ["/index.html"],
      statusCodes: [200, 404],
      minSizeBytes: 10,
      maxSizeBytes: 100,
      staleIfErrorSeconds: 60,
    });
    expect(rule).toMatchObject({ paths: ["/index.html"], statusCodes: [200, 404] });
    expect(cacheRuleInput.safeParse({ minSizeBytes: 100, maxSizeBytes: 10 }).success).toBe(false);
    expect(cacheRuleInput.safeParse({ statusCodes: [99] }).success).toBe(false);
    expect(cacheRuleInput.safeParse({ paths: ["no-slash"] }).success).toBe(false);
  });

  it("respects origin Cache-Control unless a rule overrides it (audit 2026-10-01 P0-6)", () => {
    expect(cacheRuleInput.parse({}).originCacheControl).toBe("respect");
    expect(cacheRuleInput.parse({ originCacheControl: "override" }).originCacheControl).toBe(
      "override",
    );
  });

  it("does not cache requests with Authorization unless a rule allows it", () => {
    expect(cacheRuleInput.parse({}).cacheAuthorized).toBe(false);
    expect(cacheRuleInput.parse({ cacheAuthorized: true }).cacheAuthorized).toBe(true);
    expect(cacheRuleInput.safeParse({ cacheAuthorized: "yes" }).success).toBe(false);
    const parsed = siteCreateInput.parse({
      name: "api",
      domains: ["api.test"],
      origins: [{ address: "origin.test" }],
      cacheRules: [{ pathPrefixes: ["/"] }],
    });
    expect(parsed.cacheRules[0]?.cacheAuthorized).toBe(false);
  });

  it("validates cache key policies", () => {
    expect(cacheKeyPolicy.parse({ headers: ["Accept-Language"] }).headers).toEqual([
      "accept-language",
    ]);
    expect(cacheKeyPolicy.safeParse({ headers: ["Cookie"] }).success).toBe(false);
    expect(cacheKeyPolicy.safeParse({ headers: ["bad header"] }).success).toBe(false);
    expect(cacheKeyPolicy.safeParse({ queryParams: ["a&b"] }).success).toBe(false);
    expect(cacheKeyPolicy.parse({ query: "include", queryParams: ["v"] }).queryParams).toEqual([
      "v",
    ]);
  });

  it("requires targets that match the task type", () => {
    expect(cacheTaskCreateInput.safeParse({ type: "url", urls: [] }).success).toBe(false);
    expect(cacheTaskCreateInput.safeParse({ type: "site", urls: ["http://a.test/"] }).success).toBe(
      false,
    );
    expect(
      cacheTaskCreateInput.safeParse({
        type: "site",
        siteIds: ["00000000-0000-4000-8000-000000000000"],
      }).success,
    ).toBe(true);
    expect(
      cacheTaskCreateInput.safeParse({ type: "url", urls: Array(501).fill("http://a.test/") })
        .success,
    ).toBe(false);
  });
});
