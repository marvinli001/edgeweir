import { oc } from "@orpc/contract";
import * as z from "zod";
import type { PresetLevel } from "./protection";
import { analyticsRange, isoDateTime, uuid } from "./schemas";

/**
 * OWASP Core Rule Set (CRS) managed rules of a site, run by the ModSecurity
 * module bundled with the nodes (feature modsecurity-v1). Off by default.
 */
export const WAF_MODES = ["off", "detect", "block"] as const;
export const wafMode = z.enum(WAF_MODES);
export const WAF_PARANOIA_RANGE = { min: 1, max: 4 } as const;
/** Inbound anomaly score at which a request counts as an attack (CRS default 5). */
export const WAF_ANOMALY_THRESHOLD_RANGE = { min: 1, max: 1000 } as const;
/** Request body bytes inspected (128 MiB at most); 0 inspects no body. */
export const WAF_BODY_LIMIT_RANGE = { min: 0, max: 134_217_728 } as const;
/** CRS rule ids (the CRS reserves 900000 to 999999). */
export const WAF_RULE_ID_RANGE = { min: 900_000, max: 999_999 } as const;
/** Rule ids of one exclusion entry. */
export const WAF_MAX_EXCLUSIONS = 200;
/** Exclusion entries of a site (waf-v2: by path or target). */
export const WAF_MAX_EXCLUSION_ENTRIES = 100;
/** Targets of one exclusion entry. */
export const WAF_MAX_EXCLUSION_TARGETS = 16;

export const wafRuleId = z.number().int().min(WAF_RULE_ID_RANGE.min).max(WAF_RULE_ID_RANGE.max);

/**
 * CRS rule files whose rules set up or evaluate the detection rules instead
 * of detecting anything: 901 initialization, 949 and 959 blocking evaluation
 * (949110 is the rule that blocks once the anomaly score is reached), 980
 * correlation. Removing one breaks the CRS or turns blocking off for the
 * site, so they cannot be excluded, and match counts leave them out.
 */
export const CRS_EVALUATION_FILES = [901, 949, 959, 980] as const;

/** Whether a CRS rule detects something: only those can be excluded for a site. */
export const crsDetectionRule = (id: number) =>
  !(CRS_EVALUATION_FILES as readonly number[]).includes(Math.floor(id / 1000));

/** Rule ids of an exclusion: unique, stored in ascending order. */
export const wafExcludedRuleIds = z
  .array(wafRuleId)
  .min(1)
  .max(WAF_MAX_EXCLUSIONS)
  .refine((ids) => new Set(ids).size === ids.length, { message: "rule ids must be unique" });

/** A target a CRS rule stops inspecting: ARGS, REQUEST_COOKIES or REQUEST_HEADERS by name. */
export const WAF_TARGET_RE =
  /^(?:(?:ARGS|REQUEST_COOKIES):[A-Za-z0-9_.\-[\]]{1,64}|REQUEST_HEADERS:[A-Za-z0-9-]{1,64})$/;
/**
 * A path of an exclusion: empty (the whole site) or starting with "/", at most 1024 bytes,
 * without "?", "#", whitespace or control characters (the node judges the normalized path).
 */
export function validWafExclusionPath(path: string): boolean {
  if (path === "") return true;
  if (!path.startsWith("/") || new TextEncoder().encode(path).length > 1024) return false;
  return ![...path].some((c) => {
    const code = c.charCodeAt(0);
    return code <= 32 || code === 127 || c === "?" || c === "#" || /\s/.test(c);
  });
}

/**
 * A CRS exclusion: the rules do not run (or, with targets, do not inspect those targets) for
 * the requests of the path (exact or as a prefix of the client's normalized path; empty: every
 * path). Targets need waf-v2; so do paths.
 */
export const wafExclusion = z.object({
  path: z
    .string()
    .refine(validWafExclusionPath, { message: "a path starting with / without ?, # or spaces" })
    .default(""),
  exact: z.boolean().default(false),
  ruleIds: wafExcludedRuleIds,
  targets: z
    .array(z.string().regex(WAF_TARGET_RE))
    .max(WAF_MAX_EXCLUSION_TARGETS)
    .refine((list) => new Set(list).size === list.length, { message: "targets must be unique" })
    .default([]),
});
export const wafExclusions = z.array(wafExclusion).max(WAF_MAX_EXCLUSION_ENTRIES);

