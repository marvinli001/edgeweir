import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { errorCodes, errorDefs, revisionReasonCodes, revisionReasonDefs } from "@edgeweir/contract";
import { describe, expect, it } from "vitest";

const load = (locale: string) =>
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, `../../messages/${locale}.json`), "utf8"),
  ) as Record<string, string>;
const settings = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../project.inlang/settings.json"), "utf8"),
) as { baseLocale: string; locales: string[] };

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("i18n messages", () => {
  const zh = load("zh-CN");
  const en = load("en");

  it("defaults to zh-CN and also ships en", () => {
    expect(settings.baseLocale).toBe("zh-CN");
    expect(settings.locales).toEqual(["zh-CN", "en"]);
  });

  it("has the same keys in every locale", () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
  });

  it("uses the same placeholders in every locale and never leaves a message empty", () => {
    for (const key of Object.keys(zh)) {
      if (key === "$schema") continue;
      expect(zh[key]?.trim(), key).toBeTruthy();
      expect(en[key]?.trim(), key).toBeTruthy();
      expect(placeholders(en[key] ?? ""), key).toEqual(placeholders(zh[key] ?? ""));
    }
  });

  it("localizes every API error code and revision reason with the same parameters", () => {
    for (const code of errorCodes) {
      const key = `error_${code.toLowerCase()}`;
      expect(zh[key], key).toBeTruthy();
      expect(placeholders(zh[key] ?? ""), key).toEqual([...errorDefs[code].params].sort());
    }
    for (const code of revisionReasonCodes) {
      const key = `revision_reason_${code}`;
      expect(zh[key], key).toBeTruthy();
      expect(placeholders(zh[key] ?? ""), key).toEqual([...revisionReasonDefs[code].params].sort());
    }
  });

  it("keeps UI strings out of components (no hard-coded CJK in web sources)", async () => {
    const { globSync } = await import("node:fs");
    const files = globSync("src/web/{routes,components}/**/*.tsx", {
      cwd: resolve(import.meta.dirname, "../.."),
    });
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(resolve(import.meta.dirname, "../..", file), "utf8");
      expect(/[一-鿿]/.test(source), file).toBe(false);
    }
  });
});
