import {
  banLookupCidr,
  GREYLIST_FEATURE,
  type GreylistAction,
  type GreylistCreateInput,
  type GreylistEntry,
  type GreylistList,
  type GreylistListInput,
  nodeSupportsFeature,
  protectedBanOverlap,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, count, desc, eq, ne, or, sql } from "drizzle-orm";
import { fail } from "../lib/errors";
import { lockBans } from "../lib/locks";
import { type Actor, recordAudit } from "./audit";
import {
  active,
  banTarget,
  checkDuration,
  getBanSettings,
  nextSeq,
  notifyBans,
  protectedAddresses,
  unappliedCounts,
} from "./bans";
import { type Executor, publishClusters, type Tx } from "./revisions";
import { findSite } from "./sites";

/**
 * The IP greylist (ADR in the console's development records): rows of
 * ip_ban whose action is challenge or rate_limit. They share the bans'
 * sequence, lock, delivery (GetBans, only to nodes that ask for greylist
 * entries), retention and platform total of manual entries; a ban of the
 * same CIDR is a separate row and wins on the nodes while both last.
 */

type Row = typeof schema.ipBan.$inferSelect;

const isGrey = () => ne(schema.ipBan.action, "block");

function actionOf(row: Row): GreylistAction {
  return row.action === "rate_limit"
    ? {
        kind: "rate_limit",
        requests: row.rateLimitRequests ?? 0,
        windowSeconds: row.rateLimitWindowSeconds ?? 0,
      }
    : { kind: "challenge", challenge: (row.challenge ?? "js") as "js" };
}

function actionColumns(action: GreylistAction) {
  return action.kind === "challenge"
    ? {
        action: "challenge",
        challenge: action.challenge,
        rateLimitRequests: null,
        rateLimitWindowSeconds: null,
      }
    : {
        action: "rate_limit",
        challenge: null,
        rateLimitRequests: action.requests,
        rateLimitWindowSeconds: action.windowSeconds,
      };
}

async function toEntries(
  db: Executor,
  where: ReturnType<typeof and>,
  page?: [number, number],
): Promise<GreylistEntry[]> {
  const query = db
    .select({ row: schema.ipBan, siteName: schema.site.name })
    .from(schema.ipBan)
    .leftJoin(schema.site, eq(schema.site.id, schema.ipBan.siteId))
    .where(where)
    .orderBy(desc(schema.ipBan.createdAt), desc(schema.ipBan.seq));
  const rows = page ? await query.limit(page[1]).offset((page[0] - 1) * page[1]) : await query;
  const unapplied = await unappliedCounts(
    db,
    rows.map((r) => r.row.id),
  );
  return rows.map(({ row, siteName }) => ({
    id: row.id,
    scope: row.scope as GreylistEntry["scope"],
    cidr: row.cidr,
    reason: row.reason as GreylistEntry["reason"],
    siteId: row.siteId,
    siteName: siteName ?? null,
    action: actionOf(row),
    createdBy: row.createdBy ?? null,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    unappliedNodes: unapplied.get(row.id) ?? 0,
  }));
}

/** Active nodes that do not ask for greylist entries. */
async function unsupportedNodes(db: Executor): Promise<number> {
  const nodes = await db
    .select({ features: schema.node.supportedFeatures })
    .from(schema.node)
    .where(eq(schema.node.status, "active"));
  return nodes.filter((n) => !nodeSupportsFeature(n.features, GREYLIST_FEATURE)).length;
}

/** Active entries, newest first. */
export async function listGreylist(
  db: Database,
  input: GreylistListInput,
  now = new Date(),
): Promise<GreylistList> {
  const filters = [active(now), isGrey()];
  if (input.siteId) filters.push(eq(schema.ipBan.siteId, input.siteId));
  if (input.scope) filters.push(eq(schema.ipBan.scope, input.scope));
  if (input.address !== undefined) {
    const address = banLookupCidr(input.address);
    if (!address) fail("BAN_INVALID_CIDR", "invalid IP address or CIDR");
    filters.push(sql`${schema.ipBan.cidr}::inet && ${address}::inet`);
  }
  const where = and(...filters);
  const [total] = await db.select({ n: count() }).from(schema.ipBan).where(where);
  return {
    items: await toEntries(db, where, [input.page, input.pageSize]),
    total: total?.n ?? 0,
    unsupportedNodes: await unsupportedNodes(db),
  };
}

/**
 * Whether the cluster has active greylist entries that challenge: platform
 * ones or of its sites. Its configuration then carries challenge keys.
 */
