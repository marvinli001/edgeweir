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
function dto(row: typeof schema.apikey.$inferSelect) {
  return {
    id: row.id,
    name: row.name ?? "",
    prefix: row.start ?? row.prefix ?? "",
    scope: keyScope(row.permissions),
    enabled: row.enabled === true,
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
  input: { name: string; scope: "read" | "write" },
  actor: Actor,
) {
  if (actor.type !== "user") fail("ACCESS_KEY_SESSION_REQUIRED", "sign in to create an access key");
  const created = await app.auth.api.createApiKey({
    body: {
      userId,
      name: input.name,
      permissions: { edgeweir: input.scope === "write" ? ["read", "write"] : ["read"] },
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
      metadata: { scope: input.scope, prefix: row.start ?? "" },
    });
    return { ...dto(row), key: created.key };
  } catch (error) {
    await app.db
      .delete(schema.apikey)
      .where(and(eq(schema.apikey.id, created.id), eq(schema.apikey.referenceId, userId)));
    throw error;
  }
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