export const WAF_DEFAULTS = {
  mode: "off",
  paranoiaLevel: 1,
  anomalyThreshold: 5,
  exclusions: [] as WafExclusion[],
  requestBodyLimit: 131_072,
} as const satisfies Omit<SiteWaf, "siteId" | "updatedAt">;

/** The CRS settings a preset sets; mode and exclusions stay the site's own. */
export interface WafPreset {
  paranoiaLevel: number;
  anomalyThreshold: number;
  requestBodyLimit: number;
}
/**
 * CRS presets. Loose blocks from an anomaly score of 10 (two critical matches instead of one)
 * and inspects 64 KiB of the body; strict runs paranoia level 2 (more rules, more false
 * positives) and inspects 1 MiB.
 */
export const WAF_PRESETS: Record<PresetLevel, WafPreset> = {
  loose: { paranoiaLevel: 1, anomalyThreshold: 10, requestBodyLimit: 65_536 },
  standard: {
    paranoiaLevel: WAF_DEFAULTS.paranoiaLevel,
    anomalyThreshold: WAF_DEFAULTS.anomalyThreshold,
    requestBodyLimit: WAF_DEFAULTS.requestBodyLimit,
  },
  strict: { paranoiaLevel: 2, anomalyThreshold: 5, requestBodyLimit: 1_048_576 },
};

export const siteWaf = z.object({
  siteId: uuid,
  /** off, detect (log matches only) or block (answer 403 above the threshold). */
  mode: wafMode,
  paranoiaLevel: z.number().int(),
  anomalyThreshold: z.number().int(),
  /** Exclusions in the site's order. */
  exclusions: z.array(
    z.object({
      path: z.string(),
      exact: z.boolean(),
      ruleIds: z.array(z.number().int()),
      targets: z.array(z.string()),
    }),
  ),
  requestBodyLimit: z.number().int(),
  updatedAt: isoDateTime.nullable(),
});

/** Changes only the fields given. */
export const siteWafUpdateInput = z.object({
  id: uuid,
  mode: wafMode.optional(),
  paranoiaLevel: z
    .number()
    .int()
    .min(WAF_PARANOIA_RANGE.min)
    .max(WAF_PARANOIA_RANGE.max)
    .optional(),
  anomalyThreshold: z
    .number()
    .int()
    .min(WAF_ANOMALY_THRESHOLD_RANGE.min)
    .max(WAF_ANOMALY_THRESHOLD_RANGE.max)
    .optional(),
  /** Replaces every exclusion. */
  exclusions: wafExclusions.optional(),
  requestBodyLimit: z
    .number()
    .int()
    .min(WAF_BODY_LIMIT_RANGE.min)
    .max(WAF_BODY_LIMIT_RANGE.max)
    .optional(),
});

/** Most-matched CRS rules of a site over a range (approximate, bounded per minute). */
export const wafTopRulesInput = z.object({
  id: uuid,
  range: analyticsRange.default("24h"),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});
export const wafTopRules = z.object({
  approximate: z.literal(true),
  items: z.array(z.object({ ruleId: z.number().int(), requests: z.number() })),
});

/**
 * Whether a feature can be turned on for a site now: `nodes` when an active
 * node of the site's cluster lacks it (it may still be required through the
 * API, which holds the cluster until its nodes are upgraded).
 */
export const featureAvailability = z.object({
  available: z.boolean(),
  reason: z.enum(["nodes"]).nullable(),
});

