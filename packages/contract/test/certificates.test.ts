import { describe, expect, it } from "vitest";
import { certificateRequest, tlsSettings } from "../src/index";

const request = { name: "c", names: ["a.example.com"], email: "ops@example.com" };
const issuePaths = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join(".")) ?? [];

describe("certificate schemas", () => {
  it("name the field a cross-field rule refuses", () => {
    expect(
      issuePaths(certificateRequest.safeParse({ ...request, names: ["*.example.com"] })),
    ).toEqual(["names"]);
    expect(issuePaths(certificateRequest.safeParse({ ...request, challenge: "dns01" }))).toEqual([
      "dnsCredentialId",
    ]);
    expect(issuePaths(certificateRequest.safeParse({ ...request, ca: "zerossl" }))).toEqual([
      "eabKid",
    ]);
    expect(issuePaths(tlsSettings.safeParse({ forceHttps: true }))).toEqual(["certificateId"]);
  });

  it("checks the names' DNS by default", () => {
    expect(certificateRequest.parse(request).skipDnsCheck).toBe(false);
  });
});
