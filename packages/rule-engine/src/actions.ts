import { validHostHeader } from "./host-header.ts";
import { validExpressionIr } from "./ir.ts";
import { byteLength } from "./language.ts";
import type { Expression, Phase } from "./model.ts";

/** Challenge types of the `challenge` action and of Under Attack, levels 1 to 4. */
export const challengeTypes = ["cookie302", "js", "pow", "captcha"] as const;
export type ChallengeType = (typeof challengeTypes)[number];
/**
 * Challenges a request can be asked for (challenge-v3): the levels and `managed`, which asks for
 * the pow level and turns interactive (captcha) only for clients the node judges suspicious.
 * CC levels, bans and greylist entries keep the four levels.
 */
export const challengeKinds = [...challengeTypes, "managed"] as const;
/**
 * Contract-only rule actions named after Cloudflare's, compiled to the `challenge` action:
 * managed_challenge asks for `managed`, js_challenge for the non-interactive `pow`.
 */
export const challengeActionKinds = { managed_challenge: "managed", js_challenge: "pow" } as const;

/** Phases each rule action kind may run in. */
export const actionPhases: Record<string, readonly Phase[]> = {
  block: ["waf-custom"],
  log: ["waf-custom"],
  allow: ["waf-custom"],
  challenge: ["waf-custom"],
  // challenge-v3, contract only (challengeActionKinds)
  managed_challenge: ["waf-custom"],
  js_challenge: ["waf-custom"],
  // waf-v2
  ban: ["waf-custom"],
  respond: ["waf-custom"],
  close: ["waf-custom"],
  skip: ["waf-custom"],
  redirect: ["redirect"],
  rewrite: ["request-transform"],
  request_header: ["request-transform", "origin"],
  response_header: ["response-transform"],
  config: ["config", "cache"],
  rate_limit: ["ratelimit"],
  origin: ["origin"],
  compression: ["compression"],
};

/** Keys a rate_limit rule counts by, besides one request header. */
export const rateLimitKeys = ["ip.src", "http.host", "tls.ja4"] as const;
export function isRateLimitKey(key: string): boolean {
  return (
    (rateLimitKeys as readonly string[]).includes(key) ||
    /^http\.request\.headers\.[a-z0-9-]{1,64}$/.test(key)
  );
}

/** A compiled rule action (config.proto RuleAction, JSON field names). */
export interface ActionIr {
  kind: string;
  value?: string;
  header?: string;
  statusCode?: number;
  limit?: number;
  windowSeconds?: number;
  key?: string;
  cacheBypass?: boolean;
  forceHttps?: boolean;
  gzip?: boolean;
  remove?: boolean;
  challenge?: string;
  // rules-v2 (config phase only)
  brotli?: boolean;
  zstd?: boolean;
  websocket?: boolean;
  underAttack?: boolean;
  ccEnabled?: boolean;
  ccMaxLevel?: string;
  originConnectTimeoutMs?: number;
  originSendTimeoutMs?: number;
  originReadTimeoutMs?: number;
  logSampleRate?: number;
  // rules-v2: redirect and rewrite (rules-v3: also request and response header values)
  target?: Expression;
  preserveQuery?: boolean;
  /** rules-v3: `expression` computes a value instead of `value`. */
  setQuery?: { name: string; value: string; expression?: Expression }[];
  removeQuery?: string[];
  // rules-v2: origin
  originGroup?: string;
  hostHeader?: string;
  sni?: string;
  port?: number;
  // rules-v2: compression
  compression?: string[];
  // rules-v3: a response header line added next to the response's own
  append?: boolean;
  // site-content-v1: config (phase config only)
  requestBodyLimit?: bigint | number;
  // waf-v2: ban (also rate_limit: banSeconds), respond, skip, log and config (crs)
  banSeconds?: number;
  banScope?: string;
  banPrefixV4?: number;
  banPrefixV6?: number;
  contentType?: string;
  body?: string;
  errorPage?: boolean;
  skip?: string[];
  accessLog?: boolean;
  crs?: string;
}

