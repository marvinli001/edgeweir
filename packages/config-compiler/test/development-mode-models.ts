import type { CompileInput } from "../src/index";
import { site, tls } from "./v0230-models";

/** Development mode of site a ends here; the milliseconds are dropped (whole seconds). */
export const DEVELOPMENT_MODE_UNTIL = new Date("2026-11-01T03:00:00.250Z");

/**
 * The console models behind the development mode vector: site a's
 * development mode ends at DEVELOPMENT_MODE_UNTIL, site b has none.
 */
export const developmentModeModels = (): CompileInput => ({
  clusterId: "c1",
  sites: [
    site("a", { tls: tls(), developmentModeUntil: DEVELOPMENT_MODE_UNTIL }),
    site("b", { tls: tls() }),
  ],
});
