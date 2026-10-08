import { describe, expect, it } from "vitest";
import { displayableLabel, displaySiteDomain, punycodeDecode, unicodeHost } from "../src/domains";

// The Punycode forms are what the console stores (UTS #46 ToASCII, lib/idna.ts).
const decoded = (host: string) =>
  host
    .split(".")
    .map((label) => (label.startsWith("xn--") ? punycodeDecode(label.slice(4)) : label))
    .join(".");

describe("Unicode display of host names (look-alike rule)", () => {
  it("shows labels whose characters share a script by Script_Extensions", () => {
    // ー (U+30FC) is Common by Script, Hiragana and Katakana by Script_Extensions.
    expect(unicodeHost("xn--4dkp5a8a.jp")).toBe("ラーメン.jp");
    expect(unicodeHost("xn--tck2c4fb.jp")).toBe("コーヒー.jp");
    expect(unicodeHost("xn--ebkp5a86a.jp")).toBe("らーめん.jp");
    expect(unicodeHost("xn--4dkp5a8a7137b.jp")).toBe("ラーメン屋.jp");
    expect(displaySiteDomain("*.xn--tck2c4fb.jp")).toBe("*.コーヒー.jp");
    // 々 (U+3005) is Han.
    expect(unicodeHost("xn--u6jy55gilq.jp")).toBe("佐々木.jp");
    // The Arabic tatweel (U+0640) is Arabic by Script_Extensions.
    expect(unicodeHost("xn--mgbbop1f0a.test")).toBe("مرحبـا.test");
    // Arabic with Arabic-Indic digits.
    expect(unicodeHost("xn--mgbbop3hqi.test")).toBe("مرحبا٣.test");
  });

  it("shows Latin mixed with Han and kana, Bopomofo or Hangul", () => {
    expect(unicodeHost("xn--abc-r73b4fvb9jq026a6htb.jp")).toBe("abcひらがな漢字.jp");
    expect(unicodeHost("xn--abc-tt4bf2116dn72a.tw")).toBe("ㄅㄆ漢字abc.tw");
    expect(unicodeHost("xn--abc-269er78f7t7fgutc.kr")).toBe("abc한글漢字.kr");
    expect(unicodeHost("xn--bj0bj06e.kr")).toBe("한글.kr");
    // Hangul with kana is no allowed mix.
    expect(unicodeHost("xn--y9j4970c.kr")).toBe("xn--y9j4970c.kr");
  });

  it("keeps ー in Punycode unless kana come right before it", () => {
    // ー reads like a hyphen next to Latin; its Script_Extensions (Hiragana,
    // Katakana) alone do not make "paypalーlogin" a Latin+kana label.
    const dashes = [
      ["xn--paypallogin-zu5j.com", "paypalーlogin.com"],
      ["xn--securebank-dq5i.com", "secureーbank.com"],
      ["xn--abc-ss4b.com", "ーabc.com"],
      // The halfwidth ｰ maps to ー.
      ["xn--gogle-314d.com", "goーgle.com"],
      // Kana elsewhere in the label do not help (Chromium's rule).
      ["xn--ab-ec4awx.jp", "abーひ.jp"],
      ["xn--weka.jp", "ーー.jp"],
    ];
    for (const [ascii, unicode] of dashes) {
      expect(decoded(ascii as string)).toBe(unicode);
      expect(unicodeHost(ascii as string)).toBe(ascii);
    }
    expect(displayableLabel("goｰgle")).toBe(false);
    expect(displayableLabel("ラｰメン")).toBe(true);
    // Latin with a Katakana word is an allowed mix.
    expect(unicodeHost("xn--abc-sp4bob9c1c.jp")).toBe("abcラーメン.jp");
  });

  it("keeps Common letters next to Latin in Punycode", () => {
    const lookalikes = [
      ["xn--abcd-1lc.com", "abʼcd.com"], // U+02BC, scx includes Latin
      ["xn--abcd-hoc.com", "abˍcd.com"], // U+02CD, scx Latin Lisu
      ["xn--abcd-mnc.com", "abˇcd.com"], // U+02C7, scx Latin Bopomofo
      ["xn--abcd-woc.com", "abːcd.com"], // U+02D0, no script
      ["xn--abcd-cx3c.com", "ab〆cd.com"], // U+3006, scx Han
      ["xn--abcd-h33c.com", "ab〱cd.com"], // U+3031, scx Hiragana Katakana
      ["xn--abcd-cx4c.com", "ab・cd.com"], // U+30FB, a non-letter
    ];
    for (const [ascii, unicode] of lookalikes) {
      expect(decoded(ascii as string)).toBe(unicode);
      expect(unicodeHost(ascii as string)).toBe(ascii);
    }
    // Shown with characters of their own scripts.
    expect(unicodeHost("xn--xqa987uea.tw")).toBe("ㄅˇㄆ.tw");
    expect(unicodeHost("xn--v6j171kjom.jp")).toBe("漢〆字.jp");
    expect(unicodeHost("xn--37j3twa6b.jp")).toBe("ラ〱メン.jp");
    // Not alone, though.
    expect(unicodeHost("xn--v6j.jp")).toBe("xn--v6j.jp");
    // The quote look-alikes browsers keep in Punycode in every script.
    expect(decoded("xn--mqa85e8aza8d.xn--j1amh")).toBe("мʼята.укр");
    expect(unicodeHost("xn--mqa85e8aza8d.xn--j1amh")).toBe("xn--mqa85e8aza8d.укр");
  });

  it("keeps Latin with another script's digits in Punycode", () => {
    const lookalikes = [
      ["xn--ggle-02ja.com", "g০০gle.com"], // Bengali digit zero U+09E6
      ["xn--micrsft-3hsb.com", "micr୦s୦ft.com"], // Oriya digit zero U+0B66
      ["xn--ggle-bqqa.com", "g၀၀gle.com"], // Myanmar digit zero U+1040
    ];
    for (const [ascii, unicode] of lookalikes) {
      expect(decoded(ascii as string)).toBe(unicode);
      expect(unicodeHost(ascii as string)).toBe(ascii);
    }
  });

  it("keeps Latin mixed with Cyrillic in Punycode, shows a label all in Cyrillic", () => {
    expect(unicodeHost("xn--pple-43d.com")).toBe("xn--pple-43d.com");
    expect(unicodeHost("xn--80adxhks.xn--p1ai")).toBe("москва.рф");
    // A whole-script look-alike (Cyrillic "аре") is not caught: browsers
    // compare such labels with the TLD's script, which the console does not.
    expect(decoded("xn--80ak6a.com")).toBe("аре.com");
    expect(unicodeHost("xn--80ak6a.com")).toBe("аре.com");
  });

  it("keeps scripts outside the list and invisible characters in Punycode", () => {
    // Cherokee.
    expect(unicodeHost("xn--58dcd.test")).toBe("xn--58dcd.test");
    // UTS #46 drops default ignorables like the Hangul filler (U+3164), but a
    // Punycode label can still hold one.
    expect(decoded("xn--vhk7568avxya.test")).toBe("한ㅤ글.test");
    expect(unicodeHost("xn--vhk7568avxya.test")).toBe("xn--vhk7568avxya.test");
    expect(displayableLabel("한ㅤ글")).toBe(false);
    expect(displayableLabel("a͏b")).toBe(false);
    expect(displayableLabel("a️b")).toBe(false);
    expect(displayableLabel("a​b")).toBe(false);
    expect(displayableLabel("한글")).toBe(true);
    // Unassigned and private-use code points.
    expect(displayableLabel("a͸")).toBe(false);
    expect(displayableLabel("a")).toBe(false);
    // Only Common characters (digits, hyphen).
    expect(displayableLabel("123-456")).toBe(true);
  });
});
