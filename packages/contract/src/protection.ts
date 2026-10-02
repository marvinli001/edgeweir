import { challengeTypes } from "@edgeweir/rule-engine";
import { oc } from "@orpc/contract";
import * as z from "zod";
import { isoDateTime, uuid } from "./schemas";

/**
 * Challenges, Under Attack and tiered CC mitigation. Challenge types are also
 * levels, in rising strength: cookie302 (1), js (2), pow (3), captcha (4). A
 * pass of one level satisfies every requirement up to it.
 */
export const CHALLENGE_TYPES = challengeTypes;
export const challengeType = z.enum(challengeTypes);
/** CC mitigation levels: normal, then the challenge types. */
export const CC_LEVELS = ["normal", ...challengeTypes] as const;
export const ccLevel = z.enum(CC_LEVELS);

/** Ranges of the site settings (seconds, leading zero bits). */
export const PASS_TTL_RANGE = { min: 300, max: 86400 } as const;
export const POW_DIFFICULTY_RANGE = { min: 8, max: 24 } as const;
export const POW_HIGH_DIFFICULTY_RANGE = { min: 8, max: 26 } as const;
/** Days security events are kept (platform setting). */
export const EVENT_RETENTION_RANGE = { min: 7, max: 365 } as const;

const count = (max: number) => z.number().int().min(0).max(max);

/**
 * Thresholds of a CC policy; every rate is in requests per second over a
 * sliding window and 0 turns its trigger off. Decisions are local to each
 * node, so thresholds apply per node.
 */
export const ccThresholds = z.object({
  /** Highest level the policy may reach. */
  maxLevel: challengeType,
  /** At the captcha level, challenge with the high-difficulty proof of work instead. */
  highPowInsteadOfCaptcha: z.boolean(),
  windowSeconds: z.number().int().min(5).max(60),
  siteQps: count(1_000_000),
  /** Only attacked paths are escalated. */
  urlQps: count(1_000_000),
  /** Addresses over this rate are banned automatically for ipBanSeconds. */
  ipQps: count(1_000_000),
  ipBanSeconds: z.number().int().min(60).max(86400),
  /** Origin errors (5xx and failed attempts) in percent of origin requests. */
  originErrorPercent: count(100),
  /** Origin requests in the window before the error rate counts. */
  originErrorMinRequests: count(1_000_000),
  /** A trigger that holds this long raises the level by one step. */
  escalateAfterSeconds: z.number().int().min(1).max(3600),
  /** Without triggers for this long, the level falls by one step. */
  cooldownSeconds: z.number().int().min(1).max(86400),
});

/** The platform's CC template (system setting `cc_template`). */
export const ccTemplate = ccThresholds;
export const CC_TEMPLATE_DEFAULTS: CcThresholds = {
  maxLevel: "captcha",
  highPowInsteadOfCaptcha: false,
  windowSeconds: 10,
  siteQps: 1000,
  urlQps: 200,
  ipQps: 50,
  ipBanSeconds: 600,
  originErrorPercent: 50,
  originErrorMinRequests: 100,
  escalateAfterSeconds: 10,
  cooldownSeconds: 60,
};

/** Preset levels of the CC, challenge and CRS settings; "standard" is each one's default. */
export const PRESET_LEVELS = ["loose", "standard", "strict"] as const;
export type PresetLevel = (typeof PRESET_LEVELS)[number];

/** The preset level whose every setting `value` has, or null (custom settings). */
export function matchPreset<T extends object>(
  presets: Record<PresetLevel, T>,
  value: T,
): PresetLevel | null {
  return (
    PRESET_LEVELS.find((level) =>
      Object.entries(presets[level]).every(([key, want]) => value[key as keyof T] === want),
    ) ?? null
  );
}

