import { randomBytes } from "node:crypto";
import type { Invitation, Member, OrgRole } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, asc, count, eq, gt } from "drizzle-orm";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import type { Executor } from "./revisions";

export const INVITATION_TTL_DAYS = 7;

/** Opaque ids for rows we create ourselves in better-auth tables. */
export function newId(): string {
  return randomBytes(18).toString("base64url");
}

export function parseRole(value: string | null | undefined): OrgRole {
  const first = String(value ?? "")
    .split(",")[0]
    ?.trim();
  return first === "owner" || first === "admin" ? first : "member";
}

/** Who is changing memberships: platform admins and organization owners may touch owners. */
export interface ManagerContext {
  actor: Actor;
  /** The caller's role in the organization, or "owner" for platform administrators. */
  role: OrgRole;
}

export async function findOrganization(db: Executor, id: string) {
  const [row] = await db.select().from(schema.organization).where(eq(schema.organization.id, id));
  if (!row) fail("ORGANIZATION_NOT_FOUND", "organization not found");
  return row;
}

function toMemberDtos(
  rows: {
    member: typeof schema.member.$inferSelect;
    user: typeof schema.user.$inferSelect;
  }[],
): Member[] {
  return rows.map(({ member, user }) => ({
    id: member.id,
    userId: user.id,
    name: user.name,
    email: user.email,
    role: parseRole(member.role),
    twoFactorEnabled: user.twoFactorEnabled === true,
    disabled: user.banned === true,
    createdAt: member.createdAt.toISOString(),
  }));
}

async function memberRows(db: Executor, organizationId: string, memberId?: string) {
  return db
    .select({ member: schema.member, user: schema.user })
    .from(schema.member)
    .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
    .where(
      and(
        eq(schema.member.organizationId, organizationId),
        memberId ? eq(schema.member.id, memberId) : undefined,
      ),
    )
    .orderBy(asc(schema.member.createdAt));
}

async function findMember(db: Executor, organizationId: string, memberId: string) {
  const [row] = await memberRows(db, organizationId, memberId);
  if (!row) fail("MEMBER_NOT_FOUND", "member not found");
  return row;
}

async function pendingInvitations(db: Executor, organizationId: string): Promise<Invitation[]> {
  const rows = await db
    .select({ invitation: schema.invitation, inviterName: schema.user.name })
    .from(schema.invitation)
    .leftJoin(schema.user, eq(schema.user.id, schema.invitation.inviterId))
    .where(
      and(
        eq(schema.invitation.organizationId, organizationId),
        eq(schema.invitation.status, "pending"),
        gt(schema.invitation.expiresAt, new Date()),
      ),
    )
    .orderBy(asc(schema.invitation.createdAt));
  return rows.map(({ invitation, inviterName }) => toInvitationDto(invitation, inviterName ?? ""));
}

