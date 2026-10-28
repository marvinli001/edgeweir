import {
  contract,
  DEMO_USER_ID,
  oneTimeSecretProcedures,
  serviceAccountScopeFor,
} from "@edgeweir/contract";
import { implement, ORPCError } from "@orpc/server";
import { API_KEY_HEADER } from "../lib/auth";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { IDEMPOTENCY_HEADER } from "../lib/idempotency";
import { authenticateAccessKey, keyScope } from "../services/access-keys";
import type { Actor } from "../services/audit";
import { type LoginCaller, loginAllowed, logLoginRefusal } from "../services/login-allow-list";
import {
  authenticateServiceAccountKey,
  isServiceAccountKey,
  type ServicePrincipal,
} from "../services/service-accounts";

export interface RequestContext {
  app: AppContext;
  headers: Headers;
  ip: string;
  userAgent: string;
  /** Forwarding headers came from a peer outside EDGEWEIR_TRUSTED_PROXIES (and were ignored). */
  untrustedForwarding?: boolean;
  /** The account of the request's AccessKey (set by `os`). */
  accessKeyUser?: SessionUser;
  /** Set when the request authenticated with a service account key. */
  serviceAccount?: ServicePrincipal;
}

const implementation = implement(contract).$context<RequestContext>();

type SessionResult = NonNullable<Awaited<ReturnType<AppContext["auth"]["api"]["getSession"]>>>;
type SessionUser = SessionResult["user"];

/** The signed-in account of a cookie session (/rpc; /api/v1 requests carry no cookie). */
async function sessionUser(context: RequestContext): Promise<SessionUser | null> {
  try {
    return (await context.app.auth.api.getSession({ headers: context.headers }))?.user ?? null;
  } catch (error) {
    if (((error as { statusCode?: number }).statusCode ?? 500) >= 500) throw error;
    throw new ORPCError("UNAUTHORIZED", { message: "invalid credentials" });
  }
}

/**
 * /api/v1 keeps the response of a request with an Idempotency-Key for 24
 * hours (lib/idempotency.ts); a credential shown once must not end up there.
 */
function refuseStoredSecret(context: RequestContext, path: readonly string[]) {
  if (context.headers.has(IDEMPOTENCY_HEADER) && oneTimeSecretProcedures.has(path.join(".")))
    fail(
      "IDEMPOTENCY_KEY_UNSUPPORTED",
      "this request returns a credential once; send it without Idempotency-Key",
    );
}

/** POST procedures that change nothing: read-only callers may use them. */
const READ_ONLY_POSTS: ReadonlySet<string> = new Set(["rules.validate"]);

/** Whether a read-only caller (a read AccessKey, the demo account) may call the procedure. */
function readOnlyAllowed(method: string, path: readonly string[]): boolean {
  return method === "GET" || READ_ONLY_POSTS.has(path.join("."));
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
    refuseStoredSecret(context, path);
    return next({ context: { serviceAccount: principal } });
  }
  // AccessKeys: one lookup of the key and its account, the key's request limit (429 over it).
  const found = await authenticateAccessKey(context.app, apiKey);
  if (!found) throw new ORPCError("UNAUTHORIZED", { message: "invalid credentials" });
  const method = procedure["~orpc"].route.method ?? "POST";
  if (keyScope(found.key.permissions) === "read" && !readOnlyAllowed(method, path))
    fail("ACCESS_KEY_READ_ONLY", "access key is read only");
  refuseStoredSecret(context, path);
  // The account's row, as better-auth's session carries it.
  return next({ context: { accessKeyUser: found.user as SessionUser } });
});

/**
 * Resolves the caller: the operator's session (cookie or AccessKey), the demo account's session
 * (reads only) or a service account.
 */
export const authed = os.use(async ({ context, next, procedure, path }) => {
  const account = context.serviceAccount;
  if (account) {
    // `os` already enforced its scopes.
    const actor: Actor = {
      type: "service_account",
      id: account.id,
      name: account.name,
      ip: context.ip,
      userAgent: context.userAgent,
    };
    return next({
      context: {
        user: { id: account.id, name: account.name, email: "" } as SessionUser,
        actor,
        demo: false,
      },
    });
  }
  const user = context.accessKeyUser ?? (await sessionUser(context));
  if (!user) throw new ORPCError("UNAUTHORIZED", { message: "authentication required" });
  const demo = user.id === DEMO_USER_ID;
  // Sessions (the cookie; /rpc never carries a key) only from the login allow list, the demo
  // account's excepted. AccessKeys on /api/v1 are not limited (ADR-0047).
  if (
    !demo &&
    !context.headers.has(API_KEY_HEADER) &&
    !(await loginAllowed(context.app.db, context.ip))
  ) {
    logLoginRefusal(context.app.log, context.ip, `/rpc/${path.join("/")}`);
    fail("LOGIN_IP_NOT_ALLOWED", "this address may not sign in to the console");
  }
  if (demo && !readOnlyAllowed(procedure["~orpc"].route.method ?? "POST", path))
    fail("DEMO_READ_ONLY", "the demo account can only read");
  const actor: Actor = {
    type: context.headers.has(API_KEY_HEADER) ? "api_key" : "user",
    id: user.id,
    name: user.name,
    ip: context.ip,
    userAgent: context.userAgent,
  };
  return next({ context: { user, actor, demo } });
});

/** The caller as the login allow list sees it. */
export function loginCaller(context: RequestContext & { demo: boolean }): LoginCaller {
  return {
    ip: context.ip,
    untrustedForwarding: context.untrustedForwarding === true,
    demo: context.demo,
  };
}

/** The response of procedures that return nothing else. */
export const ok = { ok: true as const };
