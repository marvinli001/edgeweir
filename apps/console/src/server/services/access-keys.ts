import { createHash } from "node:crypto";
import { ACCESS_KEY_MAX_REQUESTS_PER_MINUTE } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";

/** AccessKeys as better-auth's apiKey plugin generates them: defaultPrefix and 64 letters. */
const ACCESS_KEY_FORMAT = /^ewk_[A-Za-z]{64}$/;

/** last_request (the key's last use) is written at most this often per key. */
const LAST_USED_RESOLUTION_MS = 60_000;

/** The stored form of a key: better-auth's defaultKeyHasher, SHA-256 in unpadded base64url. */
export const hashAccessKey = (key: string) => createHash("sha256").update(key).digest("base64url");

export function keyScope(permissions: string | null): "read" | "write" {
  // Null is the pre-M6 full-access format; malformed non-null permissions fail closed.
  if (permissions === null) return "write";
  try {
    const parsed = JSON.parse(permissions) as Record<string, unknown>;
    return Array.isArray(parsed.edgeweir) && parsed.edgeweir.includes("write") ? "write" : "read";
  } catch {
    return "read";
  }
}
type ApiKeyRow = typeof schema.apikey.$inferSelect;
type UserRow = typeof schema.user.$inferSelect;

/** An /api/v1 request's AccessKey and the account it acts as. */
export interface AccessKeyPrincipal {
  key: ApiKeyRow;
  user: UserRow;
}

interface RateWindow {
  start: number;
  count: number;
  max: number;
  length: number;
}

/**
 * Requests per AccessKey in fixed windows, kept in this process: a window starts with the key's
 * first request after the previous window ended and allows the key's maximum, so traffic under
 * the limit is never refused however long it lasts. A restart starts every count over.
 */
export class AccessKeyRateLimiter {
  private readonly windows = new Map<string, RateWindow>();
  private swept = 0;

  constructor(readonly now: () => number = Date.now) {}

  /** Counts a request of the key; over its maximum: the milliseconds until its window ends. */
  take(id: string, max: number, length: number): number | null {
    const now = this.now();
    let window = this.windows.get(id);
    // A changed limit starts a fresh count.
    if (
      !window ||
      now - window.start >= window.length ||
      window.max !== max ||
      window.length !== length
    ) {
      this.sweep(now);
      window = { start: now, count: 0, max, length };
      this.windows.set(id, window);
    }
    if (window.count >= max) return window.start + window.length - now;
    window.count++;
    return null;
  }

  /** Starts the key's count over (its limit changed). */
  reset(id: string) {
    this.windows.delete(id);
  }

  /** Drops ended windows, at most once a minute. */
  private sweep(now: number) {
    if (now - this.swept < 60_000) return;
    this.swept = now;
    for (const [id, window] of this.windows)
      if (now - window.start >= window.length) this.windows.delete(id);
  }
}

/**
 * The enabled, unexpired AccessKey a request carries and its account, or null. Counts nothing:
 * authenticateAccessKey does.
 */
export async function findAccessKey(
  db: Database,
  key: string,
  now: Date,
): Promise<AccessKeyPrincipal | null> {
  if (!ACCESS_KEY_FORMAT.test(key)) return null;
  const [row] = await db
    .select({ key: schema.apikey, user: schema.user })
    .from(schema.apikey)
    .innerJoin(schema.user, eq(schema.user.id, schema.apikey.referenceId))
    .where(eq(schema.apikey.key, hashAccessKey(key)));
  if (row?.key.enabled !== true) return null;
  if (row.key.expiresAt && row.key.expiresAt <= now) return null;
  // Usage quotas (remaining, refills) are never set by Edgeweir: such a key fails closed.
  if (row.key.remaining !== null) return null;
  return row;
}

/**
 * Authenticates an /api/v1 request's AccessKey: one lookup, the key's request limit (429
 * API_KEY_RATE_LIMITED over it) and its last use, written at most once per
 * LAST_USED_RESOLUTION_MS. Null: unknown, revoked or expired key, or no such account.
 */
export async function authenticateAccessKey(
  app: AppContext,
  key: string,
): Promise<AccessKeyPrincipal | null> {
  const limiter = app.accessKeyLimits;
  const now = new Date(limiter.now());
  const found = await findAccessKey(app.db, key, now);
  if (!found) return null;
  const row = found.key;
  if (row.rateLimitEnabled !== false && row.rateLimitMax !== null && row.rateLimitTimeWindow) {
    const wait = limiter.take(row.id, row.rateLimitMax, row.rateLimitTimeWindow);
    if (wait !== null)
      fail("API_KEY_RATE_LIMITED", "too many requests with this access key", {
        retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)),
      });
  }
  const stale = new Date(now.getTime() - LAST_USED_RESOLUTION_MS);
  if (!row.lastRequest || row.lastRequest < stale)
    await app.db
      .update(schema.apikey)
      .set({ lastRequest: now })
      .where(
        and(
          eq(schema.apikey.id, row.id),
          or(isNull(schema.apikey.lastRequest), lt(schema.apikey.lastRequest, stale)),
        ),
      );
  return found;
}

/** A new key's request limit counts its requests in windows of this length. */
const ACCESS_KEY_RATE_LIMIT_WINDOW_MS = 60_000;

