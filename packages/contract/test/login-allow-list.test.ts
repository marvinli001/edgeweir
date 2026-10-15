import { describe, expect, it } from "vitest";
import {
  demoCidr,
  loginAllowListContains,
  loginAllowListInput,
  MAX_LOGIN_ALLOWED_CIDRS,
} from "../src";

describe("login allow list", () => {
  it("normalizes entries and caps the list", () => {
    expect(
      loginAllowListInput.parse({ cidrs: [" 1.2.3.4 ", "10.1.2.3/8", "2001:DB8::1/48", "::1"] }),
    ).toEqual({ cidrs: ["1.2.3.4/32", "10.0.0.0/8", "2001:db8::/48", "::1/128"] });
    expect(loginAllowListInput.safeParse({ cidrs: ["1.2.3.0/33"] }).success).toBe(false);
    expect(loginAllowListInput.safeParse({ cidrs: ["example.com"] }).success).toBe(false);
    const many = Array.from({ length: MAX_LOGIN_ALLOWED_CIDRS + 1 }, (_, i) => `10.0.${i}.0/24`);
    expect(loginAllowListInput.safeParse({ cidrs: many.slice(1) }).success).toBe(true);
    expect(loginAllowListInput.safeParse({ cidrs: many }).success).toBe(false);
  });

  it("matches IPv4 and IPv6 addresses against their ranges", () => {
    const list = ["1.2.3.0/24", "2001:db8:1::/48", "9.9.9.9/32"];
    expect(loginAllowListContains(list, "1.2.3.200")).toBe(true);
    expect(loginAllowListContains(list, "1.2.4.1")).toBe(false);
    expect(loginAllowListContains(list, "9.9.9.9")).toBe(true);
    expect(loginAllowListContains(list, "2001:db8:1:ffff::5")).toBe(true);
    expect(loginAllowListContains(list, "2001:DB8:1::5")).toBe(true);
    expect(loginAllowListContains(list, "2001:db8:2::5")).toBe(false);
    expect(loginAllowListContains(["0.0.0.0/0"], "8.8.8.8")).toBe(true);
    expect(loginAllowListContains(["::/0"], "2a00::1")).toBe(true);
  });

  it("never matches across address families", () => {
    expect(loginAllowListContains(["0.0.0.0/0"], "2a00::1")).toBe(false);
    expect(loginAllowListContains(["::/0"], "8.8.8.8")).toBe(false);
  });

  it("treats IPv4-mapped IPv6 addresses and ranges as IPv4", () => {
    expect(loginAllowListContains(["1.2.3.0/24"], "::ffff:1.2.3.4")).toBe(true);
    expect(loginAllowListContains(["1.2.3.0/24"], "::ffff:102:304")).toBe(true);
    expect(loginAllowListContains(["::ffff:1.2.3.0/120"], "1.2.3.4")).toBe(true);
    expect(loginAllowListContains(["::ffff:1.2.3.0/120"], "1.2.4.4")).toBe(false);
    // Only the mapped prefix: NAT64 and IPv4-compatible forms stay IPv6.
    expect(loginAllowListContains(["1.2.3.0/24"], "64:ff9b::1.2.3.4")).toBe(false);
    expect(loginAllowListContains(["1.2.3.0/24"], "::1.2.3.4")).toBe(false);
  });

  it("matches nothing that is not a single address", () => {
    expect(loginAllowListContains(["0.0.0.0/0"], "")).toBe(false);
    expect(loginAllowListContains(["0.0.0.0/0"], "1.2.3.0/24")).toBe(false);
    expect(loginAllowListContains(["0.0.0.0/0"], "localhost")).toBe(false);
    expect(loginAllowListContains([], "1.2.3.4")).toBe(false);
    expect(loginAllowListContains(["junk"], "1.2.3.4")).toBe(false);
  });

  it("cuts ranges to /24 and /48 for the demo account", () => {
    expect(demoCidr("1.2.3.4/32")).toBe("1.2.3.0/24");
    expect(demoCidr("1.2.3.128/25")).toBe("1.2.3.0/24");
    expect(demoCidr("10.0.0.0/8")).toBe("10.0.0.0/8");
    expect(demoCidr("2001:db8:1:2::/64")).toBe("2001:db8:1::/48");
    expect(demoCidr("2001:db8::/32")).toBe("2001:db8::/32");
    expect(demoCidr("junk")).toBe("");
  });
});
