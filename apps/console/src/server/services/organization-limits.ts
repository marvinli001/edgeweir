import type { OrganizationLimits, OrgLimitResource } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { fail } from "../lib/errors";
import { assertUpdatedAt } from "../lib/updated-at";
import { type Actor, recordAudit } from "./audit";
import { findOrganization } from "./members";
import type { Executor } from "./revisions";

type Limits = OrganizationLimits["limits"];
type LimitRow = typeof schema.organizationLimit.$inferSelect;

const COLUMNS = {
  sites: "maxSites",
  domains: "maxDomains",
  certificates: "maxCertificates",
  ipListEntries: "maxIpListEntries",
  purgeTasksPerMinute: "maxPurgeTasksPerMinute",
  purgeUrlsPerHour: "maxPurgeUrlsPerHour",
  members: "maxMembers",
  bans: "maxBans",
} as const satisfies Record<OrgLimitResource, keyof LimitRow>;

const RESOURCES = Object.keys(COLUMNS) as OrgLimitResource[];

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

function toLimits(row: LimitRow | undefined): Limits {
  return Object.fromEntries(RESOURCES.map((r) => [r, row?.[COLUMNS[r]] ?? null])) as Limits;
}

export async function loadOrganizationLimits(
  db: Executor,
  organizationId: string,
): Promise<{ limits: Limits; updatedAt: Date | null }> {
  const [row] = await db
    .select()
    .from(schema.organizationLimit)
    .where(eq(schema.organizationLimit.organizationId, organizationId));
  return { limits: toLimits(row), updatedAt: row?.updatedAt ?? null };
}

/**
 * Serializes resource creation per organization for the rest of the
 * transaction, so that concurrent creations are counted one after another.
 * Take it before any other lock the transaction needs (domain roots, publish).
 */
