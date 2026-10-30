import * as z from "zod";

/**
 * Statistics dimensions nodes count per site and minute (MinuteStats 14-24,
 * node feature stats-dims-v1; ADR-0041 §7). User agent classes come from the
 * node's classification table; keys outside these lists are not stored.
 */
export const BROWSERS = [
  "chrome",
  "edge",
  "firefox",
  "safari",
  "opera",
  "samsung",
  "uc",
  "qq",
  "wechat",
  "yandex",
  "ie",
  "crawler",
  "tool",
  "other",
] as const;
export const OPERATING_SYSTEMS = [
  "windows",
  "macos",
  "ios",
  "android",
  "linux",
  "chromeos",
  "harmonyos",
  "other",
] as const;
export const DEVICES = ["desktop", "mobile", "tablet", "crawler", "other"] as const;
export const STATS_HTTP_VERSIONS = ["1.0", "1.1", "2", "3", "other"] as const;
export const STATS_TLS_VERSIONS = ["1.2", "1.3", "none", "other"] as const;
/** Countries a minute keeps at most (ISO 3166-1 alpha-2, plus "" for unknown). */
export const MAX_STATS_COUNTRIES = 250;
/** Networks and referring hosts a minute keeps at most (heaviest first). */
export const MAX_STATS_TOP = 50;
/**
 * Kinds and outcomes of MinuteStats.challenge_outcomes (challenge-v3), keyed `<kind>:<outcome>`:
 * captcha is the built-in image, the providers are the third-party widgets.
 */
export const CHALLENGE_OUTCOME_KINDS = [
  "cookie302",
  "js",
  "pow",
  "managed",
  "captcha",
  "turnstile",
  "recaptcha_v2",
  "recaptcha_v3",
  "recaptcha_enterprise",
  "tencent",
  "aliyun",
  "geetest",
] as const;
export const CHALLENGE_OUTCOMES = ["issued", "passed", "failed", "escalated", "fallback"] as const;
export const CHALLENGE_OUTCOME_KEYS: readonly string[] = CHALLENGE_OUTCOME_KINDS.flatMap((kind) =>
  CHALLENGE_OUTCOMES.map((outcome) => `${kind}:${outcome}`),
);
const count = z.number().int();
const keyed = z.array(z.object({ key: z.string(), requests: count }));

export const statsDimensionsInput = z.object({
  range: z.enum(["1h", "6h", "24h", "7d", "30d"]).default("24h"),
  /** Only this site; omitted: every site. */
  siteId: z.uuid().optional(),
});

export const statsDimensions = z.object({
  /** Client countries by requests, with bytes sent; country "" is unknown. */
  countries: z.array(z.object({ country: z.string(), requests: count, bytesSent: count })),
  /** Client networks by requests (approximate, at most 50). */
  asns: z.array(z.object({ asn: count, name: z.string(), requests: count })),
  /** Referring hosts by requests (approximate, at most 50). */
  referers: z.array(z.object({ host: z.string(), requests: count })),
  browsers: keyed,
  oses: keyed,
  devices: keyed,
  httpVersions: keyed,
  tlsVersions: keyed,
  /** Requests per block reason. */
  blockReasons: keyed,
  challenges: z.object({
    issued: count,
    passed: count,
    /** Each kind's outcomes (challenge-v3 nodes), kinds with none left out. */
    byKind: z.array(
      z.object({
        kind: z.enum(CHALLENGE_OUTCOME_KINDS),
        issued: count,
        passed: count,
        failed: count,
        escalated: count,
        fallback: count,
      }),
    ),
  }),
  /** Active nodes of the sites' clusters without stats-dims-v1: the counts are partial. */
  unsupportedNodes: count,
});
export type StatsDimensionsInput = z.infer<typeof statsDimensionsInput>;
export type StatsDimensions = z.infer<typeof statsDimensions>;