function toInvitationDto(
  row: typeof schema.invitation.$inferSelect,
  inviterName: string,
): Invitation {
  return {
    id: row.id,
    email: row.email,
    role: parseRole(row.role),
    inviterName,
    expiresAt: row.expiresAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listMembers(
  db: Database,
  organizationId: string,
  role: OrgRole,
): Promise<{ members: Member[]; invitations: Invitation[] }> {
  await findOrganization(db, organizationId);
  const members = toMemberDtos(await memberRows(db, organizationId));
  // An invitation ID is a bearer credential until the account exists. A
  // manager must never obtain an invitation granting more authority than
  // they themselves may grant (notably admin -> owner).
  const invitations = (await pendingInvitations(db, organizationId)).filter(
    (invitation) => role === "owner" || invitation.role !== "owner",
  );
  return { members, invitations };
}

async function ownerCount(db: Executor, organizationId: string): Promise<number> {
  const rows = await db
    .select({ role: schema.member.role })
    .from(schema.member)
    .where(eq(schema.member.organizationId, organizationId));
  return rows.filter((r) => parseRole(r.role) === "owner").length;
}

function assertMayGrant(ctx: ManagerContext, role: OrgRole) {
  if (role === "owner" && ctx.role !== "owner") {
    fail("OWNER_REQUIRED", "only organization owners can manage owners");
  }
}

export async function addMember(
  db: Database,
  input: { organizationId: string; userId: string; role: OrgRole },
  ctx: ManagerContext,
): Promise<Member> {
  return db.transaction((tx) => addMemberTx(tx, input, ctx));
}

/** addMember inside the caller's transaction (membership and audit entry commit together). */
export async function addMemberTx(
  tx: Executor,
  input: { organizationId: string; userId: string; role: OrgRole },
  ctx: ManagerContext,
): Promise<Member> {
  const org = await findOrganization(tx, input.organizationId);
  assertMayGrant(ctx, input.role);
  const [user] = await tx.select().from(schema.user).where(eq(schema.user.id, input.userId));
  if (!user) fail("USER_NOT_FOUND", "user not found");
  const [existing] = await tx
    .select({ id: schema.member.id })
    .from(schema.member)
    .where(
      and(
        eq(schema.member.organizationId, input.organizationId),
        eq(schema.member.userId, input.userId),
      ),
    );
  if (existing) fail("ALREADY_MEMBER", `already a member: ${user.email}`, { email: user.email });
  const id = newId();
  await tx.insert(schema.member).values({
    id,
    organizationId: input.organizationId,
    userId: input.userId,
    role: input.role,
    createdAt: new Date(),
  });
  await recordAudit(tx, ctx.actor, {
    action: "member.add",
    organizationId: org.id,
    targetType: "user",
    targetId: user.id,
    targetName: user.name,
    metadata: { organization: org.name, role: input.role, email: user.email },
  });
  const [row] = await memberRows(tx, input.organizationId, id);
  const [dto] = toMemberDtos(row ? [row] : []);
  if (!dto) throw new Error("member not readable");
  return dto;
}

export async function updateMemberRole(
  db: Database,
  input: { organizationId: string; memberId: string; role: OrgRole },
  ctx: ManagerContext,
): Promise<Member> {
  return db.transaction(async (tx) => {
    const org = await findOrganization(tx, input.organizationId);
    const row = await findMember(tx, input.organizationId, input.memberId);
    const current = parseRole(row.member.role);
    if (current === input.role) {
      const [dto] = toMemberDtos([row]);
      if (!dto) throw new Error("member not readable");
      return dto;
    }
    assertMayGrant(ctx, current);
    assertMayGrant(ctx, input.role);
    if (current === "owner" && (await ownerCount(tx, input.organizationId)) <= 1) {
      fail("LAST_OWNER", "an organization needs at least one owner");
    }
    await tx
      .update(schema.member)
      .set({ role: input.role })
      .where(eq(schema.member.id, input.memberId));
    await recordAudit(tx, ctx.actor, {
      action: "member.update_role",
      organizationId: org.id,
      targetType: "user",
      targetId: row.user.id,
      targetName: row.user.name,
      metadata: { organization: org.name, from: current, to: input.role },
    });
    const [updated] = await memberRows(tx, input.organizationId, input.memberId);
    const [dto] = toMemberDtos(updated ? [updated] : []);
    if (!dto) throw new Error("member not readable");
    return dto;
  });
}

export async function removeMember(
  db: Database,
  input: { organizationId: string; memberId: string },
  ctx: ManagerContext,
): Promise<void> {
  await db.transaction(async (tx) => {
    const org = await findOrganization(tx, input.organizationId);
    const row = await findMember(tx, input.organizationId, input.memberId);
    const current = parseRole(row.member.role);
    assertMayGrant(ctx, current);
    if (current === "owner" && (await ownerCount(tx, input.organizationId)) <= 1) {
      fail("LAST_OWNER", "an organization needs at least one owner");
    }
    await tx.delete(schema.member).where(eq(schema.member.id, input.memberId));
    await recordAudit(tx, ctx.actor, {
      action: "member.remove",
      organizationId: org.id,
      targetType: "user",
      targetId: row.user.id,
      targetName: row.user.name,
      metadata: { organization: org.name, role: current },
    });
  });
}

export function invitationUrl(publicUrl: string, id: string): string {
  return `${publicUrl.replace(/\/$/, "")}/invite/${id}`;
}

/**
 * Invites an e-mail address into an organization. The invitation id is the
 * secret in the link; a newer invitation for the same address replaces older ones.
 */
export async function createInvitation(
  db: Database,
  input: { organizationId: string; email: string; role: OrgRole },
  ctx: ManagerContext,
): Promise<Invitation> {
  return db.transaction(async (tx) => {
    const org = await findOrganization(tx, input.organizationId);
    assertMayGrant(ctx, input.role);
    const [already] = await tx
      .select({ id: schema.member.id })
      .from(schema.member)
      .innerJoin(schema.user, eq(schema.user.id, schema.member.userId))
      .where(
        and(
          eq(schema.member.organizationId, input.organizationId),
          eq(schema.user.email, input.email),
        ),
      );
    if (already) {
      fail("ALREADY_MEMBER", `already a member: ${input.email}`, { email: input.email });
    }
    await tx
      .update(schema.invitation)
      .set({ status: "canceled" })
      .where(
        and(
          eq(schema.invitation.organizationId, input.organizationId),
          eq(schema.invitation.email, input.email),
          eq(schema.invitation.status, "pending"),
        ),
      );
    const [row] = await tx
      .insert(schema.invitation)
      .values({
        id: newId(),
        organizationId: input.organizationId,
        email: input.email,
        role: input.role,
        status: "pending",
        expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 3600 * 1000),
        inviterId: ctx.actor.id,
      })
      .returning();
    if (!row) throw new Error("invitation insert failed");
    await recordAudit(tx, ctx.actor, {
      action: "invitation.create",
      organizationId: org.id,
      targetType: "invitation",
      targetId: row.id,
      targetName: input.email,
      metadata: { organization: org.name, role: input.role },
    });
    return toInvitationDto(row, ctx.actor.name ?? "");
  });
}

export async function cancelInvitation(
  db: Database,
  input: { organizationId: string; id: string },
  actor: Actor,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.invitation)
      .set({ status: "canceled" })
      .where(
        and(
          eq(schema.invitation.id, input.id),
          eq(schema.invitation.organizationId, input.organizationId),
          eq(schema.invitation.status, "pending"),
        ),
      )
      .returning();
    if (!row) fail("INVITATION_NOT_FOUND", "invitation not found");
    await recordAudit(tx, actor, {
      action: "invitation.cancel",
      organizationId: input.organizationId,
      targetType: "invitation",
      targetId: row.id,
      targetName: row.email,
    });
  });
}

/** A pending, unexpired invitation or INVITATION_NOT_FOUND. */
export async function findOpenInvitation(db: Executor, id: string) {
  const [row] = await db
    .select({
      invitation: schema.invitation,
      organizationName: schema.organization.name,
      inviterName: schema.user.name,
    })
    .from(schema.invitation)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.invitation.organizationId))
    .leftJoin(schema.user, eq(schema.user.id, schema.invitation.inviterId))
    .where(
      and(
        eq(schema.invitation.id, id),
        eq(schema.invitation.status, "pending"),
        gt(schema.invitation.expiresAt, new Date()),
      ),
    );
  if (!row) fail("INVITATION_NOT_FOUND", "invitation not found or expired");
  return row;
}

export async function memberCount(db: Executor, organizationId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.member)
    .where(eq(schema.member.organizationId, organizationId));
  return row?.n ?? 0;
}

/** Closes an invitation once it has been used. */
export async function closeInvitation(tx: Executor, id: string, status: "accepted" | "canceled") {
  await tx.update(schema.invitation).set({ status }).where(eq(schema.invitation.id, id));
}
