import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  auditActionMessageKey,
  auditActions,
  auditTargetMessageKey,
  auditTargetTypes,
} from "@edgeweir/contract";
import { describe, expect, it } from "vitest";
import { auditActionLabel, auditTargetLabel } from "../../src/web/lib/audit";
import { overwriteGetLocale } from "../../src/web/paraglide/runtime.js";

const load = (locale: string) =>
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, `../../messages/${locale}.json`), "utf8"),
  ) as Record<string, unknown>;

describe("audit log labels", () => {
  const catalogs = [
    ["zh-CN", load("zh-CN")],
    ["en", load("en")],
  ] as const;

  it("lists every action and target type once", () => {
    expect(auditActions.length).toBeGreaterThan(100);
    expect(new Set(auditActions).size).toBe(auditActions.length);
    expect(new Set(auditTargetTypes).size).toBe(auditTargetTypes.length);
    // Two codes never share a message key ("a.b_c" and "a_b.c").
    expect(new Set(auditActions.map(auditActionMessageKey)).size).toBe(auditActions.length);
  });

  it("labels every action and target type the server records in both locales", () => {
    for (const [locale, messages] of catalogs) {
      for (const action of auditActions) {
        const key = auditActionMessageKey(action);
        expect(messages[key], `${locale} ${key}`).toEqual(expect.any(String));
      }
      for (const type of auditTargetTypes) {
        const key = auditTargetMessageKey(type);
        expect(messages[key], `${locale} ${key}`).toEqual(expect.any(String));
      }
    }
  });

  it("has no labels for actions or target types nobody records", () => {
    const actionKeys = new Set(auditActions.map(auditActionMessageKey));
    const targetKeys = new Set(auditTargetTypes.map(auditTargetMessageKey));
    const [, zh] = catalogs[0];
    for (const key of Object.keys(zh)) {
      if (key.startsWith("audit_action_")) expect(actionKeys, key).toContain(key);
      if (key.startsWith("audit_target_")) expect(targetKeys, key).toContain(key);
    }
  });

  it("shows labels and falls back to the code of older entries", () => {
    overwriteGetLocale(() => "en");
    expect(auditActionLabel("site.create")).toBe("Site created");
    expect(auditTargetLabel("node_group")).toBe("Node group");
    expect(auditActionLabel("organization.create")).toBe("organization.create");
    expect(auditTargetLabel("organization")).toBe("organization");
  });
});
