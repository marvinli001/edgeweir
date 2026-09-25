import type { OrgRole, User } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { asc, eq, ilike, inArray, or } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import { addMember, parseRole } from "./members";
import type { Executor } from "./revisions";

type UserRow = typeof schema.user.$inferSelect;

export function isAdminRole(role: string | null | undefined): boolean {
  return String(role ?? "")
    .split(",")
    .map((r) => r.trim())
    .includes("admin");
}

async function toDtos(db: Executor, rows: UserRow[]): Promise<User[]> {
  if (rows.length === 0) return [];
  const memberships = await db
    .select({
      userId: schema.member.userId,
      organizationId: schema.member.organizationId,
      organizationName: schema.organization.name,
      role: schema.member.role,
    })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(
      inArray(
        schema.member.userId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(schema.organization.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    isAdmin: isAdminRole(r.role),
    disabled: r.banned === true,
    twoFactorEnabled: r.twoFactorEnabled === true,
    createdAt: r.createdAt.toISOString(),
    memberships: memberships
      .filter((m) => m.userId === r.id)
      .map((m) => ({
        organizationId: m.organizationId,
        organizationName: m.organizationName,
        role: parseRole(m.role),
      })),
  }));
}

export async function listUsers(db: Database, search?: string): Promise<User[]> {
  const pattern = search ? `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : undefined;
  const rows = await db
    .select()
    .from(schema.user)
    .where(
      pattern ? or(ilike(schema.user.name, pattern), ilike(schema.user.email, pattern)) : undefined,
    )
    .orderBy(asc(schema.user.createdAt))
    .limit(500);
  return toDtos(db, rows);
}

async function findUser(db: Executor, id: string): Promise<UserRow> {
  const [row] = await db.select().from(schema.user).where(eq(schema.user.id, id));
  if (!row) fail("USER_NOT_FOUND", "user not found");
  return row;
}

export async function getUser(db: Executor, id: string): Promise<User> {
  const [dto] = await toDtos(db, [await findUser(db, id)]);
  if (!dto) fail("USER_NOT_FOUND", "user not found");
  return dto;
}

/** Creates an account (platform administrators only; self sign-up stays disabled). */
export async function createUser(
  ctx: AppContext,
  input: {
    name: string;
    email: string;
    password: string;
    isAdmin: boolean;
    organizationId?: string;
    role: OrgRole;
  },
  actor: Actor,
): Promise<User> {
  const [existing] = await ctx.db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, input.email));
  if (existing) {
    fail("EMAIL_TAKEN", `e-mail already registered: ${input.email}`, { email: input.email });
  }
  if (input.organizationId) {
    const [org] = await ctx.db
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.id, input.organizationId));
    if (!org) fail("ORGANIZATION_NOT_FOUND", "organization not found");
  }
  const created = await ctx.auth.api.createUser({
    body: {
      email: input.email,
      password: input.password,
      name: input.name,
      role: input.isAdmin ? "admin" : "user",
    },
  });
  await recordAudit(ctx.db, actor, {
    action: "user.create",
    targetType: "user",
    targetId: created.user.id,
    targetName: input.name,
    metadata: { email: input.email, isAdmin: input.isAdmin },
  });
  if (input.organizationId) {
    await addMember(
      ctx.db,
      { organizationId: input.organizationId, userId: created.user.id, role: input.role },
      { actor, role: "owner" },
    );
  }
  return getUser(ctx.db, created.user.id);
}

export async function setUserAdmin(
  db: Database,
  input: { id: string; isAdmin: boolean },
  actor: Actor,
): Promise<User> {
  if (input.id === actor.id && !input.isAdmin) {
    fail("CANNOT_MODIFY_SELF", "you cannot remove your own administrator role");
  }
  return db.transaction(async (tx) => {
    const row = await findUser(tx, input.id);
    await tx
      .update(schema.user)
      .set({ role: input.isAdmin ? "admin" : "user" })
      .where(eq(schema.user.id, input.id));
    await recordAudit(tx, actor, {
      action: input.isAdmin ? "user.grant_admin" : "user.revoke_admin",
      targetType: "user",
      targetId: row.id,
      targetName: row.name,
      metadata: { email: row.email },
    });
    return getUser(tx, input.id);
  });
}

/**
 * Disables (bans) or re-enables an account. Disabling signs the user out
 * everywhere; their API keys stop working because every request checks the flag.
 */
export async function setUserDisabled(
  db: Database,
  input: { id: string; disabled: boolean },
  actor: Actor,
): Promise<User> {
  if (input.id === actor.id && input.disabled) {
    fail("CANNOT_MODIFY_SELF", "you cannot disable your own account");
  }
  return db.transaction(async (tx) => {
    const row = await findUser(tx, input.id);
    await tx
      .update(schema.user)
      .set({
        banned: input.disabled,
        banReason: input.disabled ? "disabled by an administrator" : null,
        banExpires: null,
      })
      .where(eq(schema.user.id, input.id));
    if (input.disabled) await tx.delete(schema.session).where(eq(schema.session.userId, input.id));
    await recordAudit(tx, actor, {
      action: input.disabled ? "user.disable" : "user.enable",
      targetType: "user",
      targetId: row.id,
      targetName: row.name,
      metadata: { email: row.email },
    });
    return getUser(tx, input.id);
  });
}