/** What a skip action may skip (waf-v2), in canonical order. */
export const skipTargets = ["challenges", "crs", "rate_limits", "rules"] as const;
/** Content types of a custom response (waf-v2). */
export const respondContentTypes = ["text/plain", "text/html", "application/json"] as const;
/** CRS modes a config rule may set for a request (waf-v2). */
export const crsOverrides = ["off", "detect", "block"] as const;
/** Bounds of the ban action and of the rate limit's ban (waf-v2). */
export const RULE_BAN = {
  seconds: { min: 60, max: 604_800 },
  rateLimitSeconds: { min: 60, max: 86_400 },
  prefixV4: { min: 16, max: 32 },
  prefixV6: { min: 48, max: 64 },
} as const;
/** Largest static body of a custom response, in bytes. */
export const MAX_RESPOND_BODY_BYTES = 8192;
/** Whether a status code may be answered by a custom response: 200, 204, 4xx, 5xx. */
export const respondStatus = (status: number) =>
  status === 200 || status === 204 || (status >= 400 && status <= 599);

/** Codings of compression rules and of the config switches, node names. */
export const compressionCodings = ["zstd", "br", "gzip"] as const;
/** Redirect status codes (303 since rules-v3). */
const redirectStatuses = [301, 302, 303, 307, 308] as const;
/** Longest header value a value expression may compute; longer ones skip the header action. */
export const MAX_HEADER_VALUE_BYTES = 4096;
/** Query parameter names redirects and rewrites may set or remove (RFC 3986 unreserved). */
export const QUERY_NAME_RE = /^[A-Za-z0-9._~-]{1,64}$/;
/** Origin groups inside a site; "" is the default group. */
export const ORIGIN_GROUP_RE = /^[a-z0-9_-]{1,32}$/;
const hostnameRe =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

const headerName = /^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/;
const protectedRuleHeaders = new Set([
  "host",
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "content-length",
  "transfer-encoding",
  "connection",
  "upgrade",
  "te",
  "trailer",
  "cdn-loop",
]);
const ruleHeader = (name: string) =>
  headerName.test(name) && !protectedRuleHeaders.has(name) && !name.startsWith("x-edgeweir-");

/** Whether `value` is a static redirect target nodes accept. */
export function validRedirectTarget(value: string): boolean {
  let absolute = false;
  try {
    const url = new URL(value);
    absolute = ["http:", "https:"].includes(url.protocol) && !!url.hostname && !url.username;
  } catch {}
  const local = value.startsWith("/") && !value.startsWith("//") && !value.includes("\\");
  return local || absolute;
}

/** Fields each action kind may carry besides `kind` (everything else must stay empty). */
const actionFields: Record<string, readonly (keyof ActionIr)[]> = {
  block: ["statusCode"],
  log: ["accessLog"],
  allow: [],
  challenge: ["challenge"],
  ban: ["banSeconds", "banScope", "banPrefixV4", "banPrefixV6"],
  respond: ["statusCode", "contentType", "body", "errorPage"],
  close: [],
  skip: ["skip"],
  redirect: ["value", "statusCode", "target", "preserveQuery", "setQuery", "removeQuery"],
  rewrite: ["value", "target", "preserveQuery", "setQuery", "removeQuery"],
  request_header: ["header", "value", "remove", "target"],
  response_header: ["header", "value", "remove", "target", "append"],
  config: [
    "cacheBypass",
    "forceHttps",
    "gzip",
    "brotli",
    "zstd",
    "websocket",
    "underAttack",
    "ccEnabled",
    "ccMaxLevel",
    "originConnectTimeoutMs",
    "originSendTimeoutMs",
    "originReadTimeoutMs",
    "logSampleRate",
    "requestBodyLimit",
    "crs",
  ],
  rate_limit: ["statusCode", "limit", "windowSeconds", "key", "banSeconds"],
  origin: ["originGroup", "hostHeader", "sni", "port"],
  compression: ["compression"],
};
const configV2Fields: readonly (keyof ActionIr)[] = [
  "brotli",
  "zstd",
  "websocket",
  "underAttack",
  "ccEnabled",
  "ccMaxLevel",
  "originConnectTimeoutMs",
  "originSendTimeoutMs",
  "originReadTimeoutMs",
  "logSampleRate",
];
const isSet = (value: unknown) =>
  value !== undefined &&
  value !== null &&
  value !== "" &&
  value !== 0 &&
  !(Array.isArray(value) && value.length === 0);

