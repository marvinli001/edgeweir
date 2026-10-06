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
export const WAF_MAX_EXCLUSIONS = 200;

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

/** Rule ids that never run for the site; unique, stored in ascending order. */
export const wafExcludedRuleIds = z
  .array(wafRuleId)
  .max(WAF_MAX_EXCLUSIONS)
  .refine((ids) => new Set(ids).size === ids.length, { message: "rule ids must be unique" });

export const WAF_DEFAULTS = {
  mode: "off",
  paranoiaLevel: 1,
  anomalyThreshold: 5,
  excludedRuleIds: [] as number[],
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
  excludedRuleIds: z.array(z.number().int()),
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
  excludedRuleIds: wafExcludedRuleIds.optional(),
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
  /**
   * The site settings of proto v0.24.0 (site-content-v1): cache keys that drop
   * parameters, caching responses with Set-Cookie, the PURGE method, hiding
   * X-Cache, error pages for more statuses, classes and redirects,
   * maintenance, charsets, the gzip level and the largest compressed response,
   * request body limits and origin tries.
   */
  siteContent: featureAvailability,
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
export type SiteWaf = z.infer<typeof siteWaf>;
export type SiteWafUpdateInput = z.infer<typeof siteWafUpdateInput>;
export type WafTopRules = z.infer<typeof wafTopRules>;
export type FeatureAvailability = z.infer<typeof featureAvailability>;
export type SiteFeatures = z.infer<typeof siteFeatures>;
