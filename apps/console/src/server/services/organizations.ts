import type { Organization } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { asc, count, eq, inArray } from "drizzle-orm";
import { fail } from "../lib/errors";
import { assertUpdatedAt } from "../lib/updated-at";
import { type Actor, recordAudit } from "./audit";
import { findOrganization, newId } from "./members";
import type { Executor } from "./revisions";
import { slugify } from "./setup";

type OrgRow = typeof schema.organization.$inferSelect;

export async function organizationSettings(db: Executor, organizationId: string) {
  const [row] = await db
    .select()
    .from(schema.organizationSettings)
    .where(eq(schema.organizationSettings.organizationId, organizationId));
  return {
    defaultClusterId: row?.defaultClusterId ?? null,
    requireTwoFactor: row?.requireTwoFactor ?? false,
  };
}

async function toDtos(db: Executor, rows: OrgRow[]): Promise<Organization[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  // Sequential on purpose: `db` may be a transaction, i.e. a single connection.
  const members = await db
    .select({ organizationId: schema.member.organizationId, n: count() })
    .from(schema.member)
    .where(inArray(schema.member.organizationId, ids))
    .groupBy(schema.member.organizationId);
  const sites = await db
    .select({ organizationId: schema.site.organizationId, n: count() })
    .from(schema.site)
    .where(inArray(schema.site.organizationId, ids))
    .groupBy(schema.site.organizationId);
  const settings = await db
    .select({
      organizationId: schema.organizationSettings.organizationId,
      defaultClusterId: schema.organizationSettings.defaultClusterId,
      defaultClusterName: schema.cluster.name,
      requireTwoFactor: schema.organizationSettings.requireTwoFactor,
      updatedAt: schema.organizationSettings.updatedAt,
    })
    .from(schema.organizationSettings)
    .leftJoin(schema.cluster, eq(schema.cluster.id, schema.organizationSettings.defaultClusterId))
    .where(inArray(schema.organizationSettings.organizationId, ids));
  return rows.map((r) => {
    const s = settings.find((x) => x.organizationId === r.id);
    return {
      id: r.id,
      name: r.name,
      slug: r.slug,
      memberCount: members.find((m) => m.organizationId === r.id)?.n ?? 0,
      siteCount: sites.find((m) => m.organizationId === r.id)?.n ?? 0,
      defaultClusterId: s?.defaultClusterId ?? null,
      defaultClusterName: s?.defaultClusterName ?? null,
      requireTwoFactor: s?.requireTwoFactor ?? false,
      createdAt: r.createdAt.toISOString(),
      updatedAt: (s?.updatedAt ?? r.createdAt).toISOString(),
    };
  });
}

export async function listOrganizations(db: Database): Promise<Organization[]> {
  const rows = await db
    .select()
    .from(schema.organization)
    .orderBy(asc(schema.organization.createdAt));
  return toDtos(db, rows);
}

async function assertCluster(db: Executor, clusterId: string | null | undefined) {
  if (!clusterId) return;
  const [row] = await db
    .select({ id: schema.cluster.id })
    .from(schema.cluster)
    .where(eq(schema.cluster.id, clusterId));
  if (!row) fail("CLUSTER_NOT_FOUND", "cluster not found");
}

/** Creates a tenant organization; members are added separately (users or invitations). */
export async function createOrganization(
  db: Database,
  input: { name: string; slug?: string; defaultClusterId: string | null },
  actor: Actor,
): Promise<Organization> {
  const row = await db.transaction(async (tx) => {
    const slug = input.slug ?? slugify(input.name);
    const [taken] = await tx
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.slug, slug));
    if (taken)
      fail("ORGANIZATION_SLUG_TAKEN", `organization slug already exists: ${slug}`, { slug });
    await assertCluster(tx, input.defaultClusterId);
    const [created] = await tx
      .insert(schema.organization)
      .values({ id: newId(), name: input.name, slug, createdAt: new Date() })
      .returning();
    if (!created) throw new Error("organization insert failed");
    await tx
      .insert(schema.organizationSettings)
      .values({ organizationId: created.id, defaultClusterId: input.defaultClusterId });
    await recordAudit(tx, actor, {
      action: "organization.create",
      organizationId: created.id,
      targetType: "organization",
      targetId: created.id,
      targetName: created.name,
      metadata: { slug, defaultClusterId: input.defaultClusterId },
    });
    return created;
  });
  const [dto] = await toDtos(db, [row]);
  if (!dto) throw new Error("organization not readable");
  return dto;
}

/** Updates an organization's name and policy (default cluster, required 2FA). */
export async function updateOrganization(
  db: Database,
  input: {
    id: string;
    name?: string;
    defaultClusterId?: string | null;
    requireTwoFactor?: boolean;
    expectedUpdatedAt?: string;
  },
  actor: Actor,
): Promise<Organization> {
  const row = await db.transaction(async (tx) => {
    const before = await findOrganization(tx, input.id);
    // organization_settings.updated_at versions the whole organization.
    const [settings] = await tx
      .select({ updatedAt: schema.organizationSettings.updatedAt })
      .from(schema.organizationSettings)
      .where(eq(schema.organizationSettings.organizationId, input.id))
      .for("update");
    const version = settings?.updatedAt ?? before.createdAt;
    assertUpdatedAt(version, input.expectedUpdatedAt);
    await assertCluster(tx, input.defaultClusterId);
    if (input.name !== undefined) {
      await tx
        .update(schema.organization)
        .set({ name: input.name })
        .where(eq(schema.organization.id, input.id));
    }
    const policy = {
      ...(input.defaultClusterId !== undefined ? { defaultClusterId: input.defaultClusterId } : {}),
      ...(input.requireTwoFactor !== undefined ? { requireTwoFactor: input.requireTwoFactor } : {}),
      // Strictly later than the version the caller read, even within the same millisecond.
      updatedAt: new Date(Math.max(Date.now(), version.getTime() + 1)),
    };
    await tx
      .insert(schema.organizationSettings)
      .values({ organizationId: input.id, ...policy })
      .onConflictDoUpdate({ target: schema.organizationSettings.organizationId, set: policy });
    await recordAudit(tx, actor, {
      action: "organization.update",
      organizationId: input.id,
      targetType: "organization",
      targetId: input.id,
      targetName: input.name ?? before.name,
      metadata: {
        from: { name: before.name },
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.defaultClusterId !== undefined
          ? { defaultClusterId: input.defaultClusterId }
          : {}),
        ...(input.requireTwoFactor !== undefined
          ? { requireTwoFactor: input.requireTwoFactor }
          : {}),
      },
    });
    return findOrganization(tx, input.id);
  });
  const [dto] = await toDtos(db, [row]);
  if (!dto) throw new Error("organization not readable");
  return dto;
}
