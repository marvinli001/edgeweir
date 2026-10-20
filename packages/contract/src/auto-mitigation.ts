import { oc } from "@orpc/contract";
import * as z from "zod";
import { ccLevel } from "./protection";
import { expectedUpdatedAt, isoDateTime, uuid } from "./schemas";

/**
 * Automatic mitigation of a site (ADR-0051): when a node's CC level for the
 * site reaches the threshold, the site's Under Attack is turned on and stays
 * on until the escalation has been over for the duration; then it is turned
 * off again. Off until set up. Under Attack uses the site's own challenge
 * type.
 */

/** CC levels that can start it: a challenge level, not `normal`. */
export const AUTO_MITIGATION_LEVELS = ["cookie302", "js", "pow", "captcha"] as const;
export const autoMitigationLevel = z.enum(AUTO_MITIGATION_LEVELS);
/** Minutes Under Attack stays on after the level was last at the threshold. */
export const AUTO_MITIGATION_DURATION_RANGE = { min: 5, max: 1440 } as const;
export const AUTO_MITIGATION_DEFAULTS = {
  enabled: true,
  threshold: "pow",
  durationMinutes: 30,
} as const;

const fields = z.object({
  enabled: z.boolean().default(AUTO_MITIGATION_DEFAULTS.enabled),
  threshold: autoMitigationLevel.default(AUTO_MITIGATION_DEFAULTS.threshold),
  durationMinutes: z
    .number()
    .int()
    .min(AUTO_MITIGATION_DURATION_RANGE.min)
    .max(AUTO_MITIGATION_DURATION_RANGE.max)
    .default(AUTO_MITIGATION_DEFAULTS.durationMinutes),
});

export const autoMitigationSettings = fields;
export const autoMitigationInput = fields.extend({ id: uuid, expectedUpdatedAt });

/** A site's automatic mitigation: its settings, what it holds now and the level it reacts to. */
export const autoMitigation = z.object({
  siteId: uuid,
  /** Null: never set up (off). */
  settings: autoMitigationSettings.nullable(),
  updatedAt: isoDateTime.nullable(),
  /** The highest CC level any online node holds for the site now. */
  level: ccLevel,
  /** Under Attack as the mitigation turned it on and still holds it; `expiresAt` moves while the level stays at the threshold. */
  active: z.object({ since: isoDateTime, expiresAt: isoDateTime, level: ccLevel }).nullable(),
  /** The operator took over: nothing starts until the level is below the threshold again. */
  paused: z.boolean(),
  /** Error code of the last change that could not be published; empty when none. */
  lastError: z.string(),
});

const idParam = z.object({ id: uuid });

/** A site's automatic mitigation. */
export const autoMitigationContract = {
  get: oc
    .route({ method: "GET", path: "/sites/{id}/auto-mitigation", tags: ["sites"] })
    .input(idParam)
    .output(autoMitigation),
  /** Creates or replaces the settings; they apply from the next evaluation (within a minute). */
  update: oc
    .route({ method: "PUT", path: "/sites/{id}/auto-mitigation", tags: ["sites"] })
    .input(autoMitigationInput)
    .output(autoMitigation),
  /**
   * Ends the mitigation now: turns Under Attack off and starts nothing until the level is below
   * the threshold again. AUTO_MITIGATION_NOT_ACTIVE when it holds none.
   */
  restore: oc
    .route({ method: "POST", path: "/sites/{id}/auto-mitigation/restore", tags: ["sites"] })
    .input(idParam)
    .output(autoMitigation),
};

export type AutoMitigationLevel = z.infer<typeof autoMitigationLevel>;
export type AutoMitigationSettings = z.infer<typeof autoMitigationSettings>;
export type AutoMitigationInput = z.infer<typeof autoMitigationInput>;
export type AutoMitigation = z.infer<typeof autoMitigation>;
