import { describe, expect, it } from "vitest";
import {
  auditLogListInput,
  contract,
  domainName,
  errorCodes,
  errorDefs,
  extension,
  isErrorCode,
  reasonText,
  regionCode,
  revisionReasonCodes,
  revisionReasonDefs,
  siteCreateInput,
  siteListInput,
  siteUpdateInput,
  userCreateInput,
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
    });
    expect(parsed.cacheRules).toEqual([]);
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
  it("normalise region codes and user e-mails", () => {
    expect(regionCode.parse(" CN-East ")).toBe("cn-east");
    expect(regionCode.safeParse("east asia").success).toBe(false);
    const user = userCreateInput.parse({
      name: "Member",
      email: " Member@Example.COM ",
      password: "correct horse battery",
    });
    expect(user).toMatchObject({ email: "member@example.com", isAdmin: false, role: "member" });
    expect(
      userCreateInput.safeParse({ name: "x", email: "x@example.com", password: "short" }).success,
    ).toBe(false);
  });
});

describe("error and reason codes", () => {
  it("are stable identifiers with HTTP error statuses", () => {
    expect(errorCodes.length).toBeGreaterThan(10);
    for (const code of errorCodes) {
      expect(code).toMatch(/^[A-Z][A-Z0-9_]+$/);
      expect(errorDefs[code].status).toBeGreaterThanOrEqual(400);
      expect(errorDefs[code].status).toBeLessThan(500);
    }
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
