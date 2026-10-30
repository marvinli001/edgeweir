import { oc } from "@orpc/contract";
import * as z from "zod";
import { isoDateTime, uuid } from "./schemas";

/**
 * Development mode of a site: for three hours the edge neither serves the
 * site's requests from the cache nor stores them, so they go to the origin
 * (X-Cache: BYPASS). Cached objects stay and are served again afterwards;
 * purge them for the new versions. Nodes end it on their own at the
 * deadline; the console then turns it off (audited) within a minute.
 */

/** How long development mode lasts once turned on. */
export const DEVELOPMENT_MODE_SECONDS = 3 * 60 * 60;

const developmentMode = z.object({
  siteId: uuid,
  /** When development mode ends; null while off (a deadline that passed reads as off). */
  until: isoDateTime.nullable(),
  /** Active nodes of the site's cluster that cannot bypass their cache (no development-mode-v1). */
  unsupportedNodes: z.number().int(),
});

const idParam = z.object({ id: uuid });
const developmentModeInput = z.object({
  id: uuid,
  /** On: for DEVELOPMENT_MODE_SECONDS from now (already on: unchanged). Off: now. */
  enabled: z.boolean(),
});

/** A site's development mode. */
export const developmentModeContract = {
  get: oc
    .route({ method: "GET", path: "/sites/{id}/development-mode", tags: ["sites"] })
    .input(idParam)
    .output(developmentMode),
  /** Turns it on or off; publishes the site's cluster to every node (no canary) when it changes. */
  set: oc
    .route({ method: "PUT", path: "/sites/{id}/development-mode", tags: ["sites"] })
    .input(developmentModeInput)
    .output(developmentMode),
};

export type DevelopmentMode = z.infer<typeof developmentMode>;
export type DevelopmentModeInput = z.infer<typeof developmentModeInput>;
