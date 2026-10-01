import { describe, expect, it } from "vitest";
import {
  banCreateInput,
  cidrsOverlap,
  isSingleAddress,
  parseBanCidr,
  parseCidr,
  protectedBanOverlap,
} from "../src/index";

const text = (input: string) => {
  const parsed = parseBanCidr(input);
  return parsed.ok ? parsed.text : parsed;
};

describe("ban CIDRs", () => {
  it("canonicalizes addresses and prefixes", () => {
    expect(text("203.0.113.7")).toBe("203.0.113.7/32");
    expect(text(" 203.0.113.77/24 ")).toBe("203.0.113.0/24");
    expect(text("2001:DB8:0:0:0:0:0:1")).toBe("2001:db8::1/128");
    expect(text("2001:db8:1:2:3::/48")).toBe("2001:db8:1::/48");
    expect(text("::ffff:198.51.100.9")).toBe("198.51.100.9/32");
    expect(text("::ffff:198.51.100.0/120")).toBe("198.51.100.0/24");
  });

  it("refuses prefixes shorter than /16 (IPv4) or /48 (IPv6)", () => {
    expect(text("10.0.0.0/16")).toBe("10.0.0.0/16");
    expect(text("10.0.0.0/15")).toEqual({ ok: false, code: "BAN_PREFIX_TOO_SHORT", min: 16 });
    expect(text("2001:db8::/47")).toEqual({ ok: false, code: "BAN_PREFIX_TOO_SHORT", min: 48 });
    // A mapped prefix too short to be IPv4 stays IPv6.
    expect(text("::ffff:0:0/95")).toBe("::fffe:0:0/95");
  });

  it("refuses text that is not an address or CIDR", () => {
    for (const input of ["", "example.com", "1.2.3", "1.2.3.4/33", "::1/129", "1.2.3.4/0x10"])
      expect(text(input), input).toEqual({ ok: false, code: "BAN_INVALID_CIDR" });
  });

  it("tells single addresses apart", () => {
    const one = parseBanCidr("192.0.2.1");
    const net = parseBanCidr("192.0.2.0/24");
    expect(one.ok && isSingleAddress(one.cidr)).toBe(true);
    expect(net.ok && isSingleAddress(net.cidr)).toBe(false);
  });

  it("finds overlaps with protected addresses", () => {
    const covers = (input: string, extra: string[] = []) => {
      const parsed = parseBanCidr(input);
      if (!parsed.ok) throw new Error(input);
      return protectedBanOverlap(parsed.cidr, extra);
    };
    expect(covers("127.0.0.0/16")).toBe("127.0.0.0/8");
    expect(covers("::/48")).toBe("::/128");
    expect(covers("192.0.2.0/24", ["192.0.2.10"])).toBe("192.0.2.10");
    expect(covers("192.0.2.10", ["192.0.2.0/24"])).toBe("192.0.2.0/24");
    expect(covers("192.0.3.0/24", ["192.0.2.0/24", "garbage"])).toBeNull();
    expect(covers("2001:db8::1", ["192.0.2.1"])).toBeNull();
  });

  it("overlaps when one CIDR contains the other", () => {
    const c = (value: string) => parseCidr(value) ?? parseCidr("0.0.0.0/32");
    const [a, b, d] = [c("10.0.0.0/8"), c("10.1.0.0/16"), c("11.0.0.0/16")];
    if (!a || !b || !d) throw new Error("parse");
    expect(cidrsOverlap(a, b)).toBe(true);
    expect(cidrsOverlap(b, a)).toBe(true);
    expect(cidrsOverlap(a, d)).toBe(false);
  });

  it("requires a site for site bans and none for platform bans", () => {
    const base = { cidr: "192.0.2.1", reason: "abuse", durationSeconds: 60 };
    const siteId = "00000000-0000-4000-8000-000000000000";
    expect(banCreateInput.safeParse({ ...base, scope: "site", siteId }).success).toBe(true);
    expect(banCreateInput.safeParse({ ...base, scope: "platform" }).success).toBe(true);
    expect(banCreateInput.safeParse({ ...base, scope: "site" }).success).toBe(false);
    expect(banCreateInput.safeParse({ ...base, scope: "platform", siteId }).success).toBe(false);
  });
});