/** The key's request limit per minute from the plugin's columns; null: unlimited. */
function requestsPerMinute(
  row: Pick<ApiKeyRow, "rateLimitEnabled" | "rateLimitMax" | "rateLimitTimeWindow">,
): number | null {
  // authenticateAccessKey skips a key whose limit is off or has no window or maximum.
  if (row.rateLimitEnabled === false || row.rateLimitMax === null || !row.rateLimitTimeWindow)
    return null;
  const perMinute = Math.round(
    (row.rateLimitMax * ACCESS_KEY_RATE_LIMIT_WINDOW_MS) / row.rateLimitTimeWindow,
  );
  return Math.min(ACCESS_KEY_MAX_REQUESTS_PER_MINUTE, Math.max(1, perMinute));
}

/** The plugin's columns for a limit; unlimited keeps the old maximum, which is then unused. */
function rateLimitColumns(limit: number | null) {
  return limit === null
    ? { rateLimitEnabled: false }
    : {
        rateLimitEnabled: true,
        rateLimitMax: limit,
        rateLimitTimeWindow: ACCESS_KEY_RATE_LIMIT_WINDOW_MS,
      };
}

function dto(row: ApiKeyRow) {
  return {
    id: row.id,
    name: row.name ?? "",
    prefix: row.start ?? row.prefix ?? "",
    scope: keyScope(row.permissions),
    enabled: row.enabled === true,
    requestsPerMinute: requestsPerMinute(row),
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastRequest?.toISOString() ?? null,
  };
}
export async function listAccessKeys(app: AppContext, userId: string) {
  return (
    await app.db
      .select()
      .from(schema.apikey)
      .where(eq(schema.apikey.referenceId, userId))
      .orderBy(schema.apikey.createdAt)
  ).map(dto);
}
export async function createAccessKey(
  app: AppContext,
  userId: string,
  input: { name: string; scope: "read" | "write"; requestsPerMinute: number | null },
  actor: Actor,
) {
  if (actor.type !== "user") fail("ACCESS_KEY_SESSION_REQUIRED", "sign in to create an access key");
  const created = await app.auth.api.createApiKey({
    body: {
      userId,
      name: input.name,
      permissions: { edgeweir: input.scope === "write" ? ["read", "write"] : ["read"] },
      // Server-only fields of the plugin's createApiKey.
      ...rateLimitColumns(input.requestsPerMinute),
    },
  });
  try {
    const [row] = await app.db
      .select()
      .from(schema.apikey)
      .where(and(eq(schema.apikey.id, created.id), eq(schema.apikey.referenceId, userId)));
    if (!row) throw new Error("created API key missing");
    await recordAudit(app.db, actor, {
      action: "api_key.create",
      targetType: "api_key",
      targetId: row.id,
      targetName: input.name,
      // Never the key itself: its public first characters identify it.
      metadata: {
        scope: input.scope,
        prefix: row.start ?? "",
        requestsPerMinute: requestsPerMinute(row),
      },
    });
    return { ...dto(row), key: created.key };
  } catch (error) {
    await app.db
      .delete(schema.apikey)
      .where(and(eq(schema.apikey.id, created.id), eq(schema.apikey.referenceId, userId)));
    throw error;
  }
}
/**
 * Renames a key or changes its request limit. A new limit starts a fresh count. Only the operator's
 * session may: a key could otherwise lift its own limit.
 */
export async function updateAccessKey(
  app: AppContext,
  userId: string,
  input: { id: string; name?: string; requestsPerMinute?: number | null },
  actor: Actor,
) {
  if (actor.type !== "user") fail("ACCESS_KEY_SESSION_REQUIRED", "sign in to change an access key");
  return app.db.transaction(async (tx) => {
    const where = and(eq(schema.apikey.id, input.id), eq(schema.apikey.referenceId, userId));
    const [before] = await tx.select().from(schema.apikey).where(where).for("update");
    if (!before) fail("ACCESS_KEY_NOT_FOUND", "access key not found");
    if (before.enabled !== true) fail("ACCESS_KEY_REVOKED", "access key is revoked");
    const limitChanged =
      input.requestsPerMinute !== undefined &&
      input.requestsPerMinute !== requestsPerMinute(before);
    const [row] = await tx
      .update(schema.apikey)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(limitChanged ? rateLimitColumns(input.requestsPerMinute ?? null) : {}),
        updatedAt: new Date(),
      })
      .where(where)
      .returning();
    if (!row) throw new Error("access key disappeared");
    if (limitChanged) app.accessKeyLimits.reset(row.id);
    await recordAudit(tx, actor, {
      action: "api_key.update",
      targetType: "api_key",
      targetId: row.id,
      targetName: row.name ?? "",
      metadata: {
        from: { name: before.name ?? "", requestsPerMinute: requestsPerMinute(before) },
        to: { name: row.name ?? "", requestsPerMinute: requestsPerMinute(row) },
      },
    });
    return dto(row);
  });
}

export async function revokeAccessKey(app: AppContext, userId: string, id: string, actor: Actor) {
  return app.db.transaction(async (tx) => {
    const [row] = await tx
      .update(schema.apikey)
      .set({ enabled: false, updatedAt: new Date() })
      .where(and(eq(schema.apikey.id, id), eq(schema.apikey.referenceId, userId)))
      .returning();
    if (!row) fail("ACCESS_KEY_NOT_FOUND", "access key not found");
    await recordAudit(tx, actor, {
      action: "api_key.revoke",
      targetType: "api_key",
      targetId: id,
      targetName: row.name ?? "",
    });
    return { ok: true as const };
  });
}
