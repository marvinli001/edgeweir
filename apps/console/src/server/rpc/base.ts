import { contract } from "@edgeweir/contract";
import { implement, ORPCError } from "@orpc/server";
import { API_KEY_HEADER } from "../lib/auth";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { type Caller, resolveCaller } from "../services/account";
import type { Actor } from "../services/audit";
import type { ManagerContext } from "../services/members";
import type { SiteScope } from "../services/sites";
import { isAdminRole } from "../services/users";

export interface RequestContext {
  app: AppContext;
  headers: Headers;
  ip: string;
  userAgent: string;
}

export const os = implement(contract).$context<RequestContext>();

type SessionResult = NonNullable<Awaited<ReturnType<AppContext["auth"]["api"]["getSession"]>>>;

async function readSession(context: RequestContext): Promise<SessionResult | null> {
  try {
    return await context.app.auth.api.getSession({ headers: context.headers });
  } catch (error) {
    // better-auth rejects invalid/expired API keys by throwing a 4xx APIError.
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode >= 500) throw error;
    throw new ORPCError("UNAUTHORIZED", { message: "invalid credentials" });
  }
}

/** Resolves the session (cookie or x-api-key), the caller's organizations and data scope. */
export const authed = os.use(async ({ context, next }) => {
  const result = await readSession(context);
  if (!result) throw new ORPCError("UNAUTHORIZED", { message: "authentication required" });
  const { user, session } = result;
  const u = user as typeof user & {
    role?: string | null;
    banned?: boolean | null;
    twoFactorEnabled?: boolean | null;
  };
  // Covers API keys too: disabling an account must stop every credential at once.
  if (u.banned) fail("USER_DISABLED", "this account is disabled");
  const isAdmin = isAdminRole(u.role);
  const activeOrganizationId = (session as { activeOrganizationId?: string | null })
    .activeOrganizationId;
  const caller = await resolveCaller(context.app.db, u, isAdmin, activeOrganizationId);
  const organizationId = caller.organization?.id ?? null;
  const actor: Actor = {
    type: context.headers.has(API_KEY_HEADER) ? "api_key" : "user",
    id: user.id,
    name: user.name,
    ip: context.ip,
    userAgent: context.userAgent,
  };
  const scope: SiteScope = isAdmin
    ? { all: true }
    : { all: false, organizationId: organizationId ?? "__none__" };
  const sessionId = (session as { id?: string }).id ?? null;
  return next({ context: { user, isAdmin, caller, organizationId, actor, scope, sessionId } });
});

/** Console procedures on tenant data: blocked until a required 2FA is enabled. */
export const tenant = authed.use(async ({ context, next }) => {
  if (context.caller.twoFactorRequired) {
    fail("TWO_FACTOR_REQUIRED", "your organization requires two-factor authentication");
  }
  return next();
});

/** Organization management (members, policy): organization owners/admins and platform admins. */
export const orgManager = tenant.use(async ({ context, next }) => {
  const org = context.caller.organization;
  if (!org) fail("NOT_A_MEMBER", "caller is not a member of any organization");
  const role = context.isAdmin ? "owner" : org.role;
  if (role !== "owner" && role !== "admin") {
    fail("ORG_ADMIN_REQUIRED", "organization owners and admins only");
  }
  const manager: ManagerContext = { actor: context.actor, role };
  return next({ context: { organizationId: org.id, manager } });
});

/** Platform infrastructure and tenancy (the admin area) is administrator-only. */
export const admin = authed.use(async ({ context, next }) => {
  if (!context.isAdmin) throw new ORPCError("FORBIDDEN", { message: "administrator only" });
  const manager: ManagerContext = { actor: context.actor, role: "owner" };
  return next({ context: { manager } });
});

/** Public procedures that behave differently for a signed-in caller (invitations). */
export const maybeAuthed = os.use(async ({ context, next }) => {
  const result = await readSession(context).catch(() => null);
  const session = result ? { userId: result.user.id, email: result.user.email } : null;
  return next({ context: { session } });
});

export type { Caller };