export async function lockOrganization(tx: Executor, organizationId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`edgeweir.org-limit.${organizationId}`}))`,
  );
}

/**
 * User-requested purges and prefetches of the last hour (URLs) and minute
 * (tasks). A task counts its targets, a tag purge one per (site, tag) pair.
 */
export async function recentPurges(tx: Executor, organizationId: string, now: Date) {
  const recent = await tx
    .select({
      createdAt: schema.cacheTask.createdAt,
      targets: sql<number>`case when ${schema.cacheTask.type} = 'tag'
        then cardinality(${schema.cacheTask.targets}) * cardinality(${schema.cacheTask.siteIds})
        else cardinality(${schema.cacheTask.targets}) end`.mapWith(Number),
    })
    .from(schema.cacheTask)
    .where(
      and(
        eq(schema.cacheTask.organizationId, organizationId),
        eq(schema.cacheTask.source, "user"),
        gt(schema.cacheTask.createdAt, new Date(now.getTime() - HOUR_MS)),
      ),
    )
    .orderBy(schema.cacheTask.createdAt);
  // The legacy site purge endpoint publishes a cache generation instead of
  // creating a typed task. Both entry points consume the same quota.
  const legacy = await tx
    .select({ createdAt: schema.auditLog.occurredAt })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.organizationId, organizationId),
        eq(schema.auditLog.action, "site.purge_all"),
        sql`${schema.auditLog.metadata}->>'quotaLimited' = 'true'`,
        gt(schema.auditLog.occurredAt, new Date(now.getTime() - HOUR_MS)),
      ),
    );
  recent.push(...legacy.map((row) => ({ ...row, targets: 1 })));
  recent.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return recent;
}

async function usageOf(
  db: Executor,
  organizationId: string,
  resource: OrgLimitResource,
  now: Date,
): Promise<number> {
  const org = organizationId;
  switch (resource) {
    case "sites": {
      const [row] = await db
        .select({ n: count() })
        .from(schema.site)
        .where(eq(schema.site.organizationId, org));
      return row?.n ?? 0;
    }
    case "domains": {
      const [row] = await db
        .select({ n: count() })
        .from(schema.siteDomain)
        .innerJoin(schema.site, eq(schema.site.id, schema.siteDomain.siteId))
        .where(eq(schema.site.organizationId, org));
      return row?.n ?? 0;
    }
    case "certificates": {
      const [row] = await db
        .select({ n: count() })
        .from(schema.certificate)
        .where(eq(schema.certificate.organizationId, org));
      return row?.n ?? 0;
    }
    case "ipListEntries": {
      const [row] = await db
        .select({
          n: sql<number>`coalesce(sum(cardinality(${schema.ipList.entries})), 0)`.mapWith(Number),
        })
        .from(schema.ipList)
        .where(eq(schema.ipList.organizationId, org));
      return row?.n ?? 0;
    }
    case "members": {
      const [row] = await db
        .select({ n: count() })
        .from(schema.member)
        .where(eq(schema.member.organizationId, org));
      return row?.n ?? 0;
    }
    case "bans": {
      // Active manual site bans; automatic bans are not counted.
      const [row] = await db
        .select({ n: count() })
        .from(schema.ipBan)
        .where(
          and(
            eq(schema.ipBan.organizationId, org),
            eq(schema.ipBan.scope, "site"),
            eq(schema.ipBan.source, "manual"),
            isNull(schema.ipBan.removedAt),
            gt(schema.ipBan.expiresAt, now),
          ),
        );
      return row?.n ?? 0;
    }
    case "purgeTasksPerMinute":
      return (await recentPurges(db, org, now)).filter(
        (r) => r.createdAt.getTime() > now.getTime() - MINUTE_MS,
      ).length;
    case "purgeUrlsPerHour":
      return (await recentPurges(db, org, now)).reduce((sum, r) => sum + r.targets, 0);
  }
}

/**
 * Refuses to add `adding` units of `resource` when the organization has a
 * limit for it and the result would exceed it (ORG_LIMIT_EXCEEDED with
 * resource, limit and current use). Locks the organization first: callers
 * run it inside the transaction that creates the resource. Purge limits are
 * checked by assertCacheTaskQuota.
 */
export async function assertOrgLimit(
  tx: Executor,
  organizationId: string,
  resource: Exclude<OrgLimitResource, "purgeTasksPerMinute" | "purgeUrlsPerHour">,
  adding: number,
) {
  await lockOrganization(tx, organizationId);
  if (adding <= 0) return;
  const { limits } = await loadOrganizationLimits(tx, organizationId);
  const limit = limits[resource];
  if (limit === null) return;
  const current = await usageOf(tx, organizationId, resource, new Date());
  if (current + adding > limit) orgLimitExceeded(resource, limit, current);
}

export function orgLimitExceeded(
  resource: OrgLimitResource,
  limit: number,
  current: number,
): never {
  fail("ORG_LIMIT_EXCEEDED", `organization limit reached: ${resource} ${current}/${limit}`, {
    resource,
    limit,
    current,
  });
}

export async function getOrganizationLimits(
  db: Executor,
  organizationId: string,
): Promise<OrganizationLimits> {
  await findOrganization(db, organizationId);
  const { limits, updatedAt } = await loadOrganizationLimits(db, organizationId);
  const now = new Date();
  const usage = {} as OrganizationLimits["usage"];
  // Sequential on purpose: `db` may be a transaction, i.e. a single connection.
  for (const resource of RESOURCES)
    usage[resource] = await usageOf(db, organizationId, resource, now);
  return { organizationId, limits, usage, updatedAt: updatedAt?.toISOString() ?? null };
}

/** Replaces an organization's limits; audited with the values before and after. */
export async function setOrganizationLimits(
  db: Database,
  input: { id: string; limits: Limits; expectedUpdatedAt?: string },
  actor: Actor,
): Promise<OrganizationLimits> {
  return db.transaction(async (tx) => {
    const org = await findOrganization(tx, input.id);
    await lockOrganization(tx, org.id);
    const before = await loadOrganizationLimits(tx, org.id);
    if (input.expectedUpdatedAt !== undefined) {
      if (!before.updatedAt)
        fail("UPDATED_AT_MISMATCH", "the limits changed since they were read", { updatedAt: "" });
      assertUpdatedAt(before.updatedAt, input.expectedUpdatedAt);
    }
    const values = Object.fromEntries(
      RESOURCES.map((r) => [COLUMNS[r], input.limits[r] ?? null]),
    ) as Omit<LimitRow, "organizationId" | "updatedAt">;
    const updatedAt = new Date(Math.max(Date.now(), (before.updatedAt?.getTime() ?? 0) + 1));
    await tx
      .insert(schema.organizationLimit)
      .values({ organizationId: org.id, ...values, updatedAt })
      .onConflictDoUpdate({
        target: schema.organizationLimit.organizationId,
        set: { ...values, updatedAt },
      });
    await recordAudit(tx, actor, {
      action: "organization.limits_update",
      organizationId: org.id,
      targetType: "organization",
      targetId: org.id,
      targetName: org.name,
      metadata: { from: before.limits, to: input.limits },
    });
    return getOrganizationLimits(tx, org.id);
  });
}
