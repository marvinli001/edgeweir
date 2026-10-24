import { ACCESS_KEY_MAX_REQUESTS_PER_MINUTE } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, eq } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
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

/** better-auth's apiKey plugin counts each key's requests in a window of this length. */
const ACCESS_KEY_RATE_LIMIT_WINDOW_MS = 60_000;

/** The key's request limit per minute from the plugin's columns; null: unlimited. */
function requestsPerMinute(
  row: Pick<ApiKeyRow, "rateLimitEnabled" | "rateLimitMax" | "rateLimitTimeWindow">,
): number | null {
  // The plugin skips a key whose limit is off or has no window or maximum.
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
        ...(limitChanged
          ? { ...rateLimitColumns(input.requestsPerMinute ?? null), requestCount: 0 }
          : {}),
        updatedAt: new Date(),
      })
      .where(where)
      .returning();
    if (!row) throw new Error("access key disappeared");
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
