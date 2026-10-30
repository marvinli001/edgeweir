import type { SessionDetectionModel } from "@edgeweir/config-compiler";
import {
  SESSION_DETECTION_DEFAULTS,
  type SessionDetectionSettings,
  sessionDetectionSettings,
} from "@edgeweir/contract";

/**
 * A site's stored session detection (site.session_detection) with the
 * defaults filled in; `{}` (never saved) is off.
 */
export function readSessionDetection(value: unknown): SessionDetectionSettings {
  const stored = value && typeof value === "object" ? value : {};
  const parsed = sessionDetectionSettings.safeParse({ ...SESSION_DETECTION_DEFAULTS, ...stored });
  return parsed.success ? parsed.data : { ...SESSION_DETECTION_DEFAULTS, interstitialRules: [] };
}

/** What nodes get (config.proto SessionDetection): nothing while it is off. */
export function sessionDetectionModel(value: unknown): SessionDetectionModel | undefined {
  const { mode, interstitial, interstitialRules } = readSessionDetection(value);
  return mode === "off" ? undefined : { mode, interstitial, interstitialRules };
}