/**
 * CC presets. Loose triples the rates (bursty legitimate traffic: APIs, pages with many
 * assets, many users behind one NAT), tolerates more origin errors, escalates more slowly,
 * bans briefly and stops at proof of work, so no visitor meets a captcha. Strict divides the
 * rates by about three, reacts to origin errors earlier, escalates faster, bans for an hour
 * and cools down slowly so the level does not flap during an attack.
 */
export const CC_PRESETS: Record<PresetLevel, CcThresholds> = {
  loose: {
    maxLevel: "pow",
    highPowInsteadOfCaptcha: false,
    windowSeconds: 10,
    siteQps: 3000,
    urlQps: 600,
    ipQps: 150,
    ipBanSeconds: 300,
    originErrorPercent: 70,
    originErrorMinRequests: 200,
    escalateAfterSeconds: 20,
    cooldownSeconds: 60,
  },
  standard: CC_TEMPLATE_DEFAULTS,
  strict: {
    maxLevel: "captcha",
    highPowInsteadOfCaptcha: false,
    windowSeconds: 10,
    siteQps: 300,
    urlQps: 60,
    ipQps: 20,
    ipBanSeconds: 3600,
    originErrorPercent: 30,
    originErrorMinRequests: 50,
    escalateAfterSeconds: 5,
    cooldownSeconds: 300,
  },
};

/** Pass lifetime and proof-of-work difficulties of a site's challenges. */
export interface ChallengePreset {
  passTtlSeconds: number;
  powDifficulty: number;
  powHighDifficulty: number;
}
/**
 * Challenge presets; each extra bit doubles a proof of work. Loose needs a quarter of the
 * standard work (about 16k hashes) and keeps passes an hour; strict four times as much (about
 * 260k hashes) and asks again after 15 minutes.
 */
export const CHALLENGE_PRESETS: Record<PresetLevel, ChallengePreset> = {
  loose: { passTtlSeconds: 3600, powDifficulty: 14, powHighDifficulty: 18 },
  standard: { passTtlSeconds: 1800, powDifficulty: 16, powHighDifficulty: 20 },
  strict: { passTtlSeconds: 900, powDifficulty: 18, powHighDifficulty: 22 },
};

/** A site's CC policy; with followTemplate the thresholds come from the platform template. */
export const siteCcPolicy = ccThresholds.extend({
  enabled: z.boolean(),
  followTemplate: z.boolean(),
});

export const siteProtection = z.object({
  siteId: uuid,
  /** Challenge every GET/HEAD request without a valid pass. */
  underAttack: z.boolean(),
  underAttackChallenge: challengeType,
  passTtlSeconds: z.number().int(),
  powDifficulty: z.number().int(),
  powHighDifficulty: z.number().int(),
  /** The policy (off and following the template until first saved); thresholds are the template's while following it. */
  cc: siteCcPolicy,
  /** The platform's current CC template. */
  ccTemplate: ccThresholds,
  /** Thresholds the nodes use; null while the policy is off. */
  effectiveCc: ccThresholds.nullable(),
  /** Record the JA4 fingerprint in sampled access logs. */
  logJa4: z.boolean(),
  /** Under Attack is on for every site (system settings). */
  platformUnderAttack: z.boolean(),
  updatedAt: isoDateTime.nullable(),
});

/** Changes only the fields given; `cc` fields merge into the saved policy. */
export const siteProtectionUpdateInput = z.object({
  id: uuid,
  underAttack: z.boolean().optional(),
  underAttackChallenge: challengeType.optional(),
  passTtlSeconds: z.number().int().min(PASS_TTL_RANGE.min).max(PASS_TTL_RANGE.max).optional(),
  powDifficulty: z
    .number()
    .int()
    .min(POW_DIFFICULTY_RANGE.min)
    .max(POW_DIFFICULTY_RANGE.max)
    .optional(),
  /** At least powDifficulty. */
  powHighDifficulty: z
    .number()
    .int()
    .min(POW_HIGH_DIFFICULTY_RANGE.min)
    .max(POW_HIGH_DIFFICULTY_RANGE.max)
    .optional(),
  cc: siteCcPolicy.partial().optional(),
  logJa4: z.boolean().optional(),
});

