import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { certificateErrorDefs } from "@edgeweir/contract";
import { describe, expect, it } from "vitest";
import { certificateErrorText } from "../../src/web/lib/certificate-errors";
import { overwriteGetLocale } from "../../src/web/paraglide/runtime.js";

describe("certificate failure texts", () => {
  overwriteGetLocale(() => "en");

  it("localizes certificate codes, then DNS provider codes, then shows the code", () => {
    expect(certificateErrorText("")).toBe("");
    expect(certificateErrorText("acme_caa")).toBe("A CAA record does not allow this CA");
    expect(certificateErrorText("http01_dns_not_pointing")).toBe(
      "A domain does not resolve to the nodes",
    );
    // DNS-01 provider failures read as on DNS revisions.
    expect(certificateErrorText("dns_auth_failed")).toBe("Provider authentication failed");
    expect(certificateErrorText("quantum_foam")).toBe("Issuance failed (quantum_foam)");
    expect(certificateErrorText("toString")).toBe("Issuance failed (toString)");
  });

  it("has a text for every code the certificate helper reports", () => {
    // String literals of certd's codes (failure.go, acme.go, …): each is a
    // certificate code or a DNS code the UI words already.
    const dir = resolve(import.meta.dirname, "../../../../helpers/certd");
    const sources = readdirSync(dir)
      .filter((file) => file.endsWith(".go") && !file.endsWith("_test.go"))
      .map((file) => readFileSync(resolve(dir, file), "utf8"))
      .join("\n");
    const codes = [...sources.matchAll(/"((?:acme|certd|dns)_[a-z0-9_]+)"/g)].map(
      (m) => m[1] ?? "",
    );
    expect(codes).toContain("acme_unauthorized");
    for (const code of new Set(codes)) {
      const known =
        Object.hasOwn(certificateErrorDefs, code) ||
        certificateErrorText(code) !== `Issuance failed (${code})`;
      expect(known, code).toBe(true);
    }
  });
});
