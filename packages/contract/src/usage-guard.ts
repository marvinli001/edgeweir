import { oc } from "@orpc/contract";
import * as z from "zod";
import { expectedUpdatedAt, isoDateTime, uuid } from "./schemas";

/**
 * Usage protection of a site (ADR-0049): limits on bytes sent, requests and
 * bandwidth that the operator sets on their own sites, with an alert at a
 * warning threshold and at 100%, and at 100% optionally maintenance mode or
 * disabling the site. Evaluated every minute from the nodes' statistics.
 */

/** A calendar day or month in the guard's time zone. */
export const usageGuardPeriod = z.enum(["day", "month"]);
/** What happens at 100%: alert only, maintenance mode or disabling the site. */
export const usageGuardAction = z.enum(["alert", "maintenance", "disable"]);
/**
 * auto: the action is lifted once the period is no longer over a limit (next
 * period, a higher limit, or bandwidth after its hold time); manual: only by
 * restoring.
 */
export const usageGuardRecovery = z.enum(["auto", "manual"]);
/** bytes: bytes sent to visitors; bandwidth: the average of the last 5 complete minutes. */
export const usageGuardMetric = z.enum(["bytes", "requests", "bandwidth"]);
/** Bandwidth is the average over this many complete minutes, across every node. */
export const USAGE_GUARD_BANDWIDTH_MINUTES = 5;
/** 0.001 Mbps .. 10 Tbps, in bits per second. */
export const USAGE_GUARD_MIN_BPS = 1000;
export const USAGE_GUARD_MAX_BPS = 10_000_000_000_000;

/** A positive decimal integer of at most 38 digits (exact beyond 2^53). */
const limit = z.string().regex(/^[1-9][0-9]{0,37}$/);
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);

/** Whether an IANA time zone name is known to this runtime. */
export function validTimeZone(name: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

const timeZone = z.string().trim().min(1).max(64).refine(validTimeZone, "unknown time zone");

const usageGuardFields = z.object({
  period: usageGuardPeriod.default("month"),
  /** IANA name; the period starts at midnight there. */
  timeZone,
  /** Bytes sent per period. */
  bytesLimit: limit.nullable().default(null),
  requestsLimit: limit.nullable().default(null),
  /** Bits per second. */
  bandwidthBps: z
    .number()
    .int()
    .min(USAGE_GUARD_MIN_BPS)
    .max(USAGE_GUARD_MAX_BPS)
    .nullable()
    .default(null),
  /** The warning alert's threshold in percent; null: no warning. */
  warnPercent: z.number().int().min(1).max(99).nullable().default(80),
  action: usageGuardAction.default("maintenance"),
  recovery: usageGuardRecovery.default("auto"),
  /** With auto recovery, how long an action for bandwidth holds after the last time it was over. */
  bandwidthHoldMinutes: z.number().int().min(5).max(1440).default(30),
});

function checkLimits(
  value: { bytesLimit: string | null; requestsLimit: string | null; bandwidthBps: number | null },
  ctx: z.RefinementCtx,
) {
  if (value.bytesLimit === null && value.requestsLimit === null && value.bandwidthBps === null)
    ctx.addIssue({ code: "custom", path: ["bytesLimit"], message: "set at least one limit" });
}

const usageGuardSettings = usageGuardFields.superRefine(checkLimits);
const usageGuardInput = usageGuardFields
  .extend({ id: uuid, expectedUpdatedAt })
  .superRefine(checkLimits);

/** A site's usage protection, its current period and what it holds. */
const usageGuard = z.object({
  siteId: uuid,
  /** Null: not set. */
  settings: usageGuardSettings.nullable(),
  updatedAt: isoDateTime.nullable(),
  /** The current period; null when not set. */
  period: z.object({ start: isoDateTime, end: isoDateTime }).nullable(),
  /** Usage of the current period (decimal strings) and the current bandwidth. */
  usage: z
    .object({
      bytes: decimal,
      requests: decimal,
      /** Average over the last 5 complete minutes, bits per second. */
      bandwidthBps: z.number(),
      /** The highest bandwidth seen in this period. */
      bandwidthPeakBps: z.number(),
    })
    .nullable(),
  /** The action the guard applied and still holds. */
  held: z
    .object({
      action: z.enum(["maintenance", "disable"]),
      metric: usageGuardMetric,
      since: isoDateTime,
    })
    .nullable(),
  /** Restored by the operator: no action until then (the end of that period). */
  pausedUntil: isoDateTime.nullable(),
  /** Error code of the last action that could not be published; empty when none. */
  lastError: z.string(),
});

const idParam = z.object({ id: uuid });

/** A site's usage protection. */
export const usageGuardContract = {
  get: oc
    .route({ method: "GET", path: "/sites/{id}/usage-guard", tags: ["sites"] })
    .input(idParam)
    .output(usageGuard),
  /** Creates or replaces the settings; they apply from the next evaluation (within a minute). */
  update: oc
    .route({ method: "PUT", path: "/sites/{id}/usage-guard", tags: ["sites"] })
    .input(usageGuardInput)
    .output(usageGuard),
  /** Removes the settings, lifting an action they hold. */
  delete: oc
    .route({ method: "DELETE", path: "/sites/{id}/usage-guard", tags: ["sites"] })
    .input(idParam)
    .output(usageGuard),
  /**
   * Lifts the action the guard holds and pauses it until the end of the
   * period (alerts continue). USAGE_GUARD_NOT_HELD when it holds none.
   */
  restore: oc
    .route({ method: "POST", path: "/sites/{id}/usage-guard/restore", tags: ["sites"] })
    .input(idParam)
    .output(usageGuard),
};

export type UsageGuardPeriod = z.infer<typeof usageGuardPeriod>;
export type UsageGuardAction = z.infer<typeof usageGuardAction>;
export type UsageGuardMetric = z.infer<typeof usageGuardMetric>;
export type UsageGuardSettings = z.infer<typeof usageGuardSettings>;
export type UsageGuardInput = z.infer<typeof usageGuardInput>;
export type UsageGuard = z.infer<typeof usageGuard>;
