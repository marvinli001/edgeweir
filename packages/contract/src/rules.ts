import {
  actionPhases,
  canonicalCidr,
  challengeTypes,
  compressionCodings,
  expressionErrorCodes,
  isRateLimitKey,
  MAX_HOST_HEADER_LENGTH,
  ORIGIN_GROUP_RE,
  parseExpression,
  parseValueExpression,
  phases,
  QUERY_NAME_RE,
} from "@edgeweir/rule-engine";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { addExpressionIssue, expressionKinds } from "./expressions";
import type { PresetLevel } from "./protection";
import { analyticsRange, optionalHostname, uuid } from "./schemas";

const text = z
  .string()
  .max(4096)
  .refine((s) => ![...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127));
const protectedHeaders = new Set([
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
export const ruleHeaderName = z
  .string()
  .toLowerCase()
  .regex(/^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/)
  .refine((s) => !protectedHeaders.has(s) && !s.startsWith("x-edgeweir-"));
/**
 * A static redirect target: a local path with a single leading "/" or an
 * absolute http(s) URL without credentials, whitespace or backslashes.
 */
export function staticRedirectTarget(s: string): boolean {
  return (
    !s.includes("\\") &&
    ![...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
    ((s.startsWith("/") && !s.startsWith("//")) ||
      (() => {
        try {
          const url = new URL(s);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            !!url.hostname &&
            !url.username &&
            !url.password &&
            !/\s/.test(s)
          );
        } catch {
          return false;
        }
      })())
  );
}
/** A static rewrite path: a single leading "/", no query, fragment or backslash. */
const staticRewritePath = (s: string) =>
  s.startsWith("/") && !s.startsWith("//") && !/[?\\#]/.test(s);

export const redirectStatusCode = z
  .union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)])
  .default(301);
/** A query parameter a redirect or rewrite sets (the node percent-encodes the value). */
export const queryParam = z.object({
  name: z.string().regex(QUERY_NAME_RE),
  /** Printable ASCII, at most 256 characters. */
  value: z
    .string()
    .max(256)
    .regex(/^[\x20-\x7e]*$/),
});
/** Query string edits of redirects and rewrites (rules-v2). */
const queryEdits = {
  /** Value expression computed per request instead of `value` (exactly one of both is set). */
  target: z.string().max(4096).default(""),
  /** Set after removing parameters of the same name, at most 16, names unique. */
  setQuery: z.array(queryParam).max(16).default([]),
  /** Parameter names removed, at most 16. */
  removeQuery: z.array(z.string().regex(QUERY_NAME_RE)).max(16).default([]),
};
type QueryEdits = {
  value: string;
  target: string;
  setQuery: { name: string }[];
  removeQuery: string[];
};
/** One of value and target, set names unique and never also removed, a valid static value. */
const checkQueryEdits =
  (validValue: (value: string) => boolean) => (a: QueryEdits, ctx: z.RefinementCtx) => {
    if ((a.value === "") === (a.target === ""))
      ctx.addIssue({
        code: "custom",
        message: "set exactly one of value and target",
        path: ["value"],
      });
    if (a.value !== "" && !validValue(a.value))
      ctx.addIssue({ code: "custom", message: "invalid value", path: ["value"] });
    const names = a.setQuery.map((param) => param.name);
    if (new Set(names).size !== names.length)
      ctx.addIssue({ code: "custom", message: "a parameter is set twice", path: ["setQuery"] });
    if (names.some((name) => a.removeQuery.includes(name)))
      ctx.addIssue({
        code: "custom",
        message: "a parameter is both set and removed",
        path: ["removeQuery"],
      });
  };

/** Config action fields that only the config phase accepts (rules-v2). */
export const configPhaseFields = [
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
] as const;

