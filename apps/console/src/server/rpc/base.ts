import { contract, serviceAccountScopeFor } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { implement, ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { API_KEY_HEADER } from "../lib/auth";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { keyScope } from "../services/access-keys";
import { type Caller, resolveCaller } from "../services/account";
import type { Actor } from "../services/audit";
import type { ManagerContext } from "../services/members";
import {
  authenticateServiceAccountKey,
  isServiceAccountKey,
  type ServicePrincipal,
} from "../services/service-accounts";
import type { SiteScope } from "../services/sites";
import { isAdminRole } from "../services/users";

export interface RequestContext {
  app: AppContext;
  headers: Headers;
  ip: string;
  userAgent: string;
  apiSession?: SessionResult;
  /** Set when the request authenticated with a service account key. */
  serviceAccount?: ServicePrincipal;
}

const implementation = implement(contract).$context<RequestContext>();

type SessionResult = NonNullable<Awaited<ReturnType<AppContext["auth"]["api"]["getSession"]>>>;

async function readSession(context: RequestContext): Promise<SessionResult | null> {
  if (context.apiSession) return context.apiSession;
  try {
    return await context.app.auth.api.getSession({ headers: context.headers });
  } catch (error) {
    // better-auth rejects invalid/expired API keys by throwing a 4xx APIError,
    // and keys over their request limit with a 429 (retry time in ms).
    const { statusCode = 500, body } = error as {
      statusCode?: number;
      body?: { details?: { tryAgainIn?: number } };
    };
    if (statusCode >= 500) throw error;
    if (statusCode === 429) {
      const retryAfterSeconds = Math.max(1, Math.ceil((body?.details?.tryAgainIn ?? 60_000) / 1000));
      fail("API_KEY_RATE_LIMITED", "too many requests with this access key", {
        retryAfterSeconds,
      });
    }
    throw new ORPCError("UNAUTHORIZED", { message: "invalid credentials" });
  }
}

/** Scope applies before every public/optional-auth procedure as well as authed routes. */
export const os = implementation.use(async ({ context, next, procedure, path }) => {
  const apiKey = context.headers.get(API_KEY_HEADER);
  if (!apiKey) return next();
  if (isServiceAccountKey(apiKey)) {
    // Service accounts reach only the procedures listed with a scope in the contract.
    const principal = await authenticateServiceAccountKey(context.app.db, apiKey);
    if (!principal) throw new ORPCError("UNAUTHORIZED", { message: "invalid credentials" });
    const access = serviceAccountScopeFor(path.join("."));
    if (!access.allowed)
      fail("SERVICE_ACCOUNT_FORBIDDEN", "service accounts cannot call this procedure");
    if (access.scope && !principal.scopes.includes(access.scope))
      fail("SCOPE_REQUIRED", `this call needs the ${access.scope} scope`, { scope: access.scope });
    return next({ context: { serviceAccount: principal } });
  }
  const session = await readSession(context);
  if (!session) throw new ORPCError("UNAUTHORIZED");
  if ((session.user as { banned?: boolean }).banned)
    fail("USER_DISABLED", "this account is disabled");
  const [key] = await context.app.db
    .select()
    .from(schema.apikey)
    .where(
      and(eq(schema.apikey.id, session.session.id), eq(schema.apikey.referenceId, session.user.id)),
    );
  if (!key?.enabled) throw new ORPCError("UNAUTHORIZED");
  const method = procedure["~orpc"].route.method ?? "POST";
  if (
    keyScope(key.permissions) === "read" &&
    method !== "GET" &&
    path.join(".") !== "rules.validate"
  )
    fail("ACCESS_KEY_READ_ONLY", "access key is read only");
  return next({ context: { apiSession: session } });
});

/** Resolves the session (cookie or x-api-key), the caller's organizations and data scope. */
export const authed = os.use(async ({ context, next }) => {
  const account = context.serviceAccount;
  if (account) {
    // A platform-level identity without organizations; `os` already enforced its scopes.
    const caller: Caller = {
      user: { id: account.id, name: account.name, email: "", twoFactorEnabled: false },
      isAdmin: true,
      memberships: [],
      organization: null,
      requireTwoFactor: false,
      twoFactorRequired: false,
    };
    const actor: Actor = {
      type: "service_account",
      id: account.id,
      name: account.name,
      ip: context.ip,
      userAgent: context.userAgent,
    };
    const scope: SiteScope = { all: true };
    return next({
      context: {
        user: { id: account.id, name: account.name, email: "" } as SessionResult["user"],
        isAdmin: true,
        caller,
        organizationId: null as string | null,
        actor,
        scope,
        sessionId: null as string | null,
      },
    });
  }
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
