import { readFileSync } from "node:fs";
import {
  displaySiteDomain,
  domainPatternError,
  hostMatcher,
  matchHost,
  parseSiteDomain,
  punycodeDecode,
  siteDomain,
  siteDomains,
  unicodeHost,
} from "@edgeweir/contract";
import { describe, expect, it } from "vitest";
import { normalizeSiteDomain, toAsciiHost } from "../../src/server/lib/idna";
import "../../src/server/lib/regexp-engine";

const idna = JSON.parse(
  readFileSync(new URL("./fixtures/idna-vectors.json", import.meta.url), "utf8"),
) as { source: string; vectors: { input: string; ascii: string | null; status?: string[] }[] };

describe("site domain forms", () => {
  it("converts host names like UTS #46 (official IdnaTestV2 subset)", () => {
    expect(idna.source).toBe("IdnaTestV2.txt 16.0.0 (2024-07-03, 22:06:44 GMT)");
    expect(idna.vectors.filter((v) => v.ascii !== null).length).toBe(150);
    expect(idna.vectors.filter((v) => v.ascii === null).length).toBeGreaterThan(100);
    const wrong = idna.vectors
      .map((v) => ({ ...v, got: toAsciiHost(v.input) }))
      .filter((v) => v.got !== v.ascii);
    expect(wrong).toEqual([]);
  });

  it("decodes Punycode for display and round-trips the accepted vectors", () => {
    for (const v of idna.vectors) {
      if (v.ascii === null) continue;
      expect(toAsciiHost(unicodeHost(v.ascii))).toBe(v.ascii);
    }
    expect(punycodeDecode("bcher-kva")).toBe("bücher");
    expect(punycodeDecode("-> $1.00 <--")).toBe("-> $1.00 <-");
    // RFC 3492 7.1 (L) Japanese: 3<nen>B<gumi><kinpachi><sensei>
    expect(punycodeDecode("3B-ww4c5e180e575a65lsy2b")).toBe("3年B組金八先生");
    expect(punycodeDecode("9")).toBeNull();
    expect(unicodeHost("www.xn--bcher-kva.example")).toBe("www.bücher.example");
    expect(displaySiteDomain("*.xn--fiqs8s.example")).toBe("*.中国.example");
    expect(displaySiteDomain(".xn--fiqs8s.example")).toBe(".中国.example");
    expect(displaySiteDomain("~xn--.*")).toBe("~xn--.*");
    // Mixed scripts (look-alikes) and invisible characters stay in Punycode.
    expect(unicodeHost("xn--pple-43d.com")).toBe("xn--pple-43d.com");
    expect(unicodeHost("xn--pypal-4ve.com")).toBe("xn--pypal-4ve.com");
    expect(unicodeHost("xn--b-ugn.test")).toBe("xn--b-ugn.test");
    // One script, or Latin with Han and kana, Bopomofo or Hangul, is shown.
    expect(unicodeHost("xn--fiqs8s.g10.test")).toBe("中国.g10.test");
    expect(unicodeHost("xn--wgv71a119e.jp")).toBe("日本語.jp");
    expect(displaySiteDomain("*.xn--bcher-kva.example")).toBe("*.bücher.example");
  });

  it("parses the four forms", () => {
    expect(normalizeSiteDomain(" WWW.A.com ")).toEqual({ kind: "exact", name: "www.a.com" });
    expect(normalizeSiteDomain("*.A.com")).toEqual({ kind: "wildcard", name: "a.com" });
    expect(normalizeSiteDomain(".a.com")).toEqual({ kind: "suffix", name: "a.com" });
    expect(normalizeSiteDomain("~(www|api)\\.a\\.com")).toEqual({
      kind: "regex",
      name: "(www|api)\\.a\\.com",
    });
    expect(normalizeSiteDomain("Bücher.example")).toEqual({
      kind: "exact",
      name: "xn--bcher-kva.example",
    });
    expect(normalizeSiteDomain(".中国。example")).toEqual({
      kind: "suffix",
      name: "xn--fiqs8s.example",
    });
    expect(normalizeSiteDomain("faß.de")?.name).toBe("xn--fa-hia.de");
    for (const bad of [
      ".com",
      "*.com",
      "a..com",
      "-a.com",
      "a_b.com",
      "a.com.",
      "*.*.a.com",
      "..a.com",
      "~",
      "~(?:a)",
      "~[A-Z]+\\.com",
      "~a\\\\b",
      '~a"b',
      "~a b",
      `~${"a".repeat(257)}`,
      "xn--a.com",
      "a\u0000.com",
    ])
      expect(normalizeSiteDomain(bad), bad).toBeNull();
    // Escapes keep their letters; hex digits may be uppercase.
    expect(normalizeSiteDomain("~\\d+\\.a\\.com")?.kind).toBe("regex");
    expect(normalizeSiteDomain("~\\x2D\\.a\\.com")?.kind).toBe("regex");
    expect(normalizeSiteDomain(`~${"a".repeat(256)}`)?.kind).toBe("regex");
  });

  it("keeps Unicode hosts for the console to convert, and limits regex domains", () => {
    expect(siteDomain.parse("Bücher.example")).toBe("Bücher.example");
    expect(siteDomain.parse("*.WWW.A.com")).toBe("*.www.a.com");
    expect(siteDomain.safeParse("a/b.com").success).toBe(false);
    expect(parseSiteDomain("~a.com")).toEqual({ kind: "regex", name: "a.com" });
    // At most two repeating quantifiers (the console's backtracking engine),
    // no comma outside {n,m} (a Host never holds one).
    expect(domainPatternError("[a-z]+-\\d+\\.a\\.com")).toBeNull();
    expect(domainPatternError("\\d{1,3}\\.\\d{1,3}\\.a\\.com")).toBeNull();
    expect(domainPatternError(".*.*.*\\.a\\.com")).toBe("too_complex");
    expect(domainPatternError("[a-z0-9-]*-[a-z0-9-]*-[a-z0-9-]*\\.a\\.com")).toBe("too_complex");
    expect(domainPatternError("[*+]x\\.a\\.com")).toBeNull();
    expect(domainPatternError("(www|m)\\.a\\.com,shop\\.b\\.com")).toBe("character");
    expect(domainPatternError("a{1,3}\\.com")).toBeNull();
    expect(siteDomain.safeParse("~.*.*.*\\.a\\.com").success).toBe(false);
    const patterns = Array.from({ length: 11 }, (_, i) => `~a${i}\\.com`);
    expect(siteDomains.safeParse(patterns.slice(0, 10)).success).toBe(true);
    expect(siteDomains.safeParse(patterns).success).toBe(false);
    expect(siteDomains.safeParse(Array.from({ length: 51 }, (_, i) => `a${i}.com`)).success).toBe(
      false,
    );
  });

  it("bounds pattern domains: repeats, branches; the console's engine falls back to linear time", () => {
    expect(domainPatternError("a{3}\\.com")).toBeNull();
    expect(domainPatternError("(www|m)\\.a\\.com")).toBeNull();
    expect(domainPatternError("(a|a)(a|a)(a|a)(a|a)(a|a)x\\.com")).toBe("too_complex");
    expect(domainPatternError("a?a?a?a?a?aaaaa\\.com")).toBe("too_complex");
    expect(domainPatternError("(a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q)\\.com")).toBe("too_complex");
    // A pattern past the rules (say stored before them) still cannot block the console.
    const matcher = hostMatcher([
      { kind: "regex" as const, name: `${"(a|a)".repeat(28)}\\.org`, value: "slow" },
    ]);
    const started = performance.now();
    expect(matchHost(matcher, `${"a".repeat(28)}.com`)).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(500);
    // Node IP access and hosts longer than a DNS name: exact names only.
    const any = hostMatcher([
      { kind: "regex" as const, name: "[0-9a-z._]+", value: "any" },
      { kind: "exact" as const, name: "198.51.100.7", value: "ip" },
    ]);
    expect(matchHost(any, "203.0.113.5")).toBeUndefined();
    expect(matchHost(any, "_")).toBeUndefined();
    expect(matchHost(any, "198.51.100.7")).toBe("ip");
    expect(matchHost(any, `${"a".repeat(249)}.com`)).toBe("any");
    expect(matchHost(any, `${"a".repeat(250)}.com`)).toBeUndefined();
  });

  it("matches hosts by precedence: exact, *., the longest ., then regex in order", () => {
    const matcher = hostMatcher([
      { kind: "exact", name: "a.com", value: "exact" },
      { kind: "wildcard", name: "a.com", value: "wildcard" },
      { kind: "suffix", name: "a.com", value: "suffix" },
      { kind: "suffix", name: "b.a.com", value: "suffix-b" },
      { kind: "regex", name: "x\\d\\.y\\.a\\.com", value: "regex-1" },
      { kind: "regex", name: ".*\\.org", value: "regex-2" },
      { kind: "regex", name: "z\\.org", value: "regex-3" },
    ]);
    expect(matchHost(matcher, "a.com")).toBe("exact");
    expect(matchHost(matcher, "x.a.com")).toBe("wildcard");
    expect(matchHost(matcher, "y.x.a.com")).toBe("suffix");
    expect(matchHost(matcher, "c.b.a.com")).toBe("suffix-b");
    expect(matchHost(matcher, "b.a.com")).toBe("wildcard");
    expect(matchHost(matcher, "x1.y.a.com")).toBe("suffix");
    expect(matchHost(matcher, "z.org")).toBe("regex-2");
    expect(matchHost(matcher, "org")).toBeUndefined();
    expect(matchHost(matcher, "b.com")).toBeUndefined();
  });
});
