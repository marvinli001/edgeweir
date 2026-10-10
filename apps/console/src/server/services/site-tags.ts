import {
  type BatchResult,
  type BatchTagsInput,
  MAX_SITE_TAGS,
  type SiteTag,
  type SiteTagRef,
  tagKey,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";
import { fail } from "../lib/errors";
import { lockTags } from "../lib/locks";
import { type Actor, recordAudit } from "./audit";
import type { Executor, Tx } from "./revisions";
import { shareSites } from "./sites";

/** The tags of each site, by name (case-insensitively). */
export async function siteTagRefs(
  db: Executor,
  siteIds: readonly string[],
): Promise<Map<string, SiteTagRef[]>> {
  const tags = new Map<string, SiteTagRef[]>();
  if (!siteIds.length) return tags;
  const rows = await db
    .select({ siteId: schema.siteTag.siteId, id: schema.tag.id, name: schema.tag.name })
    .from(schema.siteTag)
    .innerJoin(schema.tag, eq(schema.tag.id, schema.siteTag.tagId))
    .where(inArray(schema.siteTag.siteId, [...siteIds]))
    .orderBy(asc(schema.tag.key), asc(schema.tag.id));
  for (const row of rows)
    tags.set(row.siteId, [...(tags.get(row.siteId) ?? []), { id: row.id, name: row.name }]);
  return tags;
}

/**
 * The tags of the names, by key, creating those that do not exist yet
 * (named as first written). The caller holds lockTags.
 */
async function ensureTags(tx: Tx, names: readonly string[]): Promise<Map<string, SiteTagRef>> {
  const byKey = new Map(names.map((name) => [tagKey(name), name.normalize("NFC").trim()]));
  if (!byKey.size) return new Map();
  await tx
    .insert(schema.tag)
    .values([...byKey].map(([key, name]) => ({ key, name })))
    .onConflictDoNothing({ target: schema.tag.key });
  const rows = await tx
    .select({ id: schema.tag.id, name: schema.tag.name, key: schema.tag.key })
    .from(schema.tag)
    .where(inArray(schema.tag.key, [...byKey.keys()]));
  return new Map(rows.map((row) => [row.key, { id: row.id, name: row.name }]));
}

const names = (tags: readonly SiteTagRef[]) => tags.map((tag) => tag.name);

/**
 * Sets the tags of sites to `next(current, tags)` (`tags`: the tags of the
 * `wanted` names, created when new), in one transaction with
 * lockTags held: every site must exist (SITE_NOT_FOUND) and keep at most 10
 * tags (SITE_TAG_LIMIT). Each site whose tags change is audited
 * (site.tags_update); tags are not published (nodes never see them).
 */
export async function writeSiteTags(
  tx: Tx,
  actor: Actor,
  change: {
    siteIds: readonly string[];
    wanted: readonly string[];
    next: (current: SiteTagRef[], tags: Map<string, SiteTagRef>) => SiteTagRef[];
    /** Added to each audit entry; null writes none (a site created in the transaction). */
    metadata?: Record<string, unknown> | null;
  },
): Promise<{ changed: { id: string; name: string }[]; tags: Map<string, SiteTagRef[]> }> {
  const { siteIds, wanted, next, metadata = {} } = change;
  await lockTags(tx);
  const ids = [...new Set(siteIds)];
  const live = await shareSites(tx, ids);
  if (ids.some((id) => !live.has(id))) fail("SITE_NOT_FOUND", "site not found");
  const sites = await tx
    .select({ id: schema.site.id, name: schema.site.name })
    .from(schema.site)
    .where(inArray(schema.site.id, ids))
    .orderBy(asc(schema.site.createdAt), asc(schema.site.id));
  const tags = await ensureTags(tx, wanted);
  const current = await siteTagRefs(tx, ids);
  const result = new Map<string, SiteTagRef[]>();
  const changed: { id: string; name: string }[] = [];
  for (const site of sites) {
    const before = current.get(site.id) ?? [];
    const after = next(before, tags);
    if (after.length > MAX_SITE_TAGS)
      fail("SITE_TAG_LIMIT", `site ${site.name} would have more than ${MAX_SITE_TAGS} tags`, {
        site: site.name,
        limit: MAX_SITE_TAGS,
      });
    const keep = new Set(after.map((tag) => tag.id));
    const had = new Set(before.map((tag) => tag.id));
    const removed = before.filter((tag) => !keep.has(tag.id));
    const added = after.filter((tag) => !had.has(tag.id));
    result.set(
      site.id,
      [...after].sort((a, b) => tagKey(a.name).localeCompare(tagKey(b.name))),
    );
    if (!removed.length && !added.length) continue;
    if (removed.length)
      await tx.delete(schema.siteTag).where(
        and(
          eq(schema.siteTag.siteId, site.id),
          inArray(
            schema.siteTag.tagId,
            removed.map((tag) => tag.id),
          ),
        ),
      );
    if (added.length)
      await tx
        .insert(schema.siteTag)
        .values(added.map((tag) => ({ siteId: site.id, tagId: tag.id })))
        .onConflictDoNothing();
    changed.push(site);
    if (metadata)
      await recordAudit(tx, actor, {
        action: "site.tags_update",
        targetType: "site",
        targetId: site.id,
        targetName: site.name,
        metadata: {
          ...metadata,
          added: names(added),
          removed: names(removed),
          tags: names(after),
        },
      });
  }
  return { changed, tags: result };
}

/** Replaces a site's tags. */
export async function setSiteTags(
  db: Database,
  input: { id: string; tags: string[] },
  actor: Actor,
): Promise<{ tags: SiteTagRef[] }> {
  return db.transaction(async (tx) => {
    const { tags } = await writeSiteTags(tx, actor, {
      siteIds: [input.id],
      wanted: input.tags,
      next: (_current, byKey) => input.tags.flatMap((name) => byKey.get(tagKey(name)) ?? []),
    });
    return { tags: tags.get(input.id) ?? [] };
  });
}

/** Adds and removes tags on sites (batch); nothing is published. */
export async function batchSiteTags(
  db: Database,
  input: BatchTagsInput,
  actor: Actor,
): Promise<BatchResult> {
  return db.transaction(async (tx) => {
    const removed = new Set(input.remove.map(tagKey));
    const { changed } = await writeSiteTags(tx, actor, {
      siteIds: input.ids,
      wanted: input.add,
      next: (current, byKey) => {
        const kept = current.filter((tag) => !removed.has(tagKey(tag.name)));
        const added = input.add
          .map((name) => byKey.get(tagKey(name)))
          .filter((tag): tag is SiteTagRef => !!tag && !kept.some((other) => other.id === tag.id));
        return [...kept, ...added];
      },
      metadata: { batch: input.ids.length },
    });
    return { changed, revisions: [] };
  });
}

/** Every tag with the number of its sites, by name. */
export async function listSiteTags(db: Database): Promise<SiteTag[]> {
  const rows = await db
    .select({ id: schema.tag.id, name: schema.tag.name, sites: count(schema.siteTag.siteId) })
    .from(schema.tag)
    .leftJoin(schema.siteTag, eq(schema.siteTag.tagId, schema.tag.id))
    .groupBy(schema.tag.id)
    .orderBy(asc(schema.tag.key), asc(schema.tag.id));
  return rows.map((row) => ({ id: row.id, name: row.name, sites: Number(row.sites) }));
}

async function findTag(tx: Executor, id: string) {
  const [row] = await tx.select().from(schema.tag).where(eq(schema.tag.id, id)).for("update");
  if (!row) fail("SITE_TAG_NOT_FOUND", "tag not found");
  return row;
}

/**
 * Locks a tag's site_tag rows in site id order before the tag goes: deleting
 * sites (one by one, in id order) removes their rows in that order too, while
 * the tag's cascade would take them in index order.
 */
async function lockTagSites(tx: Executor, id: string): Promise<string[]> {
  const rows = await tx
    .select({ siteId: schema.siteTag.siteId })
    .from(schema.siteTag)
    .where(eq(schema.siteTag.tagId, id))
    .orderBy(asc(schema.siteTag.siteId))
    .for("update");
  return rows.map((row) => row.siteId);
}

async function tagSites(tx: Executor, id: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(schema.siteTag)
    .where(eq(schema.siteTag.tagId, id));
  return Number(row?.n ?? 0);
}

/**
 * Renames a tag. When another tag has the name (any case) the two merge:
 * this tag's sites get the other one, named as given, and this tag goes.
 */
export async function renameSiteTag(
  db: Database,
  input: { id: string; name: string },
  actor: Actor,
): Promise<SiteTag> {
  return db.transaction(async (tx) => {
    await lockTags(tx);
    const row = await findTag(tx, input.id);
    const key = tagKey(input.name);
    const [other] = await tx
      .select()
      .from(schema.tag)
      .where(and(eq(schema.tag.key, key), ne(schema.tag.id, row.id)))
      .for("update");
    if (!other) {
      await tx.update(schema.tag).set({ name: input.name, key }).where(eq(schema.tag.id, row.id));
      if (row.name !== input.name)
        await recordAudit(tx, actor, {
          action: "site_tag.rename",
          targetType: "site_tag",
          targetId: row.id,
          targetName: input.name,
          metadata: { from: row.name, to: input.name },
        });
      return { id: row.id, name: input.name, sites: await tagSites(tx, row.id) };
    }
    // The sites keep existing until the transaction ends (in id order, as every site writer).
    const live = await shareSites(tx, await lockTagSites(tx, row.id));
    if (live.size)
      await tx
        .insert(schema.siteTag)
        .values([...live].map((siteId) => ({ siteId, tagId: other.id })))
        .onConflictDoNothing();
    await tx.delete(schema.tag).where(eq(schema.tag.id, row.id));
    await tx.update(schema.tag).set({ name: input.name }).where(eq(schema.tag.id, other.id));
    await recordAudit(tx, actor, {
      action: "site_tag.rename",
      targetType: "site_tag",
      targetId: other.id,
      targetName: input.name,
      metadata: { from: row.name, to: input.name, mergedInto: other.name, sites: live.size },
    });
    return { id: other.id, name: input.name, sites: await tagSites(tx, other.id) };
  });
}

/** Deletes a tag: no site carries it any more. */
export async function deleteSiteTag(db: Database, id: string, actor: Actor) {
  return db.transaction(async (tx) => {
    await lockTags(tx);
    const row = await findTag(tx, id);
    const sites = (await lockTagSites(tx, row.id)).length;
    await tx.delete(schema.tag).where(eq(schema.tag.id, row.id));
    await recordAudit(tx, actor, {
      action: "site_tag.delete",
      targetType: "site_tag",
      targetId: row.id,
      targetName: row.name,
      metadata: { sites },
    });
    return { ok: true as const };
  });
}

/** Sites with any (or all) of the tags: a filter of the site list. */
export function sitesWithTags(tagIds: readonly string[], match: "any" | "all") {
  const ids = sql.join(
    tagIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const matching = sql`select count(distinct ${schema.siteTag.tagId}) from ${schema.siteTag} where ${schema.siteTag.siteId} = ${schema.site.id} and ${schema.siteTag.tagId} in (${ids})`;
  return match === "all" ? sql`(${matching}) = ${new Set(tagIds).size}` : sql`(${matching}) > 0`;
}