export const ruleAction = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("block"),
    statusCode: z.union([z.literal(403), z.literal(451)]).default(403),
  }),
  z.object({ kind: z.literal("log") }),
  z.object({ kind: z.literal("allow") }),
  /** Challenges requests without a pass of this type's level or higher. */
  z.object({ kind: z.literal("challenge"), type: z.enum(challengeTypes).default("js") }),
  z
    .object({
      kind: z.literal("redirect"),
      /** Static target; empty when `target` computes it. */
      value: text.default(""),
      ...queryEdits,
      statusCode: redirectStatusCode,
      /** Append the request's query string to the target. */
      preserveQuery: z.boolean().default(false),
    })
    .superRefine(checkQueryEdits(staticRedirectTarget)),
  z
    .object({
      kind: z.literal("rewrite"),
      /** Static path; empty when `target` computes it. */
      value: text.default(""),
      ...queryEdits,
      /** Keep the request's query string; false clears it before the edits. */
      preserveQuery: z.boolean().default(true),
    })
    .superRefine(checkQueryEdits(staticRewritePath)),
  z.object({
    kind: z.literal("request_header"),
    header: ruleHeaderName,
    value: text.default(""),
    remove: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("response_header"),
    header: ruleHeaderName,
    value: text.default(""),
    remove: z.boolean().default(false),
  }),
  /**
   * Overrides site settings for the requests it matches; later matching
   * rules override field by field. The phase cache accepts only cacheBypass,
   * forceHttps and gzip.
   */
  z
    .object({
      kind: z.literal("config"),
      cacheBypass: z.boolean().optional(),
      forceHttps: z.boolean().optional(),
      /** Compression switches among the codings the site enables. */
      gzip: z.boolean().optional(),
      brotli: z.boolean().optional(),
      zstd: z.boolean().optional(),
      websocket: z.boolean().optional(),
      /** The site's Under Attack (platform Under Attack is unaffected). */
      underAttack: z.boolean().optional(),
      /** CC escalation and its highest level; requests are counted either way. */
      ccEnabled: z.boolean().optional(),
      ccMaxLevel: z.enum(challengeTypes).optional(),
      /** Origin timeouts in milliseconds. */
      originConnectTimeoutMs: z.number().int().min(100).max(120_000).optional(),
      originSendTimeoutMs: z.number().int().min(100).max(3_600_000).optional(),
      originReadTimeoutMs: z.number().int().min(100).max(3_600_000).optional(),
      /** Sampled access log rate in basis points (0 stops sampling). */
      logSampleRate: z.number().int().min(0).max(10_000).optional(),
    })
    .refine(
      (a) =>
        a.cacheBypass !== undefined ||
        a.forceHttps !== undefined ||
        a.gzip !== undefined ||
        configPhaseFields.some((field) => a[field] !== undefined),
      { message: "set at least one setting" },
    ),
  /**
   * Origin rules (phase origin): the site's origin group to use (empty keeps
   * the default group), the Host header and TLS SNI sent upstream and the
   * port of every origin of the group (0 keeps theirs).
   */
  z
    .object({
      kind: z.literal("origin"),
      originGroup: z
        .string()
        .refine((s) => s === "" || ORIGIN_GROUP_RE.test(s), "invalid origin group")
        .default(""),
      /**
       * Checked like an origin's Host header (ORIGIN_HOST_HEADER_INVALID). ASCII letters are
       * lowercased, which keeps the value valid or invalid as it was.
       */
      hostHeader: z
        .string()
        .trim()
        .overwrite((value) => value.replace(/[A-Z]+/g, (letters) => letters.toLowerCase()))
        .max(MAX_HOST_HEADER_LENGTH)
        .default(""),
      sni: optionalHostname.default(""),
      port: z.number().int().min(0).max(65535).default(0),
    })
    .refine((a) => a.originGroup !== "" || a.hostHeader !== "" || a.sni !== "" || a.port !== 0, {
      message: "set at least one override",
    }),
  /**
   * Compression rules (phase compression): the codings this response may
   * use in preference order, among those the site enables; empty disables
   * compression.
   */
  z.object({
    kind: z.literal("compression"),
    algorithms: z
      .array(z.enum(compressionCodings))
      .max(compressionCodings.length)
      .refine((list) => new Set(list).size === list.length, "codings must be unique"),
  }),
  z.object({
    kind: z.literal("rate_limit"),
    statusCode: z.union([z.literal(403), z.literal(429)]).default(429),
    limit: z.number().int().min(1).max(100000),
    windowSeconds: z.number().int().min(1).max(3600),
    /** ip.src, http.host, tls.ja4 or http.request.headers.<name>. */
    key: z.string().refine(isRateLimitKey).default("ip.src"),
  }),
]);
/** The rate of a rate_limit rule a preset sets; the key and status stay the rule's own. */
export interface RateLimitPreset {
  limit: number;
  windowSeconds: number;
}
/**
 * Rate limit presets, requests per key (usually an address) per minute. Standard is what a new
 * rule starts with; loose allows bursts of pages with many assets or many users behind one NAT
 * (5 per second); strict suits logins, sign-ups and APIs (one request every 3 seconds).
 */
export const RATE_LIMIT_PRESETS: Record<PresetLevel, RateLimitPreset> = {
  loose: { limit: 300, windowSeconds: 60 },
  standard: { limit: 100, windowSeconds: 60 },
  strict: { limit: 20, windowSeconds: 60 },
};

export const ruleInput = z
  .object({
    id: uuid.optional(),
    name: z.string().trim().min(1).max(100),
    phase: z.enum(phases),
    expression: z.string().min(1).max(4096),
    /** Off unless set: a new rule matching more than intended would act on every request. */
    enabled: z.boolean().default(false),
    action: ruleAction,
  })
  .superRefine((rule, ctx) => {
    const action = rule.action;
    if (!actionPhases[action.kind]?.includes(rule.phase))
      ctx.addIssue({
        code: "custom",
        message: "action is unavailable in this phase",
        path: ["action"],
      });
    if (
      action.kind === "config" &&
      rule.phase !== "config" &&
      configPhaseFields.some((field) => action[field] !== undefined)
    )
      ctx.addIssue({
        code: "custom",
        message: "this setting is only available in the config phase",
        path: ["action"],
      });
    try {
      parseExpression(rule.expression, rule.phase);
    } catch (error) {
      addExpressionIssue(ctx, error, ["expression"]);
    }
    if ((action.kind === "redirect" || action.kind === "rewrite") && action.target !== "")
      try {
        parseValueExpression(action.target, rule.phase);
      } catch (error) {
        addExpressionIssue(ctx, error, ["action", "target"]);
      }
  });
