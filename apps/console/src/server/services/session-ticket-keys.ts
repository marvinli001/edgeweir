import { randomBytes } from "node:crypto";
import type { ChallengeKeyModel } from "@edgeweir/config-compiler";
import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import type { Envelope } from "../lib/envelope";
import { lockClusterPublish } from "../lib/locks";
import { recordAudit, systemActor } from "./audit";
import { type Executor, latestRevision, publishRevision } from "./revisions";

/**
 * TLS session ticket keys of a cluster: nodes encrypt tickets with current
 * and decrypt with all three, so a node that applies a rotation before
 * another still accepts the tickets the other one issues, and back. The
 * roles shift every 12 hours; nodes accept a ticket for at most an hour
 * (ssl_session_timeout), long before the key that encrypted it is dropped.
 */
export const SESSION_TICKET_KEY_ROLES = ["next", "current", "previous"] as const;
export type SessionTicketKeyRole = (typeof SESSION_TICKET_KEY_ROLES)[number];
/** Keys rotate once the newest of them is this old. */
export const SESSION_TICKET_KEY_ROTATION_MS = 12 * 3600 * 1000;
/**
 * Secrets are 80 random bytes, the file format of nginx's
 * ssl_session_ticket_key: a 16-byte key name, a 32-byte AES-256 key and a
 * 32-byte HMAC-SHA256 key.
 */
export const SESSION_TICKET_KEY_BYTES = 80;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Envelope binding of a session ticket key's secret: the column and the key row (AAD). */
export const sessionTicketKeyBinding = (id: string) => ({
  purpose: "session_ticket_key.secret",
  recordId: id,
});

/**
 * The cluster's three keys, created when a configuration of the cluster
 * first carries them. Call with the cluster's publish lock held. Secrets are
 * generated when a node first fetches a key (sessionTicketKeySecrets), where
 * the master key is at hand.
 */
export async function ensureSessionTicketKeys(
  tx: Executor,
  clusterId: string,
): Promise<ChallengeKeyModel[]> {
  const load = () =>
    tx
      .select({ id: schema.sessionTicketKey.id, role: schema.sessionTicketKey.role })
      .from(schema.sessionTicketKey)
      .where(eq(schema.sessionTicketKey.clusterId, clusterId));
  let keys = await load();
  const missing = SESSION_TICKET_KEY_ROLES.filter((role) => !keys.some((key) => key.role === role));
  if (missing.length) {
    await tx
      .insert(schema.sessionTicketKey)
      .values(missing.map((role) => ({ clusterId, role })))
      .onConflictDoNothing();
    keys = await load();
  }
  return keys;
}

/**
 * Rotates the keys of every cluster whose newest key is at least 12 hours
 * old: previous is dropped, current becomes previous, next becomes current
 * and a new next is created. Clusters whose latest configuration carries
 * the keys get a new revision (reason session_ticket_keys_rotated); nodes
 * then write the new key files and reload. Returns the rotated cluster ids.
 */
