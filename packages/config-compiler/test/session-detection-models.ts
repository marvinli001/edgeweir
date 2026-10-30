import type { CompileInput } from "../src/index";
import { site, tls } from "./v0230-models";

/**
 * The console models behind the session detection vector: site a enforces
 * with the interstitial off and two interstitial rules (on for /checkout on
 * www.a.test, off for api.a.test), site b monitors, site c has none.
 */
export const sessionDetectionModels = (): CompileInput => ({
  clusterId: "c1",
  sites: [
    site("a", {
      tls: tls(),
      sessionDetection: {
        mode: "enforce",
        interstitial: false,
        interstitialRules: [
          { host: "www.a.test", pathPrefix: "/checkout", interstitial: true },
          { host: "api.a.test", pathPrefix: "", interstitial: false },
        ],
      },
    }),
    site("b", { sessionDetection: { mode: "monitor", interstitial: true, interstitialRules: [] } }),
    site("c"),
  ],
  challengeKeys: [{ id: "k1", role: "current" }],
});