/** Platform protection (system setting `protection_settings`). */
export const protectionSettings = z.object({
  /** Under Attack for every site of every cluster. */
  underAttack: z.boolean(),
  underAttackChallenge: challengeType,
  eventRetentionDays: z
    .number()
    .int()
    .min(EVENT_RETENTION_RANGE.min)
    .max(EVENT_RETENTION_RANGE.max),
});
export const PROTECTION_SETTINGS_DEFAULTS: ProtectionSettings = {
  underAttack: false,
  underAttackChallenge: "js",
  eventRetentionDays: 30,
};

export const securityEventKind = z.enum(["site_level", "path_level", "ip_banned"]);
const topCount = z.object({ value: z.string(), count: z.number() });

export const securityEvent = z.object({
  id: uuid,
  /** Null once the node is deleted. */
  node: z.object({ id: uuid, name: z.string() }).nullable(),
  occurredAt: isoDateTime,
  kind: securityEventKind,
  /** Level after and before the change (site_level, path_level). */
  level: z.string(),
  previousLevel: z.string(),
  /** Path of a path_level event. */
  path: z.string(),
  /** Address of an ip_banned event. */
  address: z.string(),
  /** site_qps, url_qps, ip_qps, origin_error_rate or cooldown. */
  metric: z.string(),
  observed: z.number(),
  threshold: z.number(),
  topIps: z.array(topCount),
  topPaths: z.array(topCount),
});

export const securityEventList = z.object({
  items: z.array(securityEvent),
  total: z.number().int(),
});

export const securityEventListInput = z.object({
  id: uuid,
  kind: securityEventKind.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

/** Current CC level of a site on each active node of its cluster. */
export const siteSecurityState = z.object({
  nodes: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      online: z.boolean(),
      level: ccLevel,
      /** Paths challenged above the site's level. */
      escalatedPaths: z.number().int(),
      reportedAt: isoDateTime.nullable(),
    }),
  ),
  /** Heaviest addresses and paths of the events in the last `hours` (approximate). */
  topIps: z.array(topCount),
  topPaths: z.array(topCount),
  hours: z.number().int(),
});

const idParam = z.object({ id: uuid });

/** Under Attack, CC policy, passes and JA4 logging of a site. */
export const protectionContract = {
  get: oc
    .route({ method: "GET", path: "/sites/{id}/protection", tags: ["protection"] })
    .input(idParam)
    .output(siteProtection),
  update: oc
    .route({ method: "PATCH", path: "/sites/{id}/protection", tags: ["protection"] })
    .input(siteProtectionUpdateInput)
    .output(siteProtection),
};

/** CC mitigation state and events of a site. */
export const securityContract = {
  state: oc
    .route({ method: "GET", path: "/sites/{id}/security", tags: ["protection"] })
    .input(idParam.extend({ hours: z.coerce.number().int().min(1).max(168).default(24) }))
    .output(siteSecurityState),
  events: oc
    .route({ method: "GET", path: "/sites/{id}/security/events", tags: ["protection"] })
    .input(securityEventListInput)
    .output(securityEventList),
};

export type ChallengeType = z.infer<typeof challengeType>;
export type CcLevel = z.infer<typeof ccLevel>;
export type CcThresholds = z.infer<typeof ccThresholds>;
export type SiteCcPolicy = z.infer<typeof siteCcPolicy>;
export type SiteProtection = z.infer<typeof siteProtection>;
export type SiteProtectionUpdateInput = z.infer<typeof siteProtectionUpdateInput>;
export type ProtectionSettings = z.infer<typeof protectionSettings>;
export type SecurityEvent = z.infer<typeof securityEvent>;
export type SecurityEventKind = z.infer<typeof securityEventKind>;
export type SiteSecurityState = z.infer<typeof siteSecurityState>;
