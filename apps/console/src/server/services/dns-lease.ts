import { randomUUID } from "node:crypto";
import { schema } from "@edgeweir/db";
import { and, eq, lt } from "drizzle-orm";
import type { Executor } from "./revisions";

/**
 * Takes the lease `key` for `seconds` unless another holder has it; returns
 * the holder token or null. Leases replace session advisory locks for DNS
 * work that waits on providers: nothing holds a database connection while a
 * provider answers, and a crashed process gives the lease up when it expires.
 */
export async function acquireLease(db: Executor, key: string, seconds: number) {
  const holder = randomUUID();
  const now = new Date();
  const [row] = await db
    .insert(schema.dnsLease)
    .values({ key, holder, until: new Date(now.getTime() + seconds * 1000) })
    .onConflictDoUpdate({
      target: schema.dnsLease.key,
      set: { holder, until: new Date(now.getTime() + seconds * 1000) },
      setWhere: lt(schema.dnsLease.until, now),
    })
    .returning({ holder: schema.dnsLease.holder });
  return row?.holder === holder ? holder : null;
}

export async function releaseLease(db: Executor, key: string, holder: string) {
  await db
    .delete(schema.dnsLease)
    .where(and(eq(schema.dnsLease.key, key), eq(schema.dnsLease.holder, holder)));
}

/** Runs `work` under the lease, or returns `busy` without running it. */
export async function withLease<T>(
  db: Executor,
  key: string,
  seconds: number,
  work: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const holder = await acquireLease(db, key, seconds);
  if (!holder) return { ran: false };
  try {
    return { ran: true, value: await work() };
  } finally {
    await releaseLease(db, key, holder);
  }
}
