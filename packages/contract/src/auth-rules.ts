import {
  DEFAULT_SIGN_PARAM,
  DEFAULT_TIME_PARAM,
  URL_AUTH_KEY,
  URL_AUTH_KINDS,
  URL_AUTH_PARAM,
} from "@edgeweir/rule-engine";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { MAX_SITE_DOMAINS, siteDomain } from "./domains";
import { ruleHeaderName } from "./rules";
import {
  analyticsRange,
  expectedUpdatedAt,
  extension,
  isoDateTime,
  pathPrefix,
  uuid,
} from "./schemas";

/**
 * Access authentication of a site (feature access-auth-v1, ADR-0038): up to
 * AUTH_MAX_RULES rules in order; a request is checked by the first enabled
 * rule whose scope it matches, before the rule phases and the cache lookup.
 * Basic password hashes and URL signing keys are write-only: responses tell
 * only that they are set.
 */
export const AUTH_KINDS = ["basic", "forward", ...URL_AUTH_KINDS] as const;
export type AuthKind = (typeof AUTH_KINDS)[number];
export const AUTH_MAX_RULES = 16;
export const AUTH_MAX_PREFIXES = 32;
export const AUTH_MAX_EXTENSIONS = 64;
export const BASIC_MAX_USERS = 100;
export const BASIC_PASSWORD_MIN = 8;
export const BASIC_PASSWORD_MAX = 128;
export const FORWARD_MAX_REQUEST_HEADERS = 16;
export const FORWARD_MAX_RESPONSE_HEADERS = 8;
export const FORWARD_URL_MAX = 2048;
export const FORWARD_TIMEOUT_MS = { min: 100, max: 10_000, default: 5000 } as const;
export const FORWARD_CACHE_SECONDS_MAX = 300;
export const URL_AUTH_VALIDITY = { min: 1, max: 31_536_000, default: 1800 } as const;
export const URL_AUTH_SKEW = { min: 0, max: 600, default: 300 } as const;
/** Request headers forward authentication sends by default. */
export const FORWARD_DEFAULT_REQUEST_HEADERS = ["authorization", "cookie"] as const;
/** Headers nodes add to every forward authentication request (not forwardable). */
export const FORWARD_NODE_HEADERS = [
  "x-original-uri",
  "x-original-method",
  "x-original-host",
  "x-real-ip",
  "x-forwarded-for",
] as const;
export { DEFAULT_SIGN_PARAM, DEFAULT_TIME_PARAM, URL_AUTH_KEY, URL_AUTH_KINDS, URL_AUTH_PARAM };

export const isUrlAuthKind = (kind: AuthKind): kind is (typeof URL_AUTH_KINDS)[number] =>
  (URL_AUTH_KINDS as readonly string[]).includes(kind);

