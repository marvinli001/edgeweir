import {
  type BulkRedirect,
  type BulkRedirectsInput,
  bulkRedirectSourceParts,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { asc, eq } from "drizzle-orm";
import { fail } from "../lib/errors";
import type { Actor } from "./audit";
import type { Executor } from "./revisions";
import { publishSiteChange } from "./site-change";
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

/**
 * Whether `host` is one of the domains: an exact domain, or one label under
 * a wildcard domain. Hosts only a `.` suffix or a pattern matches are not
 * accepted as sources.
 */
function servesHost(domains: { name: string; kind: string }[], host: string): boolean {
  const dot = host.indexOf(".");
  return domains.some((domain) =>
    domain.kind === "wildcard"
      ? dot > 0 && host.slice(dot + 1) === domain.name
      : domain.kind === "exact" && domain.name === host,
  );
}

const INSERT_CHUNK = 1000;

/**
 * Fails with BULK_REDIRECT_HOST_UNKNOWN unless the host of every "host/path"
 * source is one of the site's domains.
 */
export async function assertRedirectHosts(
  tx: Executor,
  siteId: string,
  redirects: readonly { source: string }[],
) {
  const domains = await tx
    .select({ name: schema.siteDomain.name, kind: schema.siteDomain.kind })
    .from(schema.siteDomain)
    .where(eq(schema.siteDomain.siteId, siteId));
  const unknown = [
    ...new Set(
      redirects
        .map((redirect) => bulkRedirectSourceParts(redirect.source)?.host ?? "")
        .filter((host) => host !== "" && !servesHost(domains, host)),
    ),
  ];
  if (unknown.length) {
    const hosts = unknown.slice(0, 5).join(", ");
    fail("BULK_REDIRECT_HOST_UNKNOWN", `the site does not serve ${hosts}`, { hosts });
  }
}

/** Replaces the site's bulk redirects, keeping their order. */
export async function storeBulkRedirects(
  tx: Executor,
  siteId: string,
  redirects: readonly Pick<RedirectRow, "source" | "target" | "statusCode" | "preserveQuery">[],
) {
  await tx.delete(schema.bulkRedirect).where(eq(schema.bulkRedirect.siteId, siteId));
  const rows = redirects.map((redirect, position) => ({
    siteId,
    source: redirect.source,
    target: redirect.target,
    statusCode: redirect.statusCode,
    preserveQuery: redirect.preserveQuery,
    position,
  }));
  for (let i = 0; i < rows.length; i += INSERT_CHUNK)
    await tx.insert(schema.bulkRedirect).values(rows.slice(i, i + INSERT_CHUNK));
}

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
    await assertRedirectHosts(tx, site.id, input.redirects);
    await storeBulkRedirects(tx, site.id, input.redirects);
    await publishSiteChange(tx, ctx.actor, site, {
      reason: "rules_updated",
      params: {},
      action: "site.bulk_redirects_update",
      metadata: { count: input.redirects.length },
    });
    return siteRedirects(tx, site.id);
  });
}
