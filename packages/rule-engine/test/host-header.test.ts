import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MAX_HOST_HEADER_LENGTH, validActionIr, validHostHeader } from "../src/index";

// edgeweir-node keeps an identical copy in internal/configir/testdata/host_header_vectors.json
// (TestHostHeaderVectors runs its validHostHeader over the same cases).
const vectors = JSON.parse(
  readFileSync(new URL("./host_header_vectors.json", import.meta.url), "utf8"),
) as { description: string; cases: { value: string; valid: boolean; note?: string }[] };

describe("validHostHeader", () => {
  it("agrees with edgeweir-node on every shared vector", () => {
    expect(new Set(vectors.cases.map((c) => c.valid))).toEqual(new Set([true, false]));
    for (const { value, valid, note } of vectors.cases) {
      expect(validHostHeader(value), `${JSON.stringify(value)} ${note ?? ""}`).toBe(valid);
    }
  });

  it("counts the length in UTF-8 bytes", () => {
    const zone = (n: number) => `fe80::1%${"é".repeat(n)}`;
    expect(new TextEncoder().encode(zone(125)).length).toBe(MAX_HOST_HEADER_LENGTH - 1);
    expect(validHostHeader(zone(125))).toBe(true);
    expect(validHostHeader(zone(126))).toBe(false);
  });

  it("checks the Host header of origin actions like nodes do", () => {
    const origin = (hostHeader: string) => validActionIr("origin", { kind: "origin", hostHeader });
    expect(origin("api.example.com")).toBe(true);
    expect(origin("api.example.com:8443")).toBe(true);
    expect(origin("[2001:db8::1]:443")).toBe(true);
    expect(origin("192.0.2.1")).toBe(true);
    expect(origin("bad host")).toBe(false);
    expect(origin("example.com/")).toBe(false);
    expect(origin("[2001:db8::1]")).toBe(false);
  });
});
