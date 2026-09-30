import type { InvitationInfo, Me, OrgRole } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, asc, eq } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import { closeInvitation, findOpenInvitation, newId, parseRole } from "./members";
import { assertOrgLimit } from "./organization-limits";
import { organizationSettings } from "./organizations";
import type { Executor } from "./revisions";
import { withCreatedUser } from "./users";

export interface Membership {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
}

export async function membershipsOf(db: Executor, userId: string): Promise<Membership[]> {
  const rows = await db
    .select({
      id: schema.organization.id,
      name: schema.organization.name,
      slug: schema.organization.slug,
      role: schema.member.role,
    })
    .from(schema.member)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.member.organizationId))
    .where(eq(schema.member.userId, userId))
    .orderBy(asc(schema.member.createdAt));
  return rows.map((r) => ({ ...r, role: parseRole(r.role) }));
}

/** Everything the console needs about the caller, resolved by the auth middleware. */
export interface Caller {
  user: { id: string; name: string; email: string; twoFactorEnabled: boolean };
  isAdmin: boolean;
  memberships: Membership[];
  organization: Membership | null;
  requireTwoFactor: boolean;
  twoFactorRequired: boolean;
}

/**
 * Resolves the active organization: the session's choice if the caller is
 * still a member of it, otherwise the oldest membership.
 */
export async function resolveCaller(
  db: Executor,
  user: {
    id: string;
    name: string;
    email: string;
    role?: string | null;
    twoFactorEnabled?: boolean | null;
  },
  isAdmin: boolean,
  activeOrganizationId: string | null | undefined,
): Promise<Caller> {
  const memberships = await membershipsOf(db, user.id);
  const organization =
    memberships.find((m) => m.id === activeOrganizationId) ?? memberships[0] ?? null;
  const { requireTwoFactor } = organization
    ? await organizationSettings(db, organization.id)
    : { requireTwoFactor: false };
  const twoFactorEnabled = user.twoFactorEnabled === true;
  return {
    user: { id: user.id, name: user.name, email: user.email, twoFactorEnabled },
    isAdmin,
    memberships,
    organization,
    requireTwoFactor,
    // Organization policy binds tenant members; platform administrators are exempt.
    twoFactorRequired: !isAdmin && requireTwoFactor && !twoFactorEnabled,
  };
}

export function toMe(caller: Caller): Me {
  return {
    user: { ...caller.user, isAdmin: caller.isAdmin },
    organizations: caller.memberships,
    activeOrganization: caller.organization
      ? {
          ...caller.organization,
          role: caller.isAdmin ? "owner" : caller.organization.role,
          requireTwoFactor: caller.requireTwoFactor,
        }
      : null,
    twoFactorRequired: caller.twoFactorRequired,
    serviceAccount: null,
  };
}

/** `/me` of a service account: its identity and scopes, no organizations. */
export function serviceAccountMe(account: { id: string; name: string; scopes: string[] }): Me {
  return {
    user: {
      id: account.id,
      name: account.name,
      email: "",
      isAdmin: false,
      twoFactorEnabled: false,
    },
    organizations: [],
    activeOrganization: null,
    twoFactorRequired: false,
    serviceAccount: { id: account.id, name: account.name, scopes: account.scopes },
  };
}

/** Stores the caller's organization choice on the session (like better-auth's setActive). */
export async function setActiveOrganization(
  db: Database,
  input: { sessionId: string | null; caller: Caller; organizationId: string },
): Promise<void> {
  if (!input.caller.memberships.some((m) => m.id === input.organizationId)) {
    fail("NOT_A_MEMBER", "not a member of this organization");
  }
  if (!input.sessionId) return;
  await db
    .update(schema.session)
    .set({ activeOrganizationId: input.organizationId })
    .where(eq(schema.session.id, input.sessionId));
}

export async function getInvitationInfo(db: Database, id: string): Promise<InvitationInfo> {
  const row = await findOpenInvitation(db, id);
  const [user] = await db
    .select({ id: schema.user.id })
    .from(schema.user)
    .where(eq(schema.user.email, row.invitation.email));
  return {
    id: row.invitation.id,
    organizationName: row.organizationName,
    email: row.invitation.email,
    role: parseRole(row.invitation.role),
    inviterName: row.inviterName ?? "",
    expiresAt: row.invitation.expiresAt.toISOString(),
    userExists: !!user,
  };
}

/**
 * Accepts an invitation. An existing account must be signed in as the invited
 * address; otherwise a new account is created with the given name and password.
 */
export async function acceptInvitation(
  ctx: AppContext,
  input: { id: string; name?: string; password?: string },
  session: { userId: string; email: string } | null,
  meta: { ip: string; userAgent: string },
): Promise<{ userId: string; organizationId: string }> {
  const row = await findOpenInvitation(ctx.db, input.id);
  const email = row.invitation.email;
  const [existing] = await ctx.db.select().from(schema.user).where(eq(schema.user.email, email));
  let userId: string;
  let name: string;
  let createdUser = false;
  if (existing) {
    if (!session || session.userId !== existing.id) {
      fail("INVITATION_EMAIL_MISMATCH", `sign in as ${email} to accept this invitation`, {
        email,
      });
    }
    if (existing.banned) fail("USER_DISABLED", "this account is disabled");
    userId = existing.id;
    name = existing.name;
  } else {
    if (!input.name || !input.password) {
      fail("INVITATION_ACCOUNT_REQUIRED", "name and password are required to create the account");
    }
    const created = await ctx.auth.api.createUser({
      body: { email, password: input.password, name: input.name, role: "user" },
    });
    userId = created.user.id;
    name = input.name;
    createdUser = true;
  }
  const actor: Actor = { type: "user", id: userId, name, ...meta };
  const organizationId = row.invitation.organizationId;
  const join = async (tx: Executor) => {
    const [member] = await tx
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(
        and(eq(schema.member.organizationId, organizationId), eq(schema.member.userId, userId)),
      );
    if (!member) {
      await assertOrgLimit(tx, organizationId, "members", 1);
      await tx.insert(schema.member).values({
        id: newId(),
        organizationId,
        userId,
        role: parseRole(row.invitation.role),
        createdAt: new Date(),
      });
    }
    await closeInvitation(tx, row.invitation.id, "accepted");
    await recordAudit(tx, actor, {
      action: "invitation.accept",
      organizationId,
      targetType: "organization",
      targetId: organizationId,
      targetName: row.organizationName,
      metadata: { invitationId: row.invitation.id, email, role: row.invitation.role },
    });
  };
  // A new account comes from better-auth outside this transaction; it is
  // removed again if the membership or its audit entry cannot be written.
  if (createdUser) await withCreatedUser(ctx.db, userId, join);
  else await ctx.db.transaction(join);
  return { userId, organizationId };
}
