import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkDnsCredentials, dnsProviderCatalog, dnsProviderEntry } from "../src/dns-providers";

describe("DNS provider catalog", () => {
  it("is what edgeweir-certd embeds (pnpm --filter @edgeweir/contract dns:catalog)", () => {
    const file = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../helpers/certd/catalog.json",
    );
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(dnsProviderCatalog);
  });

  it("has unique ids, snake_case keys and patterns that compile", () => {
    const ids = dnsProviderCatalog.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const provider of dnsProviderCatalog) {
      expect(provider.id).toMatch(/^[a-z0-9]+$/);
      const keys = provider.fields.map((f) => f.key);
      expect(new Set(keys).size, provider.id).toBe(keys.length);
      expect(
        provider.fields.some((f) => f.required),
        provider.id,
      ).toBe(true);
      for (const field of provider.fields as readonly {
        key: string;
        type: string;
        secret: boolean;
        pattern?: string;
        options?: readonly string[];
        default?: string;
      }[]) {
        expect(field.key, provider.id).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(field.secret, `${provider.id}.${field.key}`).toBe(
          field.type === "secret" || (field.type === "textarea" && field.secret),
        );
        if (field.pattern) expect(() => new RegExp(field.pattern ?? "")).not.toThrow();
        if (field.type === "select") {
          expect(field.options?.length, `${provider.id}.${field.key}`).toBeGreaterThan(0);
          if (field.default) expect(field.options).toContain(field.default);
        }
      }
    }
  });

  it("checks credentials: keys, required fields, control characters, patterns, options, URLs", () => {
    expect(checkDnsCredentials("nope", {})).toEqual({ ok: false, problem: "unknown_provider" });
    expect(checkDnsCredentials("cloudflare", { api_token: "t", other: "x" })).toEqual({
      ok: false,
      problem: "unknown_field",
      field: "other",
    });
    expect(checkDnsCredentials("cloudflare", { zone_token: "z" })).toMatchObject({
      problem: "missing_field",
      field: "api_token",
    });
    expect(checkDnsCredentials("cloudflare", { api_token: "a\u0000b" })).toMatchObject({
      problem: "invalid_field",
    });
    // Optional empty values are dropped; secrets are kept verbatim.
    const token = "0123456789abcdefghij";
    expect(checkDnsCredentials("cloudflare", { api_token: token, zone_token: "" })).toEqual({
      ok: true,
      value: { api_token: token },
    });
    expect(checkDnsCredentials("vultr", { api_key: " k " })).toEqual({
      ok: true,
      value: { api_key: " k " },
    });
    // Patterns come from the provider documentation (Cloudflare tokens: 20+ characters).
    expect(checkDnsCredentials("cloudflare", { api_token: "short" })).toMatchObject({
      problem: "invalid_field",
      field: "api_token",
    });
    expect(
      checkDnsCredentials("huaweicloud", {
        access_key_id: "id",
        secret_access_key: "s",
        region_id: "cn-north-4@127.0.0.1/#",
      }),
    ).toMatchObject({ problem: "invalid_field", field: "region_id" });
    expect(dnsProviderEntry("googleclouddns")?.fields[0]?.type).toBe("textarea");
    expect(
      checkDnsCredentials("googleclouddns", { service_account_json: '{\n  "type": "x"\n}' }).ok,
    ).toBe(true);
    for (const url of ["ftp://h.test", "https://u:p@h.test/", "https://h.test/#frag", "nope"])
      expect(
        checkDnsCredentials("webhook", { url, secret: "0123456789abcdef" }),
        url,
      ).toMatchObject({ problem: "invalid_field", field: "url" });
    expect(
      checkDnsCredentials("webhook", { url: "https://h.test/hook?x=1", secret: "0123456789abcdef" })
        .ok,
    ).toBe(true);
    expect(
      checkDnsCredentials("webhook", { url: "https://h.test/", secret: "short" }),
    ).toMatchObject({ field: "secret" });
  });
});

describe("outbound address policy of edgeweir-certd", () => {
  it("refuses the same special-purpose ranges as the console", async () => {
    const { SPECIAL_PURPOSE_IPV4, SPECIAL_PURPOSE_IPV6 } = await import("../src/addresses");
    const source = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "../../../helpers/certd/internal/dnsx/policy.go",
      ),
      "utf8",
    );
    const list = source.slice(source.indexOf("var SpecialPurpose = []string{"));
    const ranges = [...list.slice(0, list.indexOf("}")).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(ranges).toEqual([...SPECIAL_PURPOSE_IPV4, ...SPECIAL_PURPOSE_IPV6]);
  });
});
