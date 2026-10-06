import type { PlatformErrorPagesModel } from "@edgeweir/config-compiler";
import {
  ERROR_PAGE_MAX_BYTES,
  type ErrorPage,
  type ErrorPageStatus,
  PLATFORM_ERROR_PAGE_STATUSES,
  type PlatformErrorPages,
  platformErrorPages,
  type SiteErrorPages,
  type SiteErrorPagesInput,
  utf8Bytes,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { asc, eq, inArray } from "drizzle-orm";
import { fail } from "../lib/errors";
import { lockPlatformErrorPages } from "../lib/locks";
import { assertUpdatedAt } from "../lib/updated-at";
import { type Actor, recordAudit } from "./audit";
import { type Executor, publishClusters, publishRevision } from "./revisions";
import { defineSetting } from "./settings";
import { findSite } from "./sites";

/** system_setting key of the platform's error pages (`PlatformErrorPages`). */
export const ERROR_PAGES_KEY = "error_pages";

type SiteRow = typeof schema.site.$inferSelect;
type PageRow = typeof schema.siteErrorPage.$inferSelect;

/** Refuses a template over 64 KiB of UTF-8 with the page's status. */
function assertTemplateSize(status: number, template: string) {
  if (utf8Bytes(template) > ERROR_PAGE_MAX_BYTES)
    fail(
      "ERROR_PAGE_TOO_LARGE",
      `the ${status} error page is larger than ${ERROR_PAGE_MAX_BYTES} bytes`,
      { status, limit: ERROR_PAGE_MAX_BYTES },
    );
}

const toPage = (row: Pick<PageRow, "status" | "template">): ErrorPage => ({
  status: row.status as ErrorPageStatus,
  template: row.template,
});

/** The error pages of the given sites, sorted by status (sites without pages are absent). */
export async function loadSiteErrorPages(
  db: Executor,
  siteIds: string[],
): Promise<Map<string, ErrorPage[]>> {
  const rows = siteIds.length
    ? await db
        .select()
        .from(schema.siteErrorPage)
        .where(inArray(schema.siteErrorPage.siteId, siteIds))
        .orderBy(asc(schema.siteErrorPage.status))
    : [];
  const pages = new Map<string, ErrorPage[]>();
  for (const row of rows) pages.set(row.siteId, [...(pages.get(row.siteId) ?? []), toPage(row)]);
  return pages;
}

function toDto(site: SiteRow, pages: ErrorPage[]): SiteErrorPages {
  return {
    siteId: site.id,
    pages,
    interceptOriginErrors: site.interceptOriginErrors,
    updatedAt: site.errorPagesUpdatedAt?.toISOString() ?? null,
  };
}

export async function getSiteErrorPages(db: Database, siteId: string): Promise<SiteErrorPages> {
  const site = await findSite(db, siteId);
  return toDto(site, (await loadSiteErrorPages(db, [site.id])).get(site.id) ?? []);
}

/**
 * Replaces a site's error pages, publishes its cluster and audits the
 * change. Pages on a cluster whose active nodes lack error-pages-v1 fail
 * with NODE_CAPABILITY_REQUIRED unless the operator saves them
 * (insertRevision). Templates over 64 KiB of UTF-8 fail with
 * ERROR_PAGE_TOO_LARGE.
 */
export async function updateSiteErrorPages(
  db: Database,
  input: SiteErrorPagesInput,
  ctx: { actor: Actor },
): Promise<SiteErrorPages> {
  for (const page of input.pages) assertTemplateSize(page.status, page.template);
  return db.transaction(async (tx) => {
    const site = await findSite(tx, input.id, true);
    if (input.expectedUpdatedAt !== undefined) {
      if (!site.errorPagesUpdatedAt)
        fail("UPDATED_AT_MISMATCH", "the error pages changed since they were read", {
          updatedAt: "",
        });
      assertUpdatedAt(site.errorPagesUpdatedAt, input.expectedUpdatedAt);
    }
    const before = (await loadSiteErrorPages(tx, [site.id])).get(site.id) ?? [];
    const pages = [...input.pages].sort((a, b) => a.status - b.status);
    const updatedAt = new Date(
      Math.max(Date.now(), (site.errorPagesUpdatedAt?.getTime() ?? 0) + 1),
    );
    await tx.delete(schema.siteErrorPage).where(eq(schema.siteErrorPage.siteId, site.id));
    if (pages.length)
      await tx
        .insert(schema.siteErrorPage)
        .values(pages.map((page) => ({ siteId: site.id, ...page, updatedAt })));
    const [updated] = await tx
      .update(schema.site)
      .set({ interceptOriginErrors: input.interceptOriginErrors, errorPagesUpdatedAt: updatedAt })
      .where(eq(schema.site.id, site.id))
      .returning();
    if (!updated) throw new Error("site update failed");
    const { row: revision } = await publishRevision(tx, {
      clusterId: site.clusterId,
      reason: { code: "site_error_pages_updated", params: { site: site.name } },
      actor: ctx.actor,
    });
    const template = (list: ErrorPage[], status: number) =>
      list.find((page) => page.status === status)?.template;
    const statuses = [...new Set([...before, ...pages].map((page) => page.status))].sort(
      (a, b) => a - b,
    );
    await recordAudit(tx, ctx.actor, {
      action: "site.error_pages_update",
      targetType: "site",
      targetId: site.id,
      targetName: site.name,
      // Template sizes rather than the templates (up to 320 KiB).
      metadata: {
        from: {
          statuses: before.map((page) => page.status),
          interceptOriginErrors: site.interceptOriginErrors,
        },
        to: {
          statuses: pages.map((page) => page.status),
          interceptOriginErrors: input.interceptOriginErrors,
        },
        changed: statuses.filter((status) => template(before, status) !== template(pages, status)),
        bytes: Object.fromEntries(pages.map((page) => [page.status, utf8Bytes(page.template)])),
        revision: revision.revision,
      },
    });
    return toDto(updated, pages);
  });
}

const errorPagesSetting = defineSetting({
  key: ERROR_PAGES_KEY,
  schema: platformErrorPages,
  defaults: platformErrorPages.parse({}),
  auditAction: "system.error_pages_update",
  targetName: ERROR_PAGES_KEY,
});

/** The platform's pages; empty templates mean the nodes' built-in pages. */
export const getPlatformErrorPages = errorPagesSetting.read;

/** The platform's pages as every cluster's configuration carries them (current, also on rollback). */
export async function loadPlatformErrorPages(db: Executor): Promise<PlatformErrorPagesModel> {
  return getPlatformErrorPages(db);
}

const PLATFORM_PAGES = ["unknownHost", "siteDisabled"] as const;

/**
 * Replaces the platform's pages, publishes every cluster (reason
 * error_pages_updated) and audits the change, in one transaction. The pages
 * need no node feature (nodes without error pages keep their built-in ones)
 * unless they use {{time}} or {{path}}, which need rules-v3.
 */
export async function setPlatformErrorPages(
  db: Database,
  input: PlatformErrorPages,
  actor: Actor,
): Promise<PlatformErrorPages> {
  for (const key of PLATFORM_PAGES)
    assertTemplateSize(PLATFORM_ERROR_PAGE_STATUSES[key], input[key]);
  return db.transaction(async (tx) => {
    await lockPlatformErrorPages(tx);
    const before = await getPlatformErrorPages(tx);
    return errorPagesSetting.write(tx, actor, input, {
      before,
      afterWrite: async () => {
        const clusters = await tx
          .select({ id: schema.cluster.id, name: schema.cluster.name })
          .from(schema.cluster);
        const published = await publishClusters(
          tx,
          clusters.map((c) => c.id),
          { reason: { code: "error_pages_updated", params: {} }, actor },
        );
        const revisions: Record<string, number> = {};
        for (const cluster of clusters)
          revisions[cluster.name] = published.get(cluster.id)?.row.revision ?? 0;
        return { revisions };
      },
      metadata: () => ({
        changed: PLATFORM_PAGES.filter((key) => before[key] !== input[key]),
        bytes: Object.fromEntries(PLATFORM_PAGES.map((key) => [key, utf8Bytes(input[key])])),
      }),
    });
  });
}
