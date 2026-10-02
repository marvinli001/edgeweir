import {
  type BulkRedirect,
  type BulkRedirectsInput,
  bulkRedirectSourceParts,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { asc, eq } from "drizzle-orm";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import { type Executor, publishRevision } from "./revisions";
import { findSite } from "./sites";

type RedirectRow = typeof schema.bulkRedirect.$inferSelect;

const toDto = (row: RedirectRow): BulkRedirect => ({
  source: row.source,
  target: row.target,
  statusCode: row.statusCode as BulkRedirect["statusCode"],
  preserveQuery: row.preserveQuery,
});

async function siteRedirects(db: Executor, siteId: string): Promise<BulkRedirect[]> {
  const rows = await db
    .select()
    .from(schema.bulkRedirect)
    .where(eq(schema.bulkRedirect.siteId, siteId))
    .orderBy(asc(schema.bulkRedirect.position));
  return rows.map(toDto);
}

/** A site's bulk redirects in the order they were saved. */
export async function getBulkRedirects(db: Database, siteId: string): Promise<BulkRedirect[]> {
  const site = await findSite(db, siteId);
  return siteRedirects(db, site.id);
}

/** Whether `host` is one of the domains (exact, or one label under a wildcard domain). */
function servesHost(domains: { name: string; wildcard: boolean }[], host: string): boolean {
  const dot = host.indexOf(".");
  return domains.some((domain) =>
    domain.wildcard ? dot > 0 && host.slice(dot + 1) === domain.name : domain.name === host,
  );
}

const INSERT_CHUNK = 1000;

/**
 * Replaces a site's bulk redirects, publishes its cluster and audits the
 * change, in one transaction. The host
 * of a "host/path" source must be one of the site's domains
 * (BULK_REDIRECT_HOST_UNKNOWN). A table on a cluster whose active nodes lack
 * rules-v2 fails with NODE_CAPABILITY_REQUIRED unless the operator saves it
 * (insertRevision).
 */
export async function saveBulkRedirects(
  db: Database,
  input: BulkRedirectsInput,
  ctx: { actor: Actor },
): Promise<BulkRedirect[]> {
  return db.transaction(async (tx) => {
    const site = await findSite(tx, input.id, true);
    const domains = await tx
      .select({ name: schema.siteDomain.name, wildcard: schema.siteDomain.wildcard })
      .from(schema.siteDomain)
      .where(eq(schema.siteDomain.siteId, site.id));
    const unknown = [
      ...new Set(
        input.redirects
          .map((redirect) => bulkRedirectSourceParts(redirect.source)?.host ?? "")
          .filter((host) => host !== "" && !servesHost(domains, host)),
      ),
    ];
    if (unknown.length) {
      const hosts = unknown.slice(0, 5).join(", ");
      fail("BULK_REDIRECT_HOST_UNKNOWN", `the site does not serve ${hosts}`, { hosts });
    }
    await tx.delete(schema.bulkRedirect).where(eq(schema.bulkRedirect.siteId, site.id));
    const rows = input.redirects.map((redirect, position) => ({
      siteId: site.id,
      source: redirect.source,
      target: redirect.target,
      statusCode: redirect.statusCode,
      preserveQuery: redirect.preserveQuery,
      position,
    }));
    for (let i = 0; i < rows.length; i += INSERT_CHUNK)
      await tx.insert(schema.bulkRedirect).values(rows.slice(i, i + INSERT_CHUNK));
    await publishRevision(tx, {
      clusterId: site.clusterId,
      reason: { code: "rules_updated", params: {} },
      actor: ctx.actor,
    });
    await recordAudit(tx, ctx.actor, {
      action: "site.bulk_redirects_update",
      targetType: "site",
      targetId: site.id,
      targetName: site.name,
      metadata: { count: rows.length },
    });
    return siteRedirects(tx, site.id);
  });
}
