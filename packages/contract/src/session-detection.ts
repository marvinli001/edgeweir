/**
 * Session detection and the bot score (proto vNEXT, feature
 * session-detection-v1, ADR-0068). Nodes score each request of the site
 * from 1 (automated) to 99 from server-side signals and the signals of a
 * small first-party script they add to HTML responses; "monitor" only
 * scores, "enforce" also shows the interstitial where it applies and
 * challenges automated sessions.
 */
import { oc } from "@orpc/contract";
import * as z from "zod";
import { ldhHost } from "./domains";
import { uuid } from "./schemas";

export const SESSION_DETECTION_MODES = ["off", "monitor", "enforce"] as const;
export const MAX_INTERSTITIAL_RULES = 32;
/** Scores below this are automated (http.request.bot.automated). */
export const BOT_SCORE_AUTOMATED_BELOW = 30;
/** MinuteStats.bot_scores keys: the lowest score of each band (1-9, 10-19, ... 90-99). */
export const BOT_SCORE_BANDS = ["1", "10", "20", "30", "40", "50", "60", "70", "80", "90"] as const;

/** What a site starts with (off). */
export const SESSION_DETECTION_DEFAULTS = {
  mode: "off",
  interstitial: false,
  interstitialRules: [],
} as const;

/** "" (every host), a lowercase host name or a wildcard of one label ("*.example.com"). */
export function validInterstitialHost(host: string): boolean {
  if (host === "") return true;
  return ldhHost(host.startsWith("*.") ? host.slice(2) : host);
}

/** "" (every path) or 1-256 bytes of printable ASCII starting with "/", without spaces. */
export function validInterstitialPath(path: string): boolean {
  return path === "" || (path.length <= 256 && /^\/[\x21-\x7e]*$/.test(path));
}

export const interstitialRule = z.object({
  host: z.string().max(255).refine(validInterstitialHost, "invalid host"),
  pathPrefix: z.string().max(256).refine(validInterstitialPath, "invalid path prefix"),
  interstitial: z.boolean(),
});

export const sessionDetectionSettings = z.object({
  mode: z.enum(SESSION_DETECTION_MODES),
  /** The site's default: show the interstitial to requests without a valid session (enforce). */
  interstitial: z.boolean(),
  /** Overrides of `interstitial` by host and path, in order; the first that matches applies. */
  interstitialRules: z.array(interstitialRule).max(MAX_INTERSTITIAL_RULES),
});
const sessionDetectionInput = sessionDetectionSettings.extend({ id: uuid });

const idParam = z.object({ id: uuid });

/** A site's session detection. */
export const sessionDetectionContract = {
  get: oc
    .route({ method: "GET", path: "/sites/{id}/session-detection", tags: ["sites"] })
    .input(idParam)
    .output(sessionDetectionSettings),
  /** Replaces the settings; publishes the site's cluster when nodes see a change. */
  update: oc
    .route({ method: "PUT", path: "/sites/{id}/session-detection", tags: ["sites"] })
    .input(sessionDetectionInput)
    .output(sessionDetectionSettings),
};

export type SessionDetectionSettings = z.infer<typeof sessionDetectionSettings>;
export type InterstitialRule = z.infer<typeof interstitialRule>;
