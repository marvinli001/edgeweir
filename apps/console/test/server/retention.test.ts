import { randomUUID } from "node:crypto";
import { schema } from "@edgeweir/db";
import { eq, inArray, lt } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { deleteInBatches } from "../../src/server/lib/retention";
import { sweepAlerts } from "../../src/server/services/alerts";
import {
  CACHE_TASK_RETENTION_MS,
  hasDeliverableTasks,
  pruneCacheTasks,
} from "../../src/server/services/cache-tasks";
import { createTestContext } from "./helpers";

const DAY = 86400_000;

describe("retention", async () => {
  const { ctx, client } = await createTestContext();
  afterAll(() => client.close());

  it("deletes in batches of the given size and returns the count", async () => {
    const now = Date.now();
    const event = (occurredAt: number) => ({
      kind: "dns_mass_removal_blocked",
      resourceId: randomUUID(),
      status: "firing",
      payload: { siteName: "batch", domain: "" },
      occurredAt: new Date(occurredAt),
    });
    await ctx.db
      .insert(schema.alertEvent)
      .values([
        ...Array.from({ length: 12 }, (_, i) => event(now - 100 * DAY - i)),
        ...Array.from({ length: 3 }, () => event(now)),
      ]);
    const execute = vi.spyOn(ctx.db, "execute");
    try {
      const old = lt(schema.alertEvent.occurredAt, new Date(now - 90 * DAY));
      expect(await deleteInBatches(ctx.db, schema.alertEvent, old, 5)).toBe(12);
      // 5, 5 and 2 rows: the short batch ends it.
      expect(execute).toHaveBeenCalledTimes(3);
      execute.mockClear();
      expect(await deleteInBatches(ctx.db, schema.alertEvent, old, 5)).toBe(0);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      execute.mockRestore();
    }
    const left = await ctx.db.select().from(schema.alertEvent);
    expect(left).toHaveLength(3);
    expect(left.every((e) => e.occurredAt.getTime() === now)).toBe(true);
    await ctx.db.delete(schema.alertEvent);
  });

  it("deletes old cache tasks except purges a node has yet to make up and open deliveries", async () => {
    const now = new Date();
    const old = new Date(now.getTime() - CACHE_TASK_RETENTION_MS - DAY);
    const clusterId = randomUUID();
    await ctx.db.insert(schema.cluster).values({ id: clusterId, name: "retention" });
    const [active, disabled] = await ctx.db
      .insert(schema.node)
      .values([
        { clusterId, name: "active" },
        { clusterId, name: "disabled", status: "disabled" },
      ])
      .returning();
    if (!active || !disabled) throw new Error("nodes missing");
    const task = async (
      name: string,
      type: string,
      createdAt: Date,
      deliveries: Partial<typeof schema.cacheTaskNode.$inferInsert>[],
    ) => {
      const [row] = await ctx.db
        .insert(schema.cacheTask)
        .values({
          type,
          targets: [name],
          payload: [{ siteId: randomUUID(), clusterId, type }],
          createdAt,
          finishedAt: createdAt,
        })
        .returning();
      if (!row) throw new Error("task missing");
      if (deliveries.length)
        await ctx.db
          .insert(schema.cacheTaskNode)
          .values(deliveries.map((d) => ({ taskId: row.id, nodeId: active.id, clusterId, ...d })));
      return [name, row.id] as const;
    };
    const expired = { state: "failed", errorCode: "task_expired" };
    const tasks = Object.fromEntries([
      await task("done", "url", old, [{ state: "succeeded" }]),
      await task("missed", "url", old, [expired]),
      await task("made up", "prefix", old, [{ ...expired, recoveredAt: now }]),
      await task("prefetch", "prefetch", old, [expired]),
      await task("skipped", "site", old, [
        { nodeId: disabled.id, state: "skipped", errorCode: "node_disabled" },
      ]),
      await task("failed", "url", old, [{ state: "failed", errorCode: "purge_failed" }]),
      await task("open", "url", old, [{ state: "running" }]),
      await task("no nodes", "url", old, []),
      await task("recent", "url", now, [{ state: "succeeded" }]),
    ]);
    expect(await pruneCacheTasks(ctx.db, now)).toBe(5);
    const kept = await ctx.db
      .select({ id: schema.cacheTask.id })
      .from(schema.cacheTask)
      .where(inArray(schema.cacheTask.id, Object.values(tasks)));
    expect(new Set(kept.map((k) => k.id))).toEqual(
      new Set([tasks.missed, tasks.skipped, tasks.open, tasks.recent]),
    );
    // Deliveries go with their tasks.
    const deliveries = await ctx.db
      .select({ taskId: schema.cacheTaskNode.taskId })
      .from(schema.cacheTaskNode)
      .where(eq(schema.cacheTaskNode.clusterId, clusterId));
    expect(new Set(deliveries.map((d) => d.taskId))).toEqual(new Set(kept.map((k) => k.id)));
    // The kept purge is still made up when the node pulls tasks.
    expect(await hasDeliverableTasks(ctx.db, active.id)).toBe(true);
    expect(await pruneCacheTasks(ctx.db, now)).toBe(0);
  });

  it("cancels a delivery still pending for an alert event older than a day", async () => {
    const now = Date.now();
    const resourceId = randomUUID();
    await ctx.db.insert(schema.alertState).values({
      key: `dns_mass_removal_blocked/platform/${resourceId}`,
      kind: "dns_mass_removal_blocked",
      resourceId,
      active: true,
      updatedAt: new Date(now - 2 * DAY),
    });
    const [event] = await ctx.db
      .insert(schema.alertEvent)
      .values({
        kind: "dns_mass_removal_blocked",
        resourceId,
        status: "firing",
        payload: { siteName: "edge", domain: "" },
        occurredAt: new Date(now - 2 * DAY),
      })
      .returning();
    const [channel] = await ctx.db
      .insert(schema.alertChannel)
      .values({ name: "platform", kind: "webhook", platform: true, configEnvelope: "{}" })
      .returning();
    if (!event || !channel) throw new Error("fixture missing");
    await ctx.db.insert(schema.alertDelivery).values({
      eventId: event.id,
      channelId: channel.id,
      nextAttemptAt: new Date(now - 2 * DAY),
    });
    await sweepAlerts(ctx, now);
    const [delivery] = await ctx.db
      .select()
      .from(schema.alertDelivery)
      .where(eq(schema.alertDelivery.eventId, event.id));
    expect(delivery).toMatchObject({ status: "cancelled", attempts: 0 });
  });
});