export async function greylistChallenges(
  db: Executor,
  clusterId: string,
  now = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({ id: schema.ipBan.id })
    .from(schema.ipBan)
    .where(
      and(
        active(now),
        eq(schema.ipBan.action, "challenge"),
        or(eq(schema.ipBan.scope, "platform"), eq(schema.ipBan.clusterId, clusterId)),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Challenges need the cluster's keys: publishes the clusters an entry
 * applies to (every cluster for a platform entry). Clusters whose
 * configuration already carries keys get no new revision.
 */
async function publishForChallenge(tx: Tx, clusterId: string | null, actor: Actor) {
  const ids = clusterId
    ? [clusterId]
    : (await tx.select({ id: schema.cluster.id }).from(schema.cluster)).map((c) => c.id);
  await publishClusters(tx, ids, { reason: { code: "greylist_challenge", params: {} }, actor });
}

/**
 * Greylists an address or prefix, or greylists the same (scope, site, CIDR)
 * again: that sets the new action, reason and expiry and takes a new
 * sequence number. Entries share the bans' bounds and protected addresses,
 * and count against the platform total of manual bans.
 */
export async function createGreylistEntry(
  db: Database,
  input: GreylistCreateInput,
  ctx: { actor: Actor },
): Promise<GreylistEntry> {
  const target = banTarget(input.cidr);
  checkDuration(input.durationSeconds);
  const id = await db.transaction(async (tx) => {
    const site = input.scope === "site" ? await findSite(tx, input.siteId ?? "") : undefined;
    const covered = protectedBanOverlap(
      target.cidr,
      await protectedAddresses(tx, site?.clusterId ?? null),
    );
    if (covered)
      fail("BAN_PROTECTED_ADDRESS", `the entry covers the protected address ${covered}`, {
        address: covered,
      });
    await lockBans(tx, "exclusive");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.durationSeconds * 1000);
    const [existing] = await tx
      .select()
      .from(schema.ipBan)
      .where(
        and(
          eq(schema.ipBan.cidr, target.text),
          isGrey(),
          active(now),
          site
            ? and(eq(schema.ipBan.scope, "site"), eq(schema.ipBan.siteId, site.id))
            : eq(schema.ipBan.scope, "platform"),
        ),
      )
      .for("update");
    if (!existing) {
      const { maxTotal } = await getBanSettings(tx);
      const [total] = await tx
        .select({ n: count() })
        .from(schema.ipBan)
        .where(and(eq(schema.ipBan.source, "manual"), active(now)));
      if ((total?.n ?? 0) >= maxTotal)
        fail("BAN_PLATFORM_LIMIT", `the platform holds at most ${maxTotal} bans`, {
          limit: maxTotal,
        });
    }
    // An expired entry not yet pruned would block the unique index: it goes.
    await tx
      .delete(schema.ipBan)
      .where(
        and(
          eq(schema.ipBan.cidr, target.text),
          isGrey(),
          sql`${schema.ipBan.removedAt} is null and ${schema.ipBan.expiresAt} <= ${now.toISOString()}::timestamptz`,
          site
            ? and(eq(schema.ipBan.scope, "site"), eq(schema.ipBan.siteId, site.id))
            : eq(schema.ipBan.scope, "platform"),
        ),
      );
    const seq = await nextSeq(tx);
    const columns = actionColumns(input.action);
    const createdBy = { type: ctx.actor.type, id: ctx.actor.id, name: ctx.actor.name ?? "" };
    const [row] = existing
      ? await tx
          .update(schema.ipBan)
          .set({ reason: input.reason, expiresAt, seq, ...columns })
          .where(eq(schema.ipBan.id, existing.id))
          .returning()
      : await tx
          .insert(schema.ipBan)
          .values({
            scope: site ? "site" : "platform",
            siteId: site?.id ?? null,
            clusterId: site?.clusterId ?? null,
            cidr: target.text,
            reason: input.reason,
            source: "manual",
            createdBy,
            createdAt: now,
            expiresAt,
            seq,
            distributed: true,
            ...columns,
          })
          .returning();
    if (!row) throw new Error("greylist write failed");
    if (input.action.kind === "challenge")
      await publishForChallenge(tx, site?.clusterId ?? null, ctx.actor);
    await notifyBans(tx, site ? [site.clusterId] : null);
    await recordAudit(tx, ctx.actor, {
      action: existing ? "greylist.update" : "greylist.create",
      targetType: "greylist",
      targetId: row.id,
      targetName: row.cidr,
      metadata: {
        scope: row.scope,
        siteId: row.siteId,
        siteName: site?.name ?? "",
        cidr: row.cidr,
        reason: row.reason,
        action: actionOf(row),
        expiresAt: row.expiresAt.toISOString(),
        seq: row.seq.toString(),
        ...(existing
          ? {
              previousAction: actionOf(existing),
              previousExpiresAt: existing.expiresAt.toISOString(),
            }
          : {}),
      },
    });
    return row.id;
  });
  const [entry] = await toEntries(db, eq(schema.ipBan.id, id));
  if (!entry) throw new Error("greylist entry vanished");
  return entry;
}

/** Lifts an active entry before it expires. */
export async function deleteGreylistEntry(db: Database, id: string, ctx: { actor: Actor }) {
  await db.transaction(async (tx) => {
    await lockBans(tx, "exclusive");
    const now = new Date();
    const [row] = await tx
      .select()
      .from(schema.ipBan)
      .where(and(eq(schema.ipBan.id, id), active(now), isGrey()))
      .for("update");
    if (!row) fail("BAN_NOT_FOUND", "greylist entry not found");
    const seq = await nextSeq(tx);
    await tx.update(schema.ipBan).set({ removedAt: now, seq }).where(eq(schema.ipBan.id, id));
    await notifyBans(tx, row.clusterId ? [row.clusterId] : null);
    const [site] = row.siteId
      ? await tx
          .select({ name: schema.site.name })
          .from(schema.site)
          .where(eq(schema.site.id, row.siteId))
      : [];
    await recordAudit(tx, ctx.actor, {
      action: "greylist.delete",
      targetType: "greylist",
      targetId: row.id,
      targetName: row.cidr,
      metadata: {
        scope: row.scope,
        siteId: row.siteId,
        siteName: site?.name ?? "",
        cidr: row.cidr,
        reason: row.reason,
        action: actionOf(row),
        seq: seq.toString(),
      },
    });
  });
  return { ok: true as const };
}
