/// <reference path="../../src/server/lib/tr46.d.ts" />
import { type Options, toASCII } from "tr46";
import { describe, expect, it } from "vitest";
import { toAsciiHost } from "../../src/server/lib/idna";
import {
  BROWSER_PROBES,
  browserAscii,
  domainFormsAvailable,
  hostnameAscii,
  needsDomainForms,
  newDomains,
  storedDomain,
} from "../../src/web/lib/site-domains";

/** A browser's URL host parser: UTS #46 ToASCII as the URL Standard runs it, `options` changed. */
const urlParser =
  (options: Options = {}) =>
  (host: string) =>
    toASCII(host, {
      checkBidi: true,
      checkHyphens: false,
      checkJoiners: true,
      transitionalProcessing: false,
      useSTD3ASCIIRules: false,
      verifyDNSLength: false,
      ...options,
    });
const current = hostnameAscii(urlParser());
const transitional = hostnameAscii(urlParser({ transitionalProcessing: true }));
const noJoinerCheck = hostnameAscii(urlParser({ checkJoiners: false }));
// Before Unicode 15.1, UTS #46 mapped ẞ to "ss".
const oldSharpS = hostnameAscii((host) => urlParser()(host.replaceAll("ẞ", "ss")));

describe("domains typed into a site's list", () => {
  it("takes the stored form of Unicode, full-width and upper-case names", () => {
    expect(storedDomain("例え.JP")).toBe("xn--r8jz45g.jp");
    expect(storedDomain("Bücher-UI.g10.test")).toBe("xn--bcher-ui-65a.g10.test");
    expect(storedDomain("ｅｘａｍｐｌｅ.com")).toBe("example.com");
    expect(storedDomain("*.例え。jp")).toBe("*.xn--r8jz45g.jp");
    expect(storedDomain("XN--R8JZ45G.jp")).toBe("xn--r8jz45g.jp");
    expect(storedDomain("~(www|m)\\W\\.shop\\.test")).toBe("~(www|m)\\W\\.shop\\.test");
    expect(storedDomain("~(?=a)b")).toBeNull();
  });

  it("reads a leading ideographic or full-width full stop as a suffix's dot", () => {
    for (const dot of ["。", "．", "｡"]) {
      expect(storedDomain(`${dot}shop.example`)).toBe(".shop.example");
      expect(storedDomain(`${dot}例え.jp`)).toBe(".xn--r8jz45g.jp");
    }
  });

  it("recognises a name already listed in its stored form", () => {
    const listed = ["xn--r8jz45g.jp", "xn--bcher-ui-65a.g10.test", "example.com", ".shop.example"];
    expect(newDomains("例え.jp 例え。JP", listed)).toEqual([]);
    expect(newDomains("BÜCHER-UI.g10.test", listed)).toEqual([]);
    expect(newDomains("ｅｘａｍｐｌｅ.com", listed)).toEqual([]);
    expect(newDomains("。shop.example", listed)).toEqual([]);
    // Shown in Punycode (mixed scripts), typed in Unicode: still the same name.
    expect(newDomains("раypal.com", ["xn--ypal-43d9g.com"])).toEqual([]);
    expect(newDomains("micr୦s୦ft.com", ["xn--micrsft-3hsb.com"])).toEqual([]);
  });

  it("adds new names once, in their stored form", () => {
    expect(newDomains("例え.jp, 例え.JP new.test", ["example.com"])).toEqual([
      "xn--r8jz45g.jp",
      "new.test",
    ]);
    expect(newDomains("。a.test", ["a.test"])).toEqual([".a.test"]);
    // Earlier drafts count as listed in whatever form they were added.
    expect(newDomains("例え.jp", ["例え.jp"])).toEqual([]);
  });

  it("keeps patterns that differ only in letter case", () => {
    expect(storedDomain("~a\\Wb\\.test")).toBe("~a\\Wb\\.test");
    expect(storedDomain("~\\D\\.test")).toBe("~\\D\\.test");
    expect(newDomains("~a\\Wb\\.test", ["~a\\wb\\.test"])).toEqual(["~a\\Wb\\.test"]);
    expect(newDomains("~\\D\\.test ~\\B", ["~\\d\\.test", "~\\b"])).toEqual([
      "~\\D\\.test",
      "~\\B",
    ]);
    expect(newDomains("~a\\.test", ["~a\\.test"])).toEqual([]);
  });

  it("keeps a name that is not valid as typed, for the error", () => {
    expect(newDomains("~(?=a)b bad_name.test", [])).toEqual(["~(?=a)b", "bad_name.test"]);
  });

  it("recognises names with ß, ς, joiners or kana middle dots in a browser converting them as the console", () => {
    const listed = [
      "xn--strae-oqa.de",
      "xn--mxa8a.gr",
      "xn--mgbn2ecje63gr19l.ir",
      "xn--11b2ezcw70k.in",
      "xn--lck2c6g.jp",
      "xn--ll-0ea.cat",
    ];
    for (const typed of [
      "straße.de",
      "Straße.DE",
      "STRAẞE.de",
      "ας.gr",
      "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645.ir",
      "\u0915\u094d\u200d\u0937.in",
      "カ・ナ.jp",
      "l·l.cat",
    ]) {
      expect(storedDomain(typed, current)).toBe(toAsciiHost(typed));
      expect(newDomains(typed, listed, current)).toEqual([]);
    }
    // Other names to the console: σ for a typed Σ, the name without its joiner.
    expect(newDomains("ΑΣ.gr", listed, current)).toEqual(["xn--mxa0b.gr"]);
    expect(newDomains("strasse.de", listed, current)).toEqual(["strasse.de"]);
    expect(newDomains("\u0645\u06cc\u062e\u0648\u0627\u0647\u0645.ir", listed, current)).toEqual([
      "xn--mgbn2ecje63g.ir",
    ]);
    // A joiner out of context: refused by both, left to the console's error.
    expect(current("a\u200cb.de")).toBeNull();
    expect(storedDomain("a\u200cb.de", current)).toBe("a\u200cb.de");
  });

  it("probes the browser with hosts the console converts that way", () => {
    for (const probe of BROWSER_PROBES)
      for (const [host, ascii] of Object.entries(probe.hosts)) {
        expect(toAsciiHost(host)).toBe(ascii);
        expect(urlParser()(host)).toBe(ascii);
      }
  });

  it("leaves names a browser converts differently to the console", () => {
    // Transitional processing (older browsers): ß, ς and the joiners are not compared.
    for (const host of ["straße.de", "ας.gr", "\u0915\u094d\u200d\u0937.in"])
      expect(transitional(host)).toBeNull();
    expect(newDomains("straße.de", ["xn--strae-oqa.de"], transitional)).toEqual(["straße.de"]);
    expect(transitional("例え.jp")).toBe("xn--r8jz45g.jp");
    // No CheckJoiners: joiners are not compared, ß is.
    expect(noJoinerCheck("\u0915\u094d\u200d\u0937.in")).toBeNull();
    expect(noJoinerCheck("straße.de")).toBe("xn--strae-oqa.de");
    // ẞ mapped to "ss": names with ẞ are not compared, ß is.
    expect(oldSharpS("STRAẞE.de")).toBeNull();
    expect(oldSharpS("straße.de")).toBe("xn--strae-oqa.de");
    // Symbols the browser maps without UseSTD3ASCIIRules.
    expect(browserAscii("a⒈com")).toBeNull();
    expect(current("a⒈com")).toBeNull();
  });
});

describe("suffix and pattern domains", () => {
  it("are told by the stored form", () => {
    expect(needsDomainForms(["a.test", "*.a.test"])).toBe(false);
    expect(needsDomainForms(["a.test", ".a.test"])).toBe(true);
    expect(needsDomainForms(["~a\\.test"])).toBe(true);
    for (const dot of ["。", "．", "｡"]) {
      expect(needsDomainForms([`${dot}shop.example`])).toBe(true);
    }
  });

  it("need domains-v2 on every active node", () => {
    const node = (status: string, supportedFeatures: string[]) => ({ status, supportedFeatures });
    expect(domainFormsAvailable([])).toBe(true);
    expect(domainFormsAvailable([node("active", ["domains-v2"])])).toBe(true);
    expect(domainFormsAvailable([node("active", ["domains-v2"]), node("active", [])])).toBe(false);
    expect(domainFormsAvailable([node("active", ["domains-v2"]), node("disabled", [])])).toBe(true);
  });
});
