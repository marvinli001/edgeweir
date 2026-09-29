import { describe, expect, it } from "vitest";
import { nodeSupportsFeature } from "../src/index";

describe("nodeSupportsFeature", () => {
  it("reads subdivisions from geoip-city-v1 only on nodes that predate geoip-country-v1", () => {
    const legacyCity = ["rules-v1", "geoip-city-v1"];
    const ipinfoOnly = ["rules-v1", "geoip-country-v1", "geoip-city-v1", "geoip-asn-v1"];
    const ipinfoAndCity = [...ipinfoOnly, "geoip-subdivision-v1"];
    expect(nodeSupportsFeature(legacyCity, "geoip-subdivision-v1")).toBe(true);
    expect(nodeSupportsFeature(ipinfoOnly, "geoip-subdivision-v1")).toBe(false);
    expect(nodeSupportsFeature(ipinfoAndCity, "geoip-subdivision-v1")).toBe(true);
    expect(nodeSupportsFeature(["rules-v1"], "geoip-subdivision-v1")).toBe(false);
    expect(nodeSupportsFeature(ipinfoOnly, "geoip-city-v1")).toBe(true);
    expect(nodeSupportsFeature(legacyCity, "geoip-asn-v1")).toBe(false);
  });
});