export async function rotateSessionTicketKeys(
  app: AppContext,
  now = new Date(),
): Promise<string[]> {
  const clusters = await app.db
    .select({
      clusterId: schema.sessionTicketKey.clusterId,
      newest: sql<string>`max(${schema.sessionTicketKey.createdAt})`,
    })
    .from(schema.sessionTicketKey)
    .groupBy(schema.sessionTicketKey.clusterId)
    .orderBy(schema.sessionTicketKey.clusterId);
  const due = clusters.filter(
    (c) => new Date(c.newest).getTime() <= now.getTime() - SESSION_TICKET_KEY_ROTATION_MS,
  );
  const rotated: string[] = [];
  for (const { clusterId } of due) {
    try {
      const done = await app.db.transaction(async (tx) => {
        await lockClusterPublish(tx, clusterId);
        const keys = await tx
          .select()
          .from(schema.sessionTicketKey)
          .where(eq(schema.sessionTicketKey.clusterId, clusterId))
          .for("update");
        const newest = Math.max(...keys.map((key) => key.createdAt.getTime()));
        if (newest > now.getTime() - SESSION_TICKET_KEY_ROTATION_MS) return false;
        const role = (r: SessionTicketKeyRole) => keys.find((key) => key.role === r);
        const dropped = role("previous");
        if (dropped)
          await tx
            .delete(schema.sessionTicketKey)
            .where(eq(schema.sessionTicketKey.id, dropped.id));
        for (const [from, to] of [
          ["current", "previous"],
          ["next", "current"],
        ] as const) {
          const key = role(from);
          if (key)
            await tx
              .update(schema.sessionTicketKey)
              .set({ role: to })
              .where(eq(schema.sessionTicketKey.id, key.id));
        }
        await tx
          .insert(schema.sessionTicketKey)
          .values({ clusterId, role: "next", createdAt: now })
          .onConflictDoNothing();
        await ensureSessionTicketKeys(tx, clusterId);
        const latest = await latestRevision(tx, clusterId);
        const published =
          latest && decodeNodeConfig(latest.ir).sessionTicketKeys.length > 0
            ? await publishRevision(tx, {
                clusterId,
                reason: { code: "session_ticket_keys_rotated", params: {} },
                actor: systemActor,
              })
            : undefined;
        const [cluster] = await tx
          .select({ name: schema.cluster.name })
          .from(schema.cluster)
          .where(eq(schema.cluster.id, clusterId));
        await recordAudit(tx, systemActor, {
          action: "cluster.session_ticket_keys_rotate",
          targetType: "cluster",
          targetId: clusterId,
          targetName: cluster?.name ?? "",
          metadata: {
            droppedKeyId: dropped?.id ?? null,
            revision: published?.created ? published.row.revision : null,
          },
        });
        return true;
      });
      if (done) rotated.push(clusterId);
    } catch (error) {
      app.log.error("session ticket key rotation failed", { clusterId, error });
    }
  }
  return rotated;
}

/**
 * The secrets of the requested keys of `clusterId` (keys of other clusters
 * and unknown ids are left out). A key without a secret gets one now, under
 * a row lock, so every node of the cluster receives the same secret.
 */
export async function sessionTicketKeySecrets(
  app: AppContext,
  clusterId: string,
  ids: string[],
): Promise<{ id: string; secret: Uint8Array }[]> {
  const wanted = [...new Set(ids.map((id) => id.toLowerCase()))]
    .filter((id) => UUID_RE.test(id))
    .slice(0, 16);
  if (wanted.length === 0) return [];
  const scope = and(
    eq(schema.sessionTicketKey.clusterId, clusterId),
    inArray(schema.sessionTicketKey.id, wanted),
  );
  const pending = await app.db
    .select({ id: schema.sessionTicketKey.id })
    .from(schema.sessionTicketKey)
    .where(and(scope, isNull(schema.sessionTicketKey.secret)));
  if (pending.length)
    await app.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.sessionTicketKey)
        .where(and(scope, isNull(schema.sessionTicketKey.secret)))
        .for("update");
      for (const row of rows)
        await tx
          .update(schema.sessionTicketKey)
          .set({
            secret: JSON.stringify(
              app.masterKey.seal(
                randomBytes(SESSION_TICKET_KEY_BYTES),
                sessionTicketKeyBinding(row.id),
              ),
            ),
          })
          .where(eq(schema.sessionTicketKey.id, row.id));
    });
  const rows = await app.db.select().from(schema.sessionTicketKey).where(scope);
  return rows.flatMap((row) => {
    if (!row.secret) return [];
    try {
      const secret = app.masterKey.open(
        JSON.parse(row.secret) as Envelope,
        sessionTicketKeyBinding(row.id),
      );
      if (secret.length !== SESSION_TICKET_KEY_BYTES) throw new Error("unexpected key length");
      return [{ id: row.id, secret: new Uint8Array(secret) }];
    } catch (error) {
      app.log.error("cannot open session ticket key", { keyId: row.id, error });
      return [];
    }
  });
}
