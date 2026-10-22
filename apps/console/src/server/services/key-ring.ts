import { randomBytes } from "node:crypto";
import type { ChallengeKeyModel } from "@edgeweir/config-compiler";
import { decodeNodeConfig } from "@edgeweir/config-compiler";
import type { AuditAction } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import type { Envelope } from "../lib/envelope";
import { lockClusterPublish } from "../lib/locks";
import { recordAudit, systemActor } from "./audit";
import { type Executor, latestRevision, publishRevision } from "./revisions";

/**
 * A cluster's rotating keys: next, current and previous. Nodes use current
 * and accept all three; each rotation drops previous, shifts the other two
 * down and creates a new next. Secrets are generated when a node first
 * fetches a key, where the master key is at hand, and sealed to the row.
 */
const ROLES = ["next", "current", "previous"] as const;
type Role = (typeof ROLES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface KeyRingOptions {
  table: typeof schema.challengeKey | typeof schema.sessionTicketKey;
  /** Keys rotate once the newest of them is this old. */
  rotationMs: number;
  /** Length of a secret. */
  bytes: number;
  /** Envelope purpose of the secret column. */
  purpose: string;
  /** The configuration field that carries the keys. */
  configField: "challengeKeys" | "sessionTicketKeys";
  /** Revision reason and audit action of a rotation. */
  reason: "challenge_keys_rotated" | "session_ticket_keys_rotated";
  action: AuditAction;
  /** For log messages, e.g. "challenge key". */
  label: string;
}

export function keyRing(o: KeyRingOptions) {
  const { table } = o;

  /** Envelope binding of a key's secret: the column and the key row (AAD). */
  const binding = (id: string) => ({ purpose: o.purpose, recordId: id });

  /**
   * The cluster's three keys, created when a cluster first needs them. Call
   * with the cluster's publish lock held.
   */
  async function ensure(tx: Executor, clusterId: string): Promise<ChallengeKeyModel[]> {
    const load = () =>
      tx
        .select({ id: table.id, role: table.role })
        .from(table)
        .where(eq(table.clusterId, clusterId));
    let keys = await load();
    const missing = ROLES.filter((role) => !keys.some((key) => key.role === role));
    if (missing.length) {
      await tx
        .insert(table)
        .values(missing.map((role) => ({ clusterId, role })))
        .onConflictDoNothing();
      keys = await load();
    }
    return keys;
  }

  /**
   * Rotates the keys of every cluster whose newest key is at least
   * `rotationMs` old. Clusters whose latest configuration carries the keys
   * get a new revision. Returns the rotated cluster ids.
   */
  async function rotate(app: AppContext, now = new Date()): Promise<string[]> {
    const clusters = await app.db
      .select({ clusterId: table.clusterId, newest: sql<string>`max(${table.createdAt})` })
      .from(table)
      .groupBy(table.clusterId)
      .orderBy(table.clusterId);
    const due = clusters.filter(
      (c) => new Date(c.newest).getTime() <= now.getTime() - o.rotationMs,
    );
    const rotated: string[] = [];
    for (const { clusterId } of due) {
      try {
        const done = await app.db.transaction(async (tx) => {
          await lockClusterPublish(tx, clusterId);
          const keys = await tx
            .select()
            .from(table)
            .where(eq(table.clusterId, clusterId))
            .for("update");
          const newest = Math.max(...keys.map((key) => key.createdAt.getTime()));
          if (newest > now.getTime() - o.rotationMs) return false;
          const role = (r: Role) => keys.find((key) => key.role === r);
          const dropped = role("previous");
          if (dropped) await tx.delete(table).where(eq(table.id, dropped.id));
          for (const [from, to] of [
            ["current", "previous"],
            ["next", "current"],
          ] as const) {
            const key = role(from);
            if (key) await tx.update(table).set({ role: to }).where(eq(table.id, key.id));
          }
          await tx
            .insert(table)
            .values({ clusterId, role: "next", createdAt: now })
            .onConflictDoNothing();
          await ensure(tx, clusterId);
          const latest = await latestRevision(tx, clusterId);
          const published =
            latest && decodeNodeConfig(latest.ir)[o.configField].length > 0
              ? await publishRevision(tx, {
                  clusterId,
                  reason: { code: o.reason, params: {} },
                  actor: systemActor,
                })
              : undefined;
          const [cluster] = await tx
            .select({ name: schema.cluster.name })
            .from(schema.cluster)
            .where(eq(schema.cluster.id, clusterId));
          await recordAudit(tx, systemActor, {
            action: o.action,
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
        app.log.error(`${o.label} rotation failed`, { clusterId, error });
      }
    }
    return rotated;
  }

  /**
   * The secrets of the requested keys of `clusterId` (keys of other clusters
   * and unknown ids are left out). A key without a secret gets one now, under
   * a row lock, so every node of the cluster receives the same secret.
   */
  async function secrets(
    app: AppContext,
    clusterId: string,
    ids: string[],
  ): Promise<{ id: string; secret: Uint8Array }[]> {
    const wanted = [...new Set(ids.map((id) => id.toLowerCase()))]
      .filter((id) => UUID_RE.test(id))
      .slice(0, 16);
    if (wanted.length === 0) return [];
    const scope = and(eq(table.clusterId, clusterId), inArray(table.id, wanted));
    const pending = await app.db
      .select({ id: table.id })
      .from(table)
      .where(and(scope, isNull(table.secret)));
    if (pending.length)
      await app.db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(table)
          .where(and(scope, isNull(table.secret)))
          .for("update");
        for (const row of rows)
          await tx
            .update(table)
            .set({
              secret: JSON.stringify(app.masterKey.seal(randomBytes(o.bytes), binding(row.id))),
            })
            .where(eq(table.id, row.id));
      });
    const rows = await app.db.select().from(table).where(scope);
    return rows.flatMap((row) => {
      if (!row.secret) return [];
      try {
        const secret = app.masterKey.open(JSON.parse(row.secret) as Envelope, binding(row.id));
        if (secret.length !== o.bytes) throw new Error("unexpected key length");
        return [{ id: row.id, secret: new Uint8Array(secret) }];
      } catch (error) {
        app.log.error(`cannot open ${o.label}`, { keyId: row.id, error });
        return [];
      }
    });
  }

  return { binding, ensure, rotate, secrets };
}
