import { describe, expect, it } from "vitest";
import { originCertificateHostname, originCertificateIssue } from "../src/origin-pki";

describe("origin certificate requests", () => {
  it("names host names, internal single-label names, wildcards and IP literals", () => {
    for (const name of [
      "origin.example.com",
      "origin-tls",
      "*.example.com",
      "*.internal",
      "192.0.2.1",
      "2001:db8::1",
    ])
      expect(originCertificateHostname.safeParse(name).success, name).toBe(true);
    for (const name of [
      "",
      "*",
      "*.",
      "a b",
      "-bad",
      "*.*.example.com",
      "example.com:443",
      "https://x",
    ])
      expect(originCertificateHostname.safeParse(name).success, name).toBe(false);
    expect(originCertificateHostname.parse(" Origin.Example.COM ")).toBe("origin.example.com");
  });

  it("defaults to 15 years and ECDSA P-256, deduplicates names and limits them", () => {
    expect(originCertificateIssue.parse({ hostnames: ["a.test", "a.test", "b.test"] })).toEqual({
      hostnames: ["a.test", "b.test"],
      validityYears: 15,
      keyType: "ec256",
    });
    expect(originCertificateIssue.safeParse({ hostnames: [] }).success).toBe(false);
    expect(
      originCertificateIssue.safeParse({ hostnames: ["a.test"], validityYears: 2 }).success,
    ).toBe(false);
    expect(
      originCertificateIssue.safeParse({ hostnames: ["a.test"], keyType: "rsa4096" }).success,
    ).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => `h${i}.test`);
    expect(originCertificateIssue.safeParse({ hostnames: many }).success).toBe(false);
  });
});
