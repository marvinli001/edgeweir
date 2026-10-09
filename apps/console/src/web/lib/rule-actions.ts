import {
  BAN_DURATIONS,
  RATE_LIMIT_PRESETS,
  type RuleDto,
  type RuleInput,
} from "@edgeweir/contract";
import { RULE_BAN, skipTargets } from "@edgeweir/rule-engine";

export type Action = RuleDto["action"];
export type Kind = Action["kind"];
export type ActionOf<K extends Kind> = Extract<Action, { kind: K }>;
export type SkipTarget = (typeof skipTargets)[number];

/** Custom WAF actions only nodes with waf-v2 run. */
export const WAF_V2_KINDS: ReadonlySet<Kind> = new Set(["ban", "respond", "close", "skip"]);

/** What a new rule of the kind starts with. */
export function defaultAction(kind: Kind): RuleInput["action"] {
  switch (kind) {
    case "block":
      return { kind, statusCode: 403 };
    case "redirect":
      return {
        kind,
        value: "/",
        target: "",
        statusCode: 301,
        preserveQuery: false,
        setQuery: [],
        removeQuery: [],
      };
    case "rewrite":
      return { kind, value: "/", target: "", preserveQuery: true, setQuery: [], removeQuery: [] };
    case "request_header":
      return { kind, header: "x-custom", value: "", expression: "", remove: false };
    case "response_header":
      return { kind, header: "x-custom", value: "", expression: "", remove: false, append: false };
    case "config":
      return { kind, cacheBypass: true };
    case "rate_limit":
      return { kind, ...RATE_LIMIT_PRESETS.standard, key: "ip.src", statusCode: 429 };
    case "challenge":
      return { kind, type: "js" };
    case "origin":
      return { kind, originGroup: "", hostHeader: "", sni: "", port: 0 };
    case "compression":
      return { kind, algorithms: [] };
    // An hour, the address alone (IPv4 /32, IPv6 /64), on the request's site.
    case "ban":
      return {
        kind,
        banSeconds: 3600,
        banScope: "site",
        banPrefixV4: RULE_BAN.prefixV4.max,
        banPrefixV6: RULE_BAN.prefixV6.max,
      };
    case "respond":
      return { kind, statusCode: 403, contentType: "text/plain", body: "", errorPage: false };
    // The rules after it, as allow skips them, but nothing else.
    case "skip":
      return { kind, skip: ["rules"] };
    default:
      return { kind };
  }
}

/** The skip list with `target` on or off, in the canonical order the nodes expect. */
export function toggleSkip(list: readonly SkipTarget[], target: SkipTarget, on: boolean) {
  const next = new Set(list);
  if (on) next.add(target);
  else next.delete(target);
  return skipTargets.filter((t) => next.has(t));
}

/**
 * A custom response with another status: error pages are for 4xx and 5xx only, and 204 has no
 * body, so what the status no longer allows is cleared.
 */
export function withRespondStatus(a: ActionOf<"respond">, statusCode: number): ActionOf<"respond"> {
  return {
    ...a,
    statusCode,
    errorPage: a.errorPage && statusCode >= 400,
    body: statusCode === 204 ? "" : a.body,
  };
}

/** A rate limit's ban over the limit: 0 (or nothing) leaves the field out, as rules before it. */
export function withRateLimitBan(
  a: ActionOf<"rate_limit">,
  seconds: number | undefined,
): ActionOf<"rate_limit"> {
  const { banSeconds: _previous, ...rest } = a;
  return seconds ? { ...rest, banSeconds: seconds } : rest;
}

/** A log rule writing (or not) an access log line; off leaves the field out, as rules before it. */
export function withAccessLog(a: ActionOf<"log">, on: boolean): ActionOf<"log"> {
  return on ? { ...a, accessLog: true } : { kind: a.kind };
}

/** Ban durations offered by name (the manual ban's); others are entered in seconds. */
export const RULE_BAN_DURATIONS: readonly number[] = BAN_DURATIONS;
