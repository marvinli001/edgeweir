import { ruleAction, ruleInput, siteRuleInput } from "@edgeweir/contract";
import { actionPhases } from "@edgeweir/rule-engine";
import { describe, expect, it } from "vitest";
import {
  type ActionOf,
  defaultAction,
  type Kind,
  RULE_BAN_DURATIONS,
  toggleSkip,
  WAF_V2_KINDS,
  withAccessLog,
  withRateLimitBan,
  withRespondStatus,
} from "../../src/web/lib/rule-actions";

const kinds = Object.keys(actionPhases) as Kind[];

describe("rule actions", () => {
  it("starts every kind with an action the contract accepts in its phases", () => {
    for (const kind of kinds) {
      const action = defaultAction(kind);
      expect(action.kind).toBe(kind);
      // An origin rule needs an override: the editor picks the site's first origin group.
      if (kind === "origin") continue;
      expect(ruleAction.safeParse(action).success, kind).toBe(true);
      for (const phase of actionPhases[kind] ?? [])
        expect(
          siteRuleInput.safeParse({ name: "r", phase, expression: "true", action }).success,
          `${kind} in ${phase}`,
        ).toBe(true);
    }
    expect([...WAF_V2_KINDS].every((kind) => actionPhases[kind]?.join() === "waf-custom")).toBe(
      true,
    );
  });

  it("bans the address for an hour on the request's site by default", () => {
    expect(defaultAction("ban")).toEqual({
      kind: "ban",
      banSeconds: 3600,
      banScope: "site",
      banPrefixV4: 32,
      banPrefixV6: 64,
    });
    expect(RULE_BAN_DURATIONS).toContain(3600);
    // A site's rule cannot ban everywhere; a platform rule can.
    const everywhere = { ...defaultAction("ban"), banScope: "platform" };
    const rule = { name: "r", phase: "waf-custom", expression: "true", action: everywhere };
    expect(siteRuleInput.safeParse(rule).success).toBe(false);
    expect(ruleInput.safeParse(rule).success).toBe(true);
  });

  it("keeps the skip list unique and in the nodes' order", () => {
    expect(toggleSkip(["rules"], "crs", true)).toEqual(["crs", "rules"]);
    expect(toggleSkip(["crs", "rules"], "challenges", true)).toEqual([
      "challenges",
      "crs",
      "rules",
    ]);
    expect(toggleSkip(["crs", "rules"], "crs", true)).toEqual(["crs", "rules"]);
    expect(toggleSkip(["crs", "rules"], "rules", false)).toEqual(["crs"]);
    expect(toggleSkip(["crs"], "crs", false)).toEqual([]);
  });

  it("clears what a custom response's new status no longer allows", () => {
    const page: ActionOf<"respond"> = {
      kind: "respond",
      statusCode: 503,
      contentType: "text/plain",
      body: "",
      errorPage: true,
    };
    expect(withRespondStatus(page, 404).errorPage).toBe(true);
    expect(withRespondStatus(page, 200).errorPage).toBe(false);
    const text = { ...page, errorPage: false, body: "gone" };
    expect(withRespondStatus(text, 204)).toEqual({ ...text, statusCode: 204, body: "" });
    for (const status of [200, 204, 404, 503])
      expect(ruleAction.safeParse(withRespondStatus(page, status)).success, String(status)).toBe(
        true,
      );
  });

  it("leaves the waf-v2 fields out when they are off, as rules saved before them", () => {
    const limit = defaultAction("rate_limit") as ActionOf<"rate_limit">;
    expect(withRateLimitBan(limit, 600)).toEqual({ ...limit, banSeconds: 600 });
    expect("banSeconds" in withRateLimitBan({ ...limit, banSeconds: 600 }, 0)).toBe(false);
    expect("banSeconds" in withRateLimitBan({ ...limit, banSeconds: 600 }, undefined)).toBe(false);
    expect(ruleAction.safeParse(withRateLimitBan(limit, 30)).success).toBe(false);
    expect(withAccessLog({ kind: "log" }, true)).toEqual({ kind: "log", accessLog: true });
    expect(withAccessLog({ kind: "log", accessLog: true }, false)).toEqual({ kind: "log" });
  });
});
