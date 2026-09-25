import { describe, expect, it } from "vitest";
import { contract, domainName, extension, siteCreateInput } from "../src/index";

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
