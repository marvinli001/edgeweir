import { readFileSync } from "node:fs";
import {
  displaySiteDomain,
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
    const patterns = Array.from({ length: 11 }, (_, i) => `~a${i}\\.com`);
    expect(siteDomains.safeParse(patterns.slice(0, 10)).success).toBe(true);
    expect(siteDomains.safeParse(patterns).success).toBe(false);
    expect(siteDomains.safeParse(Array.from({ length: 51 }, (_, i) => `a${i}.com`)).success).toBe(
      false,
    );
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
