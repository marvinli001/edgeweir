import { createHash } from "node:crypto";
import { defaultKeyHasher } from "@better-auth/api-key";
import { type ErrorCode, errorDefs } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { ORPCError } from "@orpc/server";
import { and, eq, lt, lte } from "drizzle-orm";
import { hashServiceAccountKey, isServiceAccountKey } from "../services/service-accounts";

/**
 * Idempotency-Key for /api/v1 writes (draft-ietf-httpapi-idempotency-key-header):
 * the first request with a key runs; a retry with the same key, method, path
 * and body gets the stored response with `Idempotent-Replayed: true`; the
 * same key with another request is 422, a retry while the first still runs
 * is 409. Keys are per caller and kept 24 hours; 5xx responses (and 401/429,
 * which never reached the procedure) are not kept, so the caller can retry.
 */
export const IDEMPOTENCY_HEADER = "idempotency-key";
export const REPLAYED_HEADER = "idempotent-replayed";
export const IDEMPOTENCY_RETENTION_MS = 24 * 3600 * 1000;
/** An in-progress record not finished within this time was abandoned (crash) and may be taken over. */
const LEASE_MS = 10 * 60 * 1000;
const METHODS = new Set(["POST", "PUT", "PATCH"]);
const STORED_HEADERS = ["content-type", "location"];

/**
 * The key: an RFC 8941 String (the draft's syntax, `"..."`) or the bare
 * value; 1–255 printable ASCII characters. Null when invalid.
 */
export function parseIdempotencyKey(raw: string): string | null {
  let value = raw.trim();
  if (value.startsWith('"')) {
    if (!/^"(?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\["\\])*"$/.test(value)) return null;
    value = value.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  if (value.length < 1 || value.length > 255 || !/^[\x20-\x7e]+$/.test(value)) return null;
  return value;
}

/** Who the key namespace belongs to, without side effects; null for invalid credentials. */
export async function idempotencyPrincipal(
  db: Database,
  apiKey: string | null,
): Promise<string | null> {
  if (!apiKey || apiKey.length > 200) return null;
  if (isServiceAccountKey(apiKey)) {
    const [row] = await db
      .select({
        accountId: schema.serviceAccount.id,
        enabled: schema.serviceAccount.enabled,
        revokedAt: schema.serviceAccountKey.revokedAt,
      })
      .from(schema.serviceAccountKey)
      .innerJoin(
        schema.serviceAccount,
        eq(schema.serviceAccount.id, schema.serviceAccountKey.serviceAccountId),
      )
      .where(eq(schema.serviceAccountKey.keyHash, hashServiceAccountKey(apiKey)));
    return row?.enabled && !row.revokedAt ? `service_account:${row.accountId}` : null;
  }
  // better-auth stores user AccessKeys hashed with its default hasher.
  const [row] = await db
    .select({ userId: schema.apikey.referenceId, enabled: schema.apikey.enabled })
    .from(schema.apikey)
    .where(eq(schema.apikey.key, await defaultKeyHasher(apiKey)));
  return row?.enabled ? `user:${row.userId}` : null;
}

function errorResponse(code: ErrorCode, message: string): Response {
  const error = new ORPCError(code, { status: errorDefs[code].status, message, data: {} });
  return Response.json(error.toJSON(), { status: error.status });
}

/**
 * Runs `handle` under the request's Idempotency-Key, if any. `handle`
 * returns null when no route matched (nothing is stored then).
 */
