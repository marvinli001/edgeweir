import { DEVELOPMENT_MODE_FEATURE } from "@edgeweir/config-compiler";
import {
  DEVELOPMENT_MODE_SECONDS,
  type DevelopmentMode,
  type DevelopmentModeInput,
  nodeSupportsFeature,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { type Actor, systemActor } from "./audit";
import type { Tx } from "./revisions";
import { publishSiteChange } from "./site-change";
import { developmentModeUntil, findSite } from "./sites";

/**
 * Development mode of a site: the edge cache bypassed until a stored
 * deadline. The deadline goes to nodes (Site.development_mode), which stop
 * bypassing at it on their own clock, so a console that is down or a
 * worker that is late never leaves it on; the worker's every-minute sweep
 * then turns it off in the database, publishes and audits the expiry.
 * Turning it on or off, and its expiry, reach every node at once
 * (currentStable carries the current state, no canary; ADR-0021).
 */

type SiteRow = typeof schema.site.$inferSelect;
type Executor = Database | Tx;

let durationSeconds = DEVELOPMENT_MODE_SECONDS;

/**
 * How long development mode lasts: DEVELOPMENT_MODE_SECONDS, or for
 * end-to-end tests only EDGEWEIR_E2E_DEVELOPMENT_MODE_SECONDS; set once at
 * startup.
 */
export function setDevelopmentModeSeconds(seconds: number | undefined): void {
  durationSeconds = seconds ?? DEVELOPMENT_MODE_SECONDS;
}

async function toDto(db: Executor, site: SiteRow, now: number): Promise<DevelopmentMode> {
  const nodes = await db
    .select({ features: schema.node.supportedFeatures })
    .from(schema.node)
    .where(and(eq(schema.node.clusterId, site.clusterId), eq(schema.node.status, "active")));
  return {
    siteId: site.id,
    until: developmentModeUntil(site, now),
    unsupportedNodes: nodes.filter(
      (node) => !nodeSupportsFeature(node.features, DEVELOPMENT_MODE_FEATURE),
    ).length,
  };
}

export async function getDevelopmentMode(
  db: Database,
  siteId: string,
  now = Date.now(),
): Promise<DevelopmentMode> {
  return toDto(db, await findSite(db, siteId), now);
}

/**
 * Turns a site's development mode on (for the duration from now) or off.
 * Unchanged (on while on, off while off) returns without a publication or
 * an audit entry. Turning it on needs an enabled site (SITE_DISABLED) and
 * nodes with development-mode-v1 (NODE_CAPABILITY_REQUIRED, from the
 * publication). A deadline that passed and was not swept yet is expired
 * first (by the system), then the request applies to a site that is off.
 */
export async function setDevelopmentMode(
  db: Database,
  input: DevelopmentModeInput,
  ctx: { actor: Actor },
  now = Date.now(),
): Promise<DevelopmentMode> {
  return db.transaction(async (tx) => {
    let site = await findSite(tx, input.id, true);
    // A deadline that passed is the expiry's, whatever the operator asks for.
    if (site.developmentModeUntil && developmentModeUntil(site, now) === null)
      site = await expire(tx, site);
    if ((site.developmentModeUntil !== null) === input.enabled) return toDto(tx, site, now);
    if (input.enabled && !site.enabled) fail("SITE_DISABLED", "the site is disabled");
    const until = input.enabled ? new Date(now + durationSeconds * 1000) : null;
    const [updated] = await tx
      .update(schema.site)
      .set({ developmentModeUntil: until })
      .where(eq(schema.site.id, site.id))
      .returning();
    if (!updated) throw new Error("site update failed");
    await publishSiteChange(tx, ctx.actor, site, {
      reason: input.enabled ? "development_mode_on" : "development_mode_off",
      action: input.enabled ? "site.development_mode_on" : "site.development_mode_off",
      metadata: input.enabled
        ? { until: until?.toISOString() }
        : { until: site.developmentModeUntil?.toISOString() },
    });
    return toDto(tx, updated, now);
  });
}

/** Clears a deadline that passed, publishes and audits the expiry as the system. */
async function expire(tx: Tx, site: SiteRow): Promise<SiteRow> {
  const [updated] = await tx
    .update(schema.site)
    .set({ developmentModeUntil: null })
    .where(eq(schema.site.id, site.id))
    .returning();
  if (!updated) throw new Error("site update failed");
  await publishSiteChange(tx, systemActor, site, {
    reason: "development_mode_expired",
    action: "site.development_mode_expire",
    metadata: { until: site.developmentModeUntil?.toISOString() },
  });
  return updated;
}

/**
 * The worker's every-minute sweep (`development-mode.expire`, and once at
 * startup): turns off every development mode whose deadline passed, one
 * transaction per site, so one that cannot be published (logged) is tried
 * again at the next sweep without holding up the others. Nodes stopped
 * bypassing at the deadline already.
 */
export async function expireDevelopmentModes(app: AppContext, now = new Date()): Promise<number> {
  const due = await app.db
    .select({ id: schema.site.id })
    .from(schema.site)
    .where(
      and(isNotNull(schema.site.developmentModeUntil), lte(schema.site.developmentModeUntil, now)),
    );
  let expired = 0;
  for (const { id } of due) {
    try {
      const done = await app.db.transaction(async (tx) => {
        const [site] = await tx
          .select()
          .from(schema.site)
          .where(eq(schema.site.id, id))
          .for("update");
        // Turned off, deleted or on again since it was read.
        if (!site?.developmentModeUntil || site.developmentModeUntil > now) return false;
        await expire(tx, site);
        return true;
      });
      if (done) expired += 1;
    } catch (error) {
      app.log.warn("development mode expiry failed", {
        siteId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return expired;
}