export const ruleDto = ruleInput.safeExtend({ id: uuid });
/** Most-matched log rules of a site over a range (approximate, bounded per minute). */
export const loggedRulesInput = z.object({
  id: uuid,
  range: analyticsRange.default("24h"),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export const loggedRules = z.object({
  approximate: z.literal(true),
  items: z.array(
    z.object({
      ruleId: uuid,
      /** The rule's current name; null once it is deleted. */
      name: z.string().nullable(),
      /** A platform rule (it applies to every site). */
      platform: z.boolean(),
      requests: z.number(),
    }),
  ),
  /** Active nodes of the site's cluster that do not count matches (no rule-log-v1). */
  unsupportedNodes: z.number().int(),
});
export const rulesContract = {
  get: oc
    .route({ method: "GET", path: "/sites/{id}/rules", tags: ["rules"] })
    .input(z.object({ id: uuid }))
    .output(z.array(ruleDto)),
  save: oc
    .route({ method: "PUT", path: "/sites/{id}/rules", tags: ["rules"] })
    .input(z.object({ id: uuid, rules: z.array(ruleInput).max(64) }))
    .output(z.array(ruleDto)),
  /**
   * Requests that matched the site's rules with the log action (and platform
   * rules with it) per rule, heaviest first.
   */
  topLogged: oc
    .route({ method: "GET", path: "/sites/{id}/rules/logged", tags: ["rules"] })
    .input(loggedRulesInput)
    .output(loggedRules),
  /**
   * Checks an expression: a rule condition of `phase` (kind condition), a
   * redirect target or rewrite path of `phase` (kind value) or a cache rule
   * condition (kind cacheRule, at most 16384 characters, phase ignored).
   */
  validate: oc
    .route({ method: "POST", path: "/rules/validate", tags: ["rules"] })
    .input(
      z.object({
        expression: z.string().max(16384),
        phase: z.enum(phases),
        kind: z.enum(expressionKinds).default("condition"),
      }),
    )
    .output(
      z.object({
        valid: z.boolean(),
        /** Where an invalid expression fails (a character offset), 0 when valid. */
        position: z.number().int(),
        /** Why it fails, in English; empty when valid. */
        message: z.string(),
        /** Why it fails as a stable code with the values its text names (invalid only). */
        code: z.enum(expressionErrorCodes).optional(),
        params: z.record(z.string(), z.string()).optional(),
      }),
    ),
};
export const platformRulesContract = {
  get: oc
    .route({ method: "GET", path: "/platform-rules", tags: ["rules"] })
    .output(z.array(ruleDto)),
  save: oc
    .route({ method: "PUT", path: "/platform-rules", tags: ["rules"] })
    .input(z.object({ rules: z.array(ruleInput).max(32) }))
    .output(z.array(ruleDto)),
};
const entries = z
  .array(z.string().max(64))
  .max(10000)
  .transform((values, ctx) => {
    try {
      return [...new Set(values.map(canonicalCidr))].sort();
    } catch {
      ctx.addIssue({ code: "custom", message: "invalid IP/CIDR" });
      return z.NEVER;
    }
  });
export const ipListInput = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/),
  entries,
  kind: z.enum(["collection", "allow", "block"]).default("collection"),
});
export const ipListDto = z.object({
  id: uuid,
  name: z.string(),
  entries: z.array(z.string()),
  kind: z.enum(["collection", "allow", "block"]),
});
/** IP lists: collections rules refer to, and allow and block lists that apply to every site. */
export const ipListsContract = {
  list: oc.route({ method: "GET", path: "/ip-lists", tags: ["rules"] }).output(z.array(ipListDto)),
  create: oc
    .route({ method: "POST", path: "/ip-lists", tags: ["rules"] })
    .input(ipListInput)
    .output(ipListDto),
  update: oc
    .route({ method: "PUT", path: "/ip-lists/{id}", tags: ["rules"] })
    .input(z.object({ id: uuid, entries, kind: z.enum(["collection", "allow", "block"]) }))
    .output(ipListDto),
  delete: oc
    .route({ method: "DELETE", path: "/ip-lists/{id}", tags: ["rules"] })
    .input(z.object({ id: uuid }))
    .output(z.object({ ok: z.literal(true) })),
};
export type RuleInput = z.infer<typeof ruleInput>;
export type RuleDto = z.infer<typeof ruleDto>;
export type IpListInput = z.infer<typeof ipListInput>;
export type IpListDto = z.infer<typeof ipListDto>;
export type LoggedRules = z.infer<typeof loggedRules>;