export async function withIdempotency(
  db: Database,
  request: Request,
  apiKey: string | null,
  handle: (request: Request) => Promise<Response | null>,
  clock: () => Date = () => new Date(),
): Promise<Response | null> {
  const header = request.headers.get(IDEMPOTENCY_HEADER);
  if (header === null || !METHODS.has(request.method)) return handle(request);
  const key = parseIdempotencyKey(header);
  if (key === null)
    return errorResponse(
      "IDEMPOTENCY_KEY_INVALID",
      "Idempotency-Key must be 1 to 255 printable ASCII characters",
    );
  const principal = await idempotencyPrincipal(db, apiKey);
  // Without valid credentials the procedure answers 401; nothing to remember.
  if (principal === null) return handle(request);

  const body = new Uint8Array(await request.arrayBuffer());
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const url = new URL(request.url);
  const path = `${url.pathname}${url.search}`;
  const method = request.method;
  const t = schema.idempotencyKey;
  const where = and(eq(t.principal, principal), eq(t.key, key));

  const reserve = async () => {
    const now = clock();
    const rows = await db
      .insert(t)
      .values({
        principal,
        key,
        method,
        path,
        bodyHash,
        lockedUntil: new Date(now.getTime() + LEASE_MS),
        expiresAt: new Date(now.getTime() + IDEMPOTENCY_RETENTION_MS),
      })
      .onConflictDoNothing()
      .returning({ key: t.key });
    return rows.length > 0;
  };

  let reserved = await reserve();
  for (let attempt = 0; !reserved && attempt < 2; attempt++) {
    const now = clock();
    const [existing] = await db.select().from(t).where(where);
    if (!existing) {
      reserved = await reserve();
      continue;
    }
    if (existing.expiresAt <= now) {
      await db.delete(t).where(and(where, lte(t.expiresAt, now)));
      reserved = await reserve();
      continue;
    }
    if (existing.method !== method || existing.path !== path || existing.bodyHash !== bodyHash)
      return errorResponse(
        "IDEMPOTENCY_KEY_MISMATCH",
        "this Idempotency-Key was used for a different request",
      );
    if (existing.state === "completed") {
      const headers = new Headers(existing.responseHeaders);
      headers.set(REPLAYED_HEADER, "true");
      return new Response(
        existing.responseStatus === 204 ? null : Buffer.from(existing.responseBody, "base64"),
        { status: existing.responseStatus ?? 200, headers },
      );
    }
    if (existing.lockedUntil > now)
      return errorResponse(
        "IDEMPOTENCY_IN_PROGRESS",
        "a request with this Idempotency-Key is still in progress",
      );
    // Abandoned by a crashed instance: take it over, once.
    const taken = await db
      .update(t)
      .set({ lockedUntil: new Date(now.getTime() + LEASE_MS) })
      .where(and(where, eq(t.state, "in_progress"), eq(t.lockedUntil, existing.lockedUntil)))
      .returning({ key: t.key });
    reserved = taken.length > 0;
  }
  if (!reserved)
    return errorResponse(
      "IDEMPOTENCY_IN_PROGRESS",
      "a request with this Idempotency-Key is still in progress",
    );

  const release = () => db.delete(t).where(and(where, eq(t.state, "in_progress")));
  let response: Response | null;
  try {
    response = await handle(
      new Request(request.url, {
        method,
        headers: request.headers,
        body: body.byteLength ? body : undefined,
      }),
    );
  } catch (error) {
    await release();
    throw error;
  }
  if (!response || response.status >= 500 || response.status === 401 || response.status === 429) {
    await release();
    return response;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const headers: Record<string, string> = {};
  for (const name of STORED_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  await db
    .update(t)
    .set({
      state: "completed",
      responseStatus: response.status,
      responseHeaders: headers,
      responseBody: Buffer.from(bytes).toString("base64"),
    })
    .where(where);
  return new Response(response.status === 204 ? null : bytes, {
    status: response.status,
    headers: response.headers,
  });
}

/** Deletes records older than the retention (worker, hourly). */
export async function pruneIdempotencyKeys(db: Database, now = new Date()): Promise<number> {
  const rows = await db
    .delete(schema.idempotencyKey)
    .where(lt(schema.idempotencyKey.expiresAt, now))
    .returning({ key: schema.idempotencyKey.key });
  return rows.length;
}