function validQueryEdits(action: ActionIr, phase: string): boolean {
  const set = action.setQuery ?? [];
  const remove = action.removeQuery ?? [];
  if (set.length > 16 || remove.length > 16) return false;
  const names = set.map((p) => p.name);
  const sortedUnique = (list: string[]) =>
    list.every((name, i) => QUERY_NAME_RE.test(name) && (i === 0 || (list[i - 1] ?? "") < name));
  return (
    sortedUnique(names) &&
    sortedUnique(remove) &&
    !names.some((name) => remove.includes(name)) &&
    set.every(
      (p) =>
        p.value.length <= 256 &&
        /^[\x20-\x7e]*$/.test(p.value) &&
        (!p.expression || (p.value === "" && validExpressionIr(p.expression, phase, true))),
    )
  );
}

/** Whether a custom response body is valid: at most 8192 bytes, no control characters but tab and newlines. */
export const validRespondBody = (body: string) =>
  byteLength(body) <= MAX_RESPOND_BODY_BYTES &&
  ![...body].some((c) => {
    const code = c.charCodeAt(0);
    return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
  });

/**
 * Whether a compiled action is valid in `phase`, as the node validates it
 * (edgeweir-node configir/rules.go); `platform` for platform rules (only they
 * may ban at platform scope). The console validates its own input with the
 * stricter ruleAction schema of @edgeweir/contract.
 */
