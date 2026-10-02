import { randomUUID } from "node:crypto";
import { schema } from "@edgeweir/db";
import { eq, lt } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { deleteInBatches } from "../../src/server/lib/retention";
import { sweepAlerts } from "../../src/server/services/alerts";
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
