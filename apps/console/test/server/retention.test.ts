import { randomUUID } from "node:crypto";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { sweepAlerts } from "../../src/server/services/alerts";
import { createTestContext } from "./helpers";

const DAY = 86400_000;

describe("retention", async () => {
  const { ctx, client } = await createTestContext();
  afterAll(() => client.close());

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