/** Characters a realm, path prefix or password may not contain. */
const hasControl = (value: string) =>
  [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/** Path prefixes count UTF-8 bytes, as nodes compare them. */
const authPathPrefix = pathPrefix
  .refine(
    (value) => !/[?#]/.test(value) && !hasControl(value),
    "no query, fragment or control characters",
  )
  .refine((value) => new TextEncoder().encode(value).length <= 1024, "at most 1024 bytes");

/** Which requests a rule checks; empty lists do not narrow it. */
export const authScope = z.object({
  /** Domains of the site, in their written form (`a.com`, `*.a.com`, `.a.com`, `~pattern`). */
  domains: z.array(siteDomain).max(MAX_SITE_DOMAINS).default([]),
  pathPrefixes: z.array(authPathPrefix).max(AUTH_MAX_PREFIXES).default([]),
  /** Lowercase, without the dot. */
  extensions: z.array(extension).max(AUTH_MAX_EXTENSIONS).default([]),
  excludePathPrefixes: z.array(authPathPrefix).max(AUTH_MAX_PREFIXES).default([]),
});

/** 1-64 printable ASCII characters without ":". */
export const basicUserName = z
  .string()
  .regex(/^[\x21-\x39\x3b-\x7e]{1,64}$/, "1-64 printable ASCII characters without ':'");
/** 8-128 characters (UTF-8 towards nodes), no control characters. */
export const basicPassword = z
  .string()
  .refine(
    (value) =>
      [...value].length >= BASIC_PASSWORD_MIN &&
      [...value].length <= BASIC_PASSWORD_MAX &&
      !hasControl(value),
    `${BASIC_PASSWORD_MIN}-${BASIC_PASSWORD_MAX} characters`,
  );
/** Sent in WWW-Authenticate: 1-64 characters without control characters, `"` or `\`. */
export const basicRealm = z
  .string()
  .trim()
  .refine(
    (value) =>
      [...value].length >= 1 &&
      [...value].length <= 64 &&
      !hasControl(value) &&
      !/["\\]/.test(value),
    "1-64 characters without quotes or backslashes",
  );

/** The default realm of a site: its name without quotes, backslashes or control characters. */
export function defaultRealm(siteName: string): string {
  const cleaned = [...siteName.replace(/["\\]/g, "")]
    .filter((c) => !hasControl(c))
    .slice(0, 64)
    .join("")
    .trim();
  return cleaned || "Restricted";
}

/**
 * An http(s) URL of an authentication service: host name, IPv4 literal or
 * bracketed IPv6 literal, optional port, path and query; no user
 * information, fragment, spaces or backslashes.
 */
const FORWARD_URL =
  /^https?:\/\/(?:(?:[A-Za-z0-9-]+\.)*[A-Za-z0-9-]+|\[[0-9A-Fa-f:.]+\])(?::([0-9]{1,5}))?(?:[/?][\x21-\x22\x24-\x5b\x5d-\x7e]*)?$/;

export function validForwardUrl(value: string): boolean {
  const m = FORWARD_URL.exec(value);
  if (!m) return false;
  if (m[1] !== undefined) {
    const port = Number(m[1]);
    if (port < 1 || port > 65_535) return false;
  }
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** The host of a forward authentication URL (IPv6 without brackets). */
export function forwardUrlHost(value: string): string {
  return new URL(value).hostname.replace(/^\[|\]$/g, "");
}

const forwardRequestHeader = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/, "invalid header name")
  .refine(
    (value) =>
      ![
        "host",
        "connection",
        "upgrade",
        "te",
        "trailer",
        "transfer-encoding",
        "content-length",
        "keep-alive",
        "proxy-connection",
        ...FORWARD_NODE_HEADERS,
      ].includes(value) && !value.startsWith("x-edgeweir-"),
    "this header cannot be forwarded",
  );

export const forwardAuthSettings = z.object({
  url: z.string().trim().max(FORWARD_URL_MAX).refine(validForwardUrl, "invalid http(s) URL"),
  method: z.enum(["GET", "HEAD"]).default("GET"),
  timeoutMs: z
    .number()
    .int()
    .min(FORWARD_TIMEOUT_MS.min)
    .max(FORWARD_TIMEOUT_MS.max)
    .default(FORWARD_TIMEOUT_MS.default),
  /** Visitor's request headers sent to the service. */
  requestHeaders: z
    .array(forwardRequestHeader)
    .max(FORWARD_MAX_REQUEST_HEADERS)
    .default([...FORWARD_DEFAULT_REQUEST_HEADERS]),
  /** Headers of a 2xx answer copied to the request towards the origin. */
  responseHeaders: z.array(ruleHeaderName).max(FORWARD_MAX_RESPONSE_HEADERS).default([]),
  /** 0: off. */
  cacheSeconds: z.number().int().min(0).max(FORWARD_CACHE_SECONDS_MAX).default(0),
  passRedirects: z.boolean().default(false),
  allowUnavailable: z.boolean().default(false),
});

const urlAuthBase = {
  validitySeconds: z
    .number()
    .int()
    .min(URL_AUTH_VALIDITY.min)
    .max(URL_AUTH_VALIDITY.max)
    .default(URL_AUTH_VALIDITY.default),
  skewSeconds: z
    .number()
    .int()
    .min(URL_AUTH_SKEW.min)
    .max(URL_AUTH_SKEW.max)
    .default(URL_AUTH_SKEW.default),
  signParam: z.string().regex(URL_AUTH_PARAM).default(DEFAULT_SIGN_PARAM),
  timeParam: z.string().regex(URL_AUTH_PARAM).default(DEFAULT_TIME_PARAM),
};
export const urlAuthKey = z.string().regex(URL_AUTH_KEY, "16-128 printable ASCII characters");

export const authRuleInput = z
  .object({
    /** An existing rule: its stored passwords and keys are kept where the input leaves them out. */
    id: uuid.optional(),
    kind: z.enum(AUTH_KINDS),
    enabled: z.boolean().default(true),
    scope: authScope.default({
      domains: [],
      pathPrefixes: [],
      extensions: [],
      excludePathPrefixes: [],
    }),
    basic: z
      .object({
        realm: basicRealm,
        keepAuthorization: z.boolean().default(false),
        userHeader: z.boolean().default(false),
        users: z
          .array(z.object({ name: basicUserName, password: basicPassword.optional() }))
          .min(1)
          .max(BASIC_MAX_USERS)
          .refine(
            (users) => new Set(users.map((u) => u.name)).size === users.length,
            "duplicate user",
          ),
      })
      .optional(),
    forward: forwardAuthSettings.optional(),
    url: z
      .object({
        ...urlAuthBase,
        /** Left out: keep the stored primary key (required for a new rule). */
        primaryKey: urlAuthKey.optional(),
        /** Left out: keep; null: remove the backup key. */
        backupKey: urlAuthKey.nullable().optional(),
      })
      .optional(),
  })
  .superRefine((rule, ctx) => {
    const want = rule.kind === "basic" ? "basic" : rule.kind === "forward" ? "forward" : "url";
    for (const part of ["basic", "forward", "url"] as const) {
      if (part === want && !rule[part])
        ctx.addIssue({ code: "custom", path: [part], message: `${rule.kind} rules need ${part}` });
      if (part !== want && rule[part])
        ctx.addIssue({
          code: "custom",
          path: [part],
          message: `${rule.kind} rules take no ${part}`,
        });
    }
    if (rule.kind === "url_d" && rule.url && rule.url.signParam === rule.url.timeParam)
      ctx.addIssue({
        code: "custom",
        path: ["url", "timeParam"],
        message: "the two parameters must differ",
      });
  });

export const authRule = z.object({
  id: uuid,
  kind: z.enum(AUTH_KINDS),
  enabled: z.boolean(),
  scope: z.object({
    domains: z.array(z.string()),
    pathPrefixes: z.array(z.string()),
    extensions: z.array(z.string()),
    excludePathPrefixes: z.array(z.string()),
  }),
  basic: z
    .object({
      realm: z.string(),
      keepAuthorization: z.boolean(),
      userHeader: z.boolean(),
      /** Names only: password hashes never leave the console. */
      users: z.array(z.object({ name: z.string() })),
    })
    .nullable(),
  forward: z
    .object({
      url: z.string(),
      method: z.enum(["GET", "HEAD"]),
      timeoutMs: z.number().int(),
      requestHeaders: z.array(z.string()),
      responseHeaders: z.array(z.string()),
      cacheSeconds: z.number().int(),
      passRedirects: z.boolean(),
      allowUnavailable: z.boolean(),
    })
    .nullable(),
  url: z
    .object({
      validitySeconds: z.number().int(),
      skewSeconds: z.number().int(),
      signParam: z.string(),
      timeParam: z.string(),
      /** Whether a backup key is set (the keys themselves are never returned). */
      backupKey: z.boolean(),
    })
    .nullable(),
});

export const siteAuthRules = z.object({
  siteId: uuid,
  rules: z.array(authRule),
  /** Null until the rules were first saved. */
  updatedAt: isoDateTime.nullable(),
});

export const siteAuthRulesInput = z.object({
  id: uuid,
  rules: z.array(authRuleInput).max(AUTH_MAX_RULES),
  expectedUpdatedAt,
});

/** Signs a URL with a URL rule's primary key, valid for validitySeconds (at most the rule's validity). */
export const signUrlInput = z.object({
  id: uuid,
  ruleId: uuid,
  /** A path ("/...") or an http(s) URL of one of the site's domains. */
  url: z.string().trim().min(1).max(4096),
  validitySeconds: z
    .number()
    .int()
    .min(URL_AUTH_VALIDITY.min)
    .max(URL_AUTH_VALIDITY.max)
    .optional(),
});
export const signedUrl = z.object({
  url: z.string(),
  expiresAt: isoDateTime,
});

/** Requests access authentication refused over a range. */
export const authFailuresInput = z.object({
  id: uuid,
  range: analyticsRange.default("24h"),
});
export const authFailures = z.object({
  requests: z.number(),
  /** Active nodes of the site's cluster that do not count them (no access-auth-v1). */
  unsupportedNodes: z.number().int(),
});

const idParam = z.object({ id: uuid });

/** A site's access authentication rules. */
export const authRulesContract = {
  get: oc
    .route({ method: "GET", path: "/sites/{id}/auth-rules", tags: ["sites"] })
    .input(idParam)
    .output(siteAuthRules),
  /** Replaces the rules; publishes the site's cluster (hot update). */
  update: oc
    .route({ method: "PUT", path: "/sites/{id}/auth-rules", tags: ["sites"] })
    .input(siteAuthRulesInput)
    .output(siteAuthRules),
  /** Computed by the console; nothing is sent to nodes or stored. */
  signUrl: oc
    .route({ method: "POST", path: "/sites/{id}/auth-rules/{ruleId}/sign", tags: ["sites"] })
    .input(signUrlInput)
    .output(signedUrl),
  failures: oc
    .route({ method: "GET", path: "/sites/{id}/auth-rules/failures", tags: ["sites"] })
    .input(authFailuresInput)
    .output(authFailures),
};

export type AuthScope = z.infer<typeof authScope>;
export type AuthRuleInput = z.infer<typeof authRuleInput>;
export type AuthRule = z.infer<typeof authRule>;
export type SiteAuthRules = z.infer<typeof siteAuthRules>;
export type SiteAuthRulesInput = z.infer<typeof siteAuthRulesInput>;
export type ForwardAuthSettings = z.infer<typeof forwardAuthSettings>;
export type SignUrlInput = z.infer<typeof signUrlInput>;
export type SignedUrl = z.infer<typeof signedUrl>;
export type AuthFailures = z.infer<typeof authFailures>;
