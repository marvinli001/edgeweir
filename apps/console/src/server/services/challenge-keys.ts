import { randomBytes } from "node:crypto";
import type { ChallengeKeyModel } from "@edgeweir/config-compiler";
import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import type { Envelope } from "../lib/envelope";
import { recordAudit, systemActor } from "./audit";
import { type Executor, latestRevision, publishRevision } from "./revisions";

/**
 * Pass keys of a cluster: nodes sign with current and accept all three. The
 * roles shift once a day, so a pass (at most 24 hours) expires before the
 * key that signed it is dropped, and during a canary the nodes on either
 * revision hold the key the other ones sign with.
 */
export const CHALLENGE_KEY_ROLES = ["next", "current", "previous"] as const;
export type ChallengeKeyRole = (typeof CHALLENGE_KEY_ROLES)[number];
/** Keys rotate once the newest of them is this old. */
export const CHALLENGE_KEY_ROTATION_MS = 24 * 3600 * 1000;
/** Secrets are 32 random bytes. */
export const CHALLENGE_KEY_BYTES = 32;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const binding = (id: string) => ({ purpose: "challenge_key.secret", recordId: id });

/**
 * The cluster's three keys, created when a cluster first needs them. Call
 * with the cluster's publish lock held. Secrets are generated when a node
 * first fetches a key (challengeKeySecrets), where the master key is at hand.
 */
export async function ensureChallengeKeys(
  tx: Executor,
  clusterId: string,
): Promise<ChallengeKeyModel[]> {
  const load = () =>
    tx
      .select({ id: schema.challengeKey.id, role: schema.challengeKey.role })
      .from(schema.challengeKey)
      .where(eq(schema.challengeKey.clusterId, clusterId));
  let keys = await load();
  const missing = CHALLENGE_KEY_ROLES.filter((role) => !keys.some((key) => key.role === role));
  if (missing.length) {
    await tx
      .insert(schema.challengeKey)
      .values(missing.map((role) => ({ clusterId, role })))
      .onConflictDoNothing();
    keys = await load();
  }
  return keys;
}

/**
 * Rotates the keys of every cluster whose newest key is at least a day old:
 * previous is dropped, current becomes previous, next becomes current and a
 * new next is created. Clusters whose latest configuration carries the keys
 * get a new revision (reason challenge_keys_rotated). Returns the rotated
 * cluster ids.
 */
export async function rotateChallengeKeys(app: AppContext, now = new Date()): Promise<string[]> {
  const clusters = await app.db
    .select({
      clusterId: schema.challengeKey.clusterId,
      newest: sql<string>`max(${schema.challengeKey.createdAt})`,
    })
    .from(schema.challengeKey)
    .groupBy(schema.challengeKey.clusterId)
    .orderBy(schema.challengeKey.clusterId);
  const due = clusters.filter(
    (c) => new Date(c.newest).getTime() <= now.getTime() - CHALLENGE_KEY_ROTATION_MS,
  );
  const rotated: string[] = [];
  for (const { clusterId } of due) {
    try {
      const done = await app.db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`edgeweir.publish.${clusterId}`}))`,
        );
        const keys = await tx
          .select()
          .from(schema.challengeKey)
          .where(eq(schema.challengeKey.clusterId, clusterId))
          .for("update");
        const newest = Math.max(...keys.map((key) => key.createdAt.getTime()));
        if (newest > now.getTime() - CHALLENGE_KEY_ROTATION_MS) return false;
        const role = (r: ChallengeKeyRole) => keys.find((key) => key.role === r);
        const dropped = role("previous");
        if (dropped)
          await tx.delete(schema.challengeKey).where(eq(schema.challengeKey.id, dropped.id));
        for (const [from, to] of [
          ["current", "previous"],
          ["next", "current"],
        ] as const) {
          const key = role(from);
          if (key)
            await tx
              .update(schema.challengeKey)
              .set({ role: to })
              .where(eq(schema.challengeKey.id, key.id));
        }
        await tx
          .insert(schema.challengeKey)
          .values({ clusterId, role: "next", createdAt: now })
          .onConflictDoNothing();
        await ensureChallengeKeys(tx, clusterId);
        const latest = await latestRevision(tx, clusterId);
        const published =
          latest && decodeNodeConfig(latest.ir).challengeKeys.length > 0
            ? await publishRevision(tx, {
                clusterId,
                reason: { code: "challenge_keys_rotated", params: {} },
                userId: null,
              })
            : undefined;
        const [cluster] = await tx
          .select({ name: schema.cluster.name })
          .from(schema.cluster)
          .where(eq(schema.cluster.id, clusterId));
        await recordAudit(tx, systemActor, {
          action: "cluster.challenge_keys_rotate",
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
      app.log.error("challenge key rotation failed", { clusterId, error });
    }
  }
  return rotated;
}

/**
 * The secrets of the requested keys of `clusterId` (keys of other clusters
 * and unknown ids are left out). A key without a secret gets one now, under
 * a row lock, so every node of the cluster receives the same secret.
 */
export async function challengeKeySecrets(
  app: AppContext,
  clusterId: string,
  ids: string[],
): Promise<{ id: string; secret: Uint8Array }[]> {
  const wanted = [...new Set(ids.map((id) => id.toLowerCase()))]
    .filter((id) => UUID_RE.test(id))
    .slice(0, 16);
  if (wanted.length === 0) return [];
  const scope = and(
    eq(schema.challengeKey.clusterId, clusterId),
    inArray(schema.challengeKey.id, wanted),
  );
  const pending = await app.db
    .select({ id: schema.challengeKey.id })
    .from(schema.challengeKey)
    .where(and(scope, isNull(schema.challengeKey.secret)));
  if (pending.length)
    await app.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(schema.challengeKey)
        .where(and(scope, isNull(schema.challengeKey.secret)))
        .for("update");
      for (const row of rows)
        await tx
          .update(schema.challengeKey)
          .set({
            secret: JSON.stringify(
              app.masterKey.seal(randomBytes(CHALLENGE_KEY_BYTES), binding(row.id)),
            ),
          })
          .where(eq(schema.challengeKey.id, row.id));
    });
  const rows = await app.db.select().from(schema.challengeKey).where(scope);
  return rows.flatMap((row) => {
    if (!row.secret) return [];
    try {
      const secret = app.masterKey.open(JSON.parse(row.secret) as Envelope, binding(row.id));
      if (secret.length !== CHALLENGE_KEY_BYTES) throw new Error("unexpected key length");
      return [{ id: row.id, secret: new Uint8Array(secret) }];
    } catch (error) {
      app.log.error("cannot open challenge key", { keyId: row.id, error });
      return [];
    }
  });
}