export function validActionIr(phase: string, action: ActionIr, platform = false): boolean {
  if (action.kind in challengeActionKinds) return false;
  if (!(actionPhases[action.kind] as readonly string[] | undefined)?.includes(phase)) return false;
  const allowed = actionFields[action.kind] ?? [];
  for (const [field, value] of Object.entries(action))
    if (field !== "kind" && isSet(value) && !allowed.includes(field as keyof ActionIr)) {
      // `false` booleans are values too; only the kind's own fields may be present.
      return false;
    }
  for (const [field, value] of Object.entries(action))
    if (field !== "kind" && value === false && !allowed.includes(field as keyof ActionIr))
      return false;
  const value = action.value ?? "";
  if (
    value.length > 4096 ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return false;
  const status = action.statusCode ?? 0;
  switch (action.kind) {
    case "block":
      return status === 403 || status === 451;
    case "log":
    case "allow":
    case "close":
      return true;
    case "ban": {
      const seconds = action.banSeconds ?? 0;
      const v4 = action.banPrefixV4 ?? 0;
      const v6 = action.banPrefixV6 ?? 0;
      const scope = action.banScope ?? "";
      return (
        Number.isInteger(seconds) &&
        seconds >= RULE_BAN.seconds.min &&
        seconds <= RULE_BAN.seconds.max &&
        (scope === "" || (scope === "platform" && platform)) &&
        Number.isInteger(v4) &&
        (v4 === 0 || (v4 >= RULE_BAN.prefixV4.min && v4 <= RULE_BAN.prefixV4.max)) &&
        Number.isInteger(v6) &&
        (v6 === 0 || (v6 >= RULE_BAN.prefixV6.min && v6 <= RULE_BAN.prefixV6.max))
      );
    }
    case "respond": {
      const body = action.body ?? "";
      const type = action.contentType ?? "";
      if (!Number.isInteger(status) || !respondStatus(status)) return false;
      if (action.errorPage) return status >= 400 && type === "" && body === "";
      return (
        (respondContentTypes as readonly string[]).includes(type) &&
        validRespondBody(body) &&
        (status !== 204 || body === "")
      );
    }
    case "skip": {
      const list = action.skip ?? [];
      return (
        list.length > 0 &&
        list.every(
          (item, i) =>
            (skipTargets as readonly string[]).includes(item) &&
            (i === 0 || (list[i - 1] ?? "") < item),
        )
      );
    }
    case "challenge":
      return (challengeKinds as readonly string[]).includes(action.challenge ?? "");
    case "redirect": {
      if (
        !validQueryEdits(action, phase) ||
        !(redirectStatuses as readonly number[]).includes(status)
      )
        return false;
      if (action.target) return value === "" && validExpressionIr(action.target, phase, true);
      return validRedirectTarget(value);
    }
    case "rewrite":
      if (!validQueryEdits(action, phase)) return false;
      if (action.target) return value === "" && validExpressionIr(action.target, phase, true);
      return value.startsWith("/") && !value.startsWith("//") && !/[?\\#]/.test(value);
    case "request_header":
    case "response_header":
      // A computed value (rules-v3) replaces the static one; neither goes with remove.
      if (
        action.target &&
        (action.remove || value !== "" || !validExpressionIr(action.target, phase, true))
      )
        return false;
      return ruleHeader(action.header ?? "") && !(action.append && action.remove);
    case "config": {
      if (phase !== "config" && configV2Fields.some((field) => action[field] !== undefined))
        return false;
      const crs = action.crs ?? "";
      if (crs !== "" && (phase !== "config" || !(crsOverrides as readonly string[]).includes(crs)))
        return false;
      if (phase !== "config" && action.requestBodyLimit !== undefined) return false;
      const level = action.ccMaxLevel ?? "";
      const timeout = (ms: number | undefined, max: number) =>
        ms === undefined || ms === 0 || (Number.isInteger(ms) && ms >= 100 && ms <= max);
      const rate = action.logSampleRate;
      return (
        (level === "" || (challengeTypes as readonly string[]).includes(level)) &&
        timeout(action.originConnectTimeoutMs, 120_000) &&
        timeout(action.originSendTimeoutMs, 3_600_000) &&
        timeout(action.originReadTimeoutMs, 3_600_000) &&
        (rate === undefined || (Number.isInteger(rate) && rate >= 0 && rate <= 10000)) &&
        (action.cacheBypass !== undefined ||
          action.forceHttps !== undefined ||
          action.gzip !== undefined ||
          action.requestBodyLimit !== undefined ||
          crs !== "" ||
          configV2Fields.some(
            (field) =>
              action[field] !== undefined &&
              !(field === "ccMaxLevel" && action[field] === "") &&
              !(field.endsWith("TimeoutMs") && action[field] === 0),
          ))
      );
    }
    case "origin": {
      const group = action.originGroup ?? "";
      const host = action.hostHeader ?? "";
      const sni = action.sni ?? "";
      const port = action.port ?? 0;
      return (
        (group === "" || ORIGIN_GROUP_RE.test(group)) &&
        (host === "" || validHostHeader(host)) &&
        (sni === "" || hostnameRe.test(sni)) &&
        Number.isInteger(port) &&
        port >= 0 &&
        port <= 65535 &&
        (group !== "" || host !== "" || sni !== "" || port !== 0)
      );
    }
    case "compression": {
      const list = action.compression ?? [];
      return (
        new Set(list).size === list.length &&
        list.every((c) => (compressionCodings as readonly string[]).includes(c))
      );
    }
    case "rate_limit": {
      const limit = action.limit ?? 0;
      const window = action.windowSeconds ?? 0;
      const ban = action.banSeconds ?? 0;
      return (
        (status === 403 || status === 429) &&
        limit >= 1 &&
        limit <= 100000 &&
        window >= 1 &&
        window <= 3600 &&
        isRateLimitKey(action.key ?? "") &&
        Number.isInteger(ban) &&
        (ban === 0 ||
          (ban >= RULE_BAN.rateLimitSeconds.min && ban <= RULE_BAN.rateLimitSeconds.max))
      );
    }
  }
  return false;
}
