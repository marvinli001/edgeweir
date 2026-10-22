import type { SiteMaintenance, SiteMaintenanceInput } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { readMaintenance } from "../lib/site-content";
import { assertUpdatedAt, nextUpdatedAt } from "../lib/updated-at";
import type { Actor } from "./audit";
import { assertTemplateSize } from "./error-pages";
import { publishSiteChange } from "./site-change";
import { findSite } from "./sites";
import { noteOperatorRestore } from "./usage-guard";

type SiteRow = typeof schema.site.$inferSelect;

function toDto(site: SiteRow): SiteMaintenance {
  return {
    siteId: site.id,
    ...readMaintenance(site.maintenance),
    updatedAt: site.maintenanceUpdatedAt?.toISOString() ?? null,
  };
}

export async function getSiteMaintenance(db: Database, siteId: string): Promise<SiteMaintenance> {
  return toDto(await findSite(db, siteId));
}

/**
 * Saves a site's maintenance mode (kept while off), publishes its cluster
 * (a hot update; site-content-v1 while on) and audits the change without
 * the page itself. A page over 64 KiB of UTF-8 fails with
 * ERROR_PAGE_TOO_LARGE (status 503).
 */
export async function updateSiteMaintenance(
  db: Database,
  input: SiteMaintenanceInput,
  ctx: { actor: Actor },
): Promise<SiteMaintenance> {
  assertTemplateSize(503, input.template);
  return db.transaction(async (tx) => {
    const site = await findSite(tx, input.id, true);
    assertUpdatedAt(
      site.maintenanceUpdatedAt,
      input.expectedUpdatedAt,
      "the maintenance settings changed since they were read",
    );
    const before = readMaintenance(site.maintenance);
    const after = {
      enabled: input.enabled,
      template: input.template,
      retryAfterSeconds: input.retryAfterSeconds,
      allowedCidrs: [...new Set(input.allowedCidrs)],
      allowedPathPrefixes: [...new Set(input.allowedPathPrefixes)],
    };
    const updatedAt = nextUpdatedAt(site.maintenanceUpdatedAt);
    const [updated] = await tx
      .update(schema.site)
      .set({ maintenance: after, maintenanceUpdatedAt: updatedAt })
      .where(eq(schema.site.id, site.id))
      .returning();
    if (!updated) throw new Error("site update failed");
    if (!after.enabled) await noteOperatorRestore(tx, updated);
    const summary = (m: typeof after) => ({
      enabled: m.enabled,
      retryAfterSeconds: m.retryAfterSeconds,
      allowedCidrs: m.allowedCidrs,
      allowedPathPrefixes: m.allowedPathPrefixes,
      templateBytes: Buffer.byteLength(m.template),
    });
    await publishSiteChange(tx, ctx.actor, site, {
      reason: "site_maintenance_updated",
      action: "site.maintenance_update",
      metadata: { from: summary(before), to: summary(after) },
    });
    return toDto(updated);
  });
}
