import { type Database, schema } from "@edgeweir/db";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { type Actor, recordAudit } from "../services/audit";
import { CLIENT_IP_HEADER } from "./client-ip";
import { logger } from "./logger";

/**
 * Audit entries for what users do through better-auth's own endpoints
 * (sign-in, password, two-factor, passkeys). Everything else in the
 * console writes its audit rows itself; these requests never reach our code.
 *
 * better-auth commits its change before these hooks run, so the entry cannot
 * share its transaction; a failure to write it is logged, not turned into an
 * error for a change that already happened.
 */

type AuthUser = { id: string; name?: string | null; email?: string | null };
type HookContext = {
  path?: string;
  body?: Record<string, unknown> | null;
  headers?: Headers;
  request?: Request;
  context: {
    session?: { user: AuthUser; session?: unknown } | null;
    newSession?: { user: AuthUser } | null;
    returned?: unknown;
  };
};

const log = logger.child({ component: "auth-audit" });

/** Names of rows about to be deleted, looked up before better-auth removes them. */
const pendingNames = new WeakMap<Request, string>();

function actorFrom(ctx: HookContext, user: AuthUser | null | undefined): Actor {
  const headers = ctx.headers ?? ctx.request?.headers;
  return {
    type: "user",
    id: user?.id ?? "",
    name: user?.name ?? "",
    ip: headers?.get(CLIENT_IP_HEADER) ?? "",
    userAgent: headers?.get("user-agent") ?? "",
  };
}

function errorCode(returned: unknown): string {
  const body = (returned as { body?: { code?: string } }).body;
  return body?.code ?? String((returned as { status?: string }).status ?? "error");
}

const SIGN_IN_METHODS: Record<string, string> = {
  "/sign-in/email": "password",
  "/two-factor/verify-totp": "totp",
  "/two-factor/verify-backup-code": "backup_code",
  "/passkey/verify-authentication": "passkey",
};

async function write(db: Database, actor: Actor, entry: Parameters<typeof recordAudit>[2]) {
  try {
    await recordAudit(db, actor, entry);
  } catch (error) {
    log.error("cannot write audit entry", { action: entry.action, error });
  }
}

async function afterAuthEndpoint(db: Database, ctx: HookContext): Promise<void> {
  const path = ctx.path ?? "";
  const returned = ctx.context.returned;
  const failed = isAPIError(returned);
  const sessionUser = ctx.context.session?.user;

  const method = SIGN_IN_METHODS[path];
  // Two-factor verification with a session is enrollment, not a sign-in.
  const enrolling = path.startsWith("/two-factor/") && !!sessionUser;
  if (method && !enrolling) {
    const newUser = ctx.context.newSession?.user;
    // The password was right but the second factor is still to come (the
    // two-factor plugin replaced the session with a redirect).
    const pending =
      (returned as { twoFactorRedirect?: boolean } | null)?.twoFactorRedirect === true;
    if (pending) return;
    if (!failed && newUser) {
      await write(db, actorFrom(ctx, newUser), {
        action: "auth.sign_in",
        targetType: "user",
        targetId: newUser.id,
        targetName: newUser.name ?? "",
        metadata: { method },
      });
    } else if (failed) {
      const email = typeof ctx.body?.email === "string" ? ctx.body.email.slice(0, 200) : undefined;
      await write(db, actorFrom(ctx, null), {
        action: "auth.sign_in_failed",
        targetType: email ? "user" : "",
        targetName: email ?? "",
        metadata: { method, code: errorCode(returned), ...(email ? { email } : {}) },
      });
    }
    return;
  }

  if (failed || !sessionUser) return;
  const actor = actorFrom(ctx, sessionUser);
  const self = { targetType: "user", targetId: sessionUser.id, targetName: sessionUser.name ?? "" };
  const result = (returned ?? {}) as Record<string, unknown>;
  switch (path) {
    case "/change-password":
      await write(db, actor, {
        action: "account.password_change",
        ...self,
        metadata: { revokeOtherSessions: ctx.body?.revokeOtherSessions === true },
      });
      break;
    case "/passkey/verify-registration":
      await write(db, actor, {
        action: "account.passkey_add",
        ...self,
        metadata: {
          passkeyId: String(result.id ?? ""),
          name: String(result.name ?? ctx.body?.name ?? ""),
        },
      });
      break;
    case "/passkey/delete-passkey":
      await write(db, actor, {
        action: "account.passkey_delete",
        ...self,
        metadata: {
          passkeyId: String(ctx.body?.id ?? ""),
          name: (ctx.request && pendingNames.get(ctx.request)) ?? "",
        },
      });
      break;
  }
}

async function beforeAuthEndpoint(db: Database, ctx: HookContext): Promise<void> {
  if (!ctx.request) return;
  try {
    if (ctx.path === "/passkey/delete-passkey" && typeof ctx.body?.id === "string") {
      const [row] = await db
        .select({ name: schema.passkey.name })
        .from(schema.passkey)
        .where(eq(schema.passkey.id, ctx.body.id));
      if (row?.name) pendingNames.set(ctx.request, row.name);
    }
  } catch (error) {
    log.warn("cannot look up the name for an audit entry", { path: ctx.path, error });
  }
}

/**
 * The endpoint hooks, as a plugin: listed after the other plugins, its after
 * hook sees the final response (e.g. the two-factor plugin turning a password
 * sign-in into a second-factor redirect).
 */
export function authAuditPlugin(db: Database): BetterAuthPlugin {
  return {
    id: "edgeweir-audit",
    hooks: {
      before: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            await beforeAuthEndpoint(db, ctx as unknown as HookContext);
          }),
        },
      ],
      after: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            await afterAuthEndpoint(db, ctx as unknown as HookContext);
          }),
        },
      ],
    },
  };
}

/** `databaseHooks` that write the audit log for two-factor changes. */
export function authAuditDatabaseHooks(db: Database): BetterAuthOptions["databaseHooks"] {
  return {
    user: {
      update: {
        // Two-factor is switched on by the first verified TOTP code and off
        // by /two-factor/disable; both update the user row.
        after: async (user, ctx) => {
          const path = ctx?.path;
          const enabled = (user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled;
          const action =
            path === "/two-factor/verify-totp" && enabled === true
              ? "account.two_factor_enable"
              : path === "/two-factor/disable" && enabled === false
                ? "account.two_factor_disable"
                : null;
          if (!action) return;
          await write(db, actorFrom((ctx ?? { context: {} }) as unknown as HookContext, user), {
            action,
            targetType: "user",
            targetId: user.id,
            targetName: user.name,
          });
        },
      },
    },
  };
}
