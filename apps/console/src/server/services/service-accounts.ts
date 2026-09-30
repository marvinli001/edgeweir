import { createHash, randomBytes } from "node:crypto";
import {
  SERVICE_ACCOUNT_KEY_PREFIX,
  type ServiceAccount,
  type ServiceAccountKey,
  type ServiceAccountScope,
  serviceAccountScope,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import type { Executor } from "./revisions";

type AccountRow = typeof schema.serviceAccount.$inferSelect;
type KeyRow = typeof schema.serviceAccountKey.$inferSelect;

/** The authenticated service account of a request. */
export interface ServicePrincipal {
  id: string;
  name: string;
  scopes: ServiceAccountScope[];
  keyId: string;
}

/** last_used_at is written at most this often per key. */
const LAST_USED_RESOLUTION_MS = 60_000;

export const hashServiceAccountKey = (key: string) =>
  createHash("sha256").update(key).digest("hex");

export const isServiceAccountKey = (key: string) => key.startsWith(SERVICE_ACCOUNT_KEY_PREFIX);

function keyDto(row: KeyRow): ServiceAccountKey {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

const readScopes = (values: string[]): ServiceAccountScope[] =>
  values.flatMap((v) => {
    const parsed = serviceAccountScope.safeParse(v);
    return parsed.success ? [parsed.data] : [];
  });

async function toDtos(db: Executor, rows: AccountRow[]): Promise<ServiceAccount[]> {
  if (!rows.length) return [];
  const keys = await db
    .select()
    .from(schema.serviceAccountKey)
    .where(
      inArray(
        schema.serviceAccountKey.serviceAccountId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(schema.serviceAccountKey.createdAt));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    scopes: readScopes(r.scopes),
    enabled: r.enabled,
    keys: keys.filter((k) => k.serviceAccountId === r.id).map(keyDto),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

async function findAccount(db: Executor, id: string) {
  const [row] = await db
    .select()
    .from(schema.serviceAccount)
    .where(eq(schema.serviceAccount.id, id));
  if (!row) fail("SERVICE_ACCOUNT_NOT_FOUND", "service account not found");
  return row;
}

async function assertNameFree(db: Executor, name: string, exceptId?: string) {
  const [taken] = await db
    .select({ id: schema.serviceAccount.id })
    .from(schema.serviceAccount)
    .where(eq(schema.serviceAccount.name, name));
  if (taken && taken.id !== exceptId)
    fail("SERVICE_ACCOUNT_NAME_TAKEN", `service account name already exists: ${name}`, { name });
}

async function one(db: Executor, id: string) {
  const [dto] = await toDtos(db, [await findAccount(db, id)]);
  if (!dto) throw new Error("service account not readable");
  return dto;
}

export async function listServiceAccounts(db: Database) {
  return toDtos(
    db,
    await db.select().from(schema.serviceAccount).orderBy(asc(schema.serviceAccount.name)),
  );
}

export async function createServiceAccount(
  db: Database,
  input: { name: string; scopes: ServiceAccountScope[]; enabled: boolean },
  actor: Actor,
) {
  return db.transaction(async (tx) => {
    await assertNameFree(tx, input.name);
    const [row] = await tx
      .insert(schema.serviceAccount)
      .values({
        name: input.name,
        scopes: input.scopes,
        enabled: input.enabled,
        createdByUserId: actor.type === "user" ? actor.id : null,
      })
      .returning();
    if (!row) throw new Error("service account insert failed");
    await recordAudit(tx, actor, {
      action: "service_account.create",
      targetType: "service_account",
      targetId: row.id,
      targetName: row.name,
      metadata: { scopes: input.scopes, enabled: input.enabled },
    });
    return one(tx, row.id);
  });
}

export async function updateServiceAccount(
  db: Database,
  input: { id: string; name?: string; scopes?: ServiceAccountScope[]; enabled?: boolean },
  actor: Actor,
) {
  return db.transaction(async (tx) => {
    const before = await findAccount(tx, input.id);
    if (input.name !== undefined) await assertNameFree(tx, input.name, before.id);
    const [row] = await tx
      .update(schema.serviceAccount)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.scopes !== undefined ? { scopes: input.scopes } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(eq(schema.serviceAccount.id, before.id))
      .returning();
    if (!row) throw new Error("service account disappeared");
    await recordAudit(tx, actor, {
      action: "service_account.update",
      targetType: "service_account",
      targetId: row.id,
      targetName: row.name,
      metadata: {
        from: { name: before.name, scopes: before.scopes, enabled: before.enabled },
        to: { name: row.name, scopes: row.scopes, enabled: row.enabled },
      },
    });
    return one(tx, row.id);
  });
}

export async function deleteServiceAccount(db: Database, id: string, actor: Actor) {
  return db.transaction(async (tx) => {
    const row = await findAccount(tx, id);
    await tx.delete(schema.serviceAccount).where(eq(schema.serviceAccount.id, id));
    await recordAudit(tx, actor, {
      action: "service_account.delete",
      targetType: "service_account",
      targetId: id,
      targetName: row.name,
    });
    return { ok: true as const };
  });
}

/** Creates a key; the secret is returned once and only its SHA-256 is stored. */
export async function createServiceAccountKey(
  db: Database,
  input: { id: string; name: string },
  actor: Actor,
) {
  const secret = `${SERVICE_ACCOUNT_KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return db.transaction(async (tx) => {
    const account = await findAccount(tx, input.id);
    const [row] = await tx
      .insert(schema.serviceAccountKey)
      .values({
        serviceAccountId: account.id,
        name: input.name,
        keyHash: hashServiceAccountKey(secret),
        prefix: secret.slice(0, 12),
      })
      .returning();
    if (!row) throw new Error("service account key insert failed");
    await recordAudit(tx, actor, {
      action: "service_account.key_create",
      targetType: "service_account",
      targetId: account.id,
      targetName: account.name,
      metadata: { keyId: row.id, name: input.name, prefix: row.prefix },
    });
    return { key: keyDto(row), secret };
  });
}

export async function revokeServiceAccountKey(
  db: Database,
  input: { id: string; keyId: string },
  actor: Actor,
) {
  return db.transaction(async (tx) => {
    const account = await findAccount(tx, input.id);
    const [existing] = await tx
      .select()
      .from(schema.serviceAccountKey)
      .where(
        and(
          eq(schema.serviceAccountKey.id, input.keyId),
          eq(schema.serviceAccountKey.serviceAccountId, account.id),
        ),
      );
    if (!existing) fail("SERVICE_ACCOUNT_KEY_NOT_FOUND", "service account key not found");
    if (existing.revokedAt) return keyDto(existing);
    const [row] = await tx
      .update(schema.serviceAccountKey)
      .set({ revokedAt: new Date() })
      .where(eq(schema.serviceAccountKey.id, existing.id))
      .returning();
    if (!row) throw new Error("service account key disappeared");
    await recordAudit(tx, actor, {
      action: "service_account.key_revoke",
      targetType: "service_account",
      targetId: account.id,
      targetName: account.name,
      metadata: { keyId: row.id, prefix: row.prefix },
    });
    return keyDto(row);
  });
}

/**
 * The enabled service account a key belongs to, or null (unknown or revoked
 * key, disabled account). Records the key's last use.
 */
export async function authenticateServiceAccountKey(
  db: Database,
  key: string,
  now = new Date(),
): Promise<ServicePrincipal | null> {
  if (!isServiceAccountKey(key) || key.length > 200) return null;
  const [row] = await db
    .select({ key: schema.serviceAccountKey, account: schema.serviceAccount })
    .from(schema.serviceAccountKey)
    .innerJoin(
      schema.serviceAccount,
      eq(schema.serviceAccount.id, schema.serviceAccountKey.serviceAccountId),
    )
    .where(eq(schema.serviceAccountKey.keyHash, hashServiceAccountKey(key)));
  if (!row || row.key.revokedAt || !row.account.enabled) return null;
  await db
    .update(schema.serviceAccountKey)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(schema.serviceAccountKey.id, row.key.id),
        or(
          isNull(schema.serviceAccountKey.lastUsedAt),
          lt(
            schema.serviceAccountKey.lastUsedAt,
            new Date(now.getTime() - LAST_USED_RESOLUTION_MS),
          ),
        ),
      ),
    );
  return {
    id: row.account.id,
    name: row.account.name,
    scopes: readScopes(row.account.scopes),
    keyId: row.key.id,
  };
}