export const siteFeatures = z.object({
  brotli: featureAvailability,
  zstd: featureAvailability,
  crs: featureAvailability,
  /** originSettings.activeHealthCheck (active-health-v1). */
  activeHealthCheck: featureAvailability,
  /** originSettings.sessionAffinity (session-affinity-v1 and challenge-v1). */
  sessionAffinity: featureAvailability,
  /** originSettings.protocol http2 and grpc (origin-http2-v1). */
  originHttp2: featureAvailability,
  /** The site's error pages (error-pages-v1). */
  errorPages: featureAvailability,
  /** Cache tasks of type host and tag (purge-tag-v1). */
  purgeByTag: featureAvailability,
  /** Prefetching the mobile variant and sitemap tasks (prefetch-v2). */
  prefetchVariants: featureAvailability,
  /**
   * The rule engine extensions (rules-v2): functions and the new fields,
   * dynamic redirects and rewrites, origin, compression and the new config
   * actions, cache rule expressions that are not in the builder's shape and
   * browser TTLs, bulk redirects and origin groups.
   */
  rulesV2: featureAvailability,
  /**
   * The rule engine additions (rules-v3): the new fields, functions and wildcard comparisons,
   * header values and query parameters computed per request, response header lines, redirect
   * status 303 and the error page placeholders {{time}} and {{path}}.
   */
  rulesV3: featureAvailability,
  /** Ports besides 80 and 443 and the HTTPS redirect's status, port and excluded domains (edge-ports-v1). */
  edgePorts: featureAvailability,
  /** The rule field ip.peer (client-ip-v1). */
  clientIp: featureAvailability,
  /**
   * The site settings of proto v0.24.0 (site-content-v1): cache keys that drop
   * parameters, caching responses with Set-Cookie, the PURGE method, hiding
   * X-Cache, error pages for more statuses, classes and redirects,
   * maintenance, charsets, the gzip level and the largest compressed response,
   * request body limits and origin tries.
   */
  siteContent: featureAvailability,
  /** Domains of the forms `.a.com` and `~pattern` (domains-v2). */
  domainsV2: featureAvailability,
  /** More than one certificate (multi-certificate-v1). */
  multiCertificate: featureAvailability,
  /** Client certificates and the tls.client.* fields (client-cert-v1). */
  clientCertificate: featureAvailability,
  /** Access authentication rules (access-auth-v1). */
  accessAuth: featureAvailability,
  /** Access control (access-control-v1). */
  accessControl: featureAvailability,
  /**
   * The custom WAF actions ban, respond, close and skip, access log lines from log rules, rate
   * limit bans, the config rules' CRS override and CRS exclusions by path or target (waf-v2).
   */
  wafV2: featureAvailability,
  /** Request body fields and form_value / json_value in rules (rules-body-v1). */
  rulesBody: featureAvailability,
  /**
   * Verified crawlers (allowVerifiedBots, http.request.bot.*), challenge page texts and
   * challenge failure bans (challenge-v2).
   */
  challengeV2: featureAvailability,
  /**
   * The site's access log options: always logging blocked requests, the query string, request
   * headers and the peer address (access-logs-v2).
   */
  accessLogsV2: featureAvailability,
  /** WebP / AVIF conversion of cached images (image-convert-v1). */
  imageConvert: featureAvailability,
});

const idParam = z.object({ id: uuid });

/** OWASP CRS of a site. */
export const wafContract = {
  get: oc
    .route({ method: "GET", path: "/sites/{id}/waf", tags: ["protection"] })
    .input(idParam)
    .output(siteWaf),
  update: oc
    .route({ method: "PATCH", path: "/sites/{id}/waf", tags: ["protection"] })
    .input(siteWafUpdateInput)
    .output(siteWaf),
  topRules: oc
    .route({ method: "GET", path: "/sites/{id}/waf/rules", tags: ["protection"] })
    .input(wafTopRulesInput)
    .output(wafTopRules),
};

export type WafMode = z.infer<typeof wafMode>;
export type WafExclusion = z.infer<typeof wafExclusion>;
export type SiteWaf = z.infer<typeof siteWaf>;
export type SiteWafUpdateInput = z.infer<typeof siteWafUpdateInput>;
export type WafTopRules = z.infer<typeof wafTopRules>;
export type FeatureAvailability = z.infer<typeof featureAvailability>;
export type SiteFeatures = z.infer<typeof siteFeatures>;
