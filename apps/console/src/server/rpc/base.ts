import { contract, serviceAccountScopeFor } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { implement, ORPCError } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { API_KEY_HEADER } from "../lib/auth";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { keyScope } from "../services/access-keys";
import type { Actor } from "../services/audit";
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
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((body?.details?.tryAgainIn ?? 60_000) / 1000),
      );
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

/** Resolves the caller: the operator's session (cookie or AccessKey) or a service account. */
export const authed = os.use(async ({ context, next }) => {
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
        user: { id: account.id, name: account.name, email: "" } as SessionResult["user"],
        actor,
      },
    });
  }
  const result = await readSession(context);
  if (!result) throw new ORPCError("UNAUTHORIZED", { message: "authentication required" });
  const { user } = result;
  const actor: Actor = {
    type: context.headers.has(API_KEY_HEADER) ? "api_key" : "user",
    id: user.id,
    name: user.name,
    ip: context.ip,
    userAgent: context.userAgent,
  };
  return next({ context: { user, actor } });
});
