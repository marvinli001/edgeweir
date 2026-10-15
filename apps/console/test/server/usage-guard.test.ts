import { schema } from "@edgeweir/db";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { readMaintenance } from "../../src/server/lib/site-content";
import { alertConditions, getAlertPolicy } from "../../src/server/services/alerts";
import { ingestStatsBatch } from "../../src/server/services/stats";
import { rollupUsage } from "../../src/server/services/usage";
import {
  assessGuard,
  currentBandwidth,
  evaluateUsageGuard,
  periodBounds,
  periodUsage,
} from "../../src/server/services/usage-guard";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe("usage protection periods", () => {
  const bounds = (period: "day" | "month", zone: string, now: string) => {
    const { start, end } = periodBounds(period, zone, Date.parse(now));
    return [start.toISOString(), end.toISOString()];
  };

  it("takes the calendar day or month in UTC", () => {
    expect(bounds("day", "UTC", "2026-10-15T13:00:00Z")).toEqual([
      "2026-10-15T00:00:00.000Z",
      "2026-10-16T00:00:00.000Z",
    ]);
    expect(bounds("month", "UTC", "2026-10-15T13:00:00Z")).toEqual([
      "2026-10-01T00:00:00.000Z",
      "2026-11-01T00:00:00.000Z",
    ]);
    expect(bounds("month", "UTC", "2026-12-31T23:59:59Z")).toEqual([
      "2026-12-01T00:00:00.000Z",
      "2027-01-01T00:00:00.000Z",
    ]);
    // A leap year's February.
    expect(bounds("month", "UTC", "2028-02-29T12:00:00Z")).toEqual([
      "2028-02-01T00:00:00.000Z",
      "2028-03-01T00:00:00.000Z",
    ]);
  });

  it("starts at midnight in the guard's time zone", () => {
    // 04:00 on 16 October in Shanghai (UTC+8).
    expect(bounds("day", "Asia/Shanghai", "2026-10-15T20:00:00Z")).toEqual([
      "2026-10-15T16:00:00.000Z",
      "2026-10-16T16:00:00.000Z",
    ]);
    // 01:00 on 1 January 2027 in Shanghai: the new month and year.
    expect(bounds("month", "Asia/Shanghai", "2026-12-31T17:00:00Z")).toEqual([
      "2026-12-31T16:00:00.000Z",
      "2027-01-31T16:00:00.000Z",
    ]);
    // Auckland in daylight saving time (UTC+13).
    expect(bounds("month", "Pacific/Auckland", "2026-12-31T12:00:00Z")).toEqual([
      "2026-12-31T11:00:00.000Z",
      "2027-01-31T11:00:00.000Z",
    ]);
  });

  it("gives a daylight saving transition day 23 or 25 hours", () => {
    const spring = bounds("day", "America/New_York", "2026-03-08T15:00:00Z");
    expect(spring).toEqual(["2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"]);
    const fall = bounds("day", "America/New_York", "2026-11-01T15:00:00Z");
    expect(fall).toEqual(["2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]);
  });

  it("lands on 5-minute usage windows in a zone with a 45-minute offset", () => {
    // 17:45 in Kathmandu (UTC+5:45).
    const { start, end } = periodBounds(
      "day",
      "Asia/Kathmandu",
      Date.parse("2026-10-15T12:00:00Z"),
    );
    expect([start.toISOString(), end.toISOString()]).toEqual([
      "2026-10-14T18:15:00.000Z",
      "2026-10-15T18:15:00.000Z",
    ]);
    expect(start.getTime() % 300_000).toBe(0);
    expect(end.getTime() % 300_000).toBe(0);
  });

  it("puts the start in its period and the end in the next", () => {
    const { start, end } = periodBounds("day", "Asia/Shanghai", Date.parse("2026-10-15T20:00:00Z"));
    expect(periodBounds("day", "Asia/Shanghai", start.getTime()).start).toEqual(start);
    expect(periodBounds("day", "Asia/Shanghai", end.getTime() - 1).end).toEqual(end);
    expect(periodBounds("day", "Asia/Shanghai", end.getTime()).start).toEqual(end);
  });
});

describe("usage protection assessment", () => {
  const base = {
    siteId: "00000000-0000-4000-8000-000000000000",
    period: "day",
    timeZone: "UTC",
    bytesLimit: null,
    requestsLimit: null,
    bandwidthBps: null,
    warnPercent: 80,
    action: "maintenance",
    recovery: "auto",
    bandwidthHoldMinutes: 30,
    updatedAt: new Date(0),
    periodStart: null,
    periodEnd: null,
    warnMetrics: [],
    limitMetrics: [],
    bandwidthPeakBps: 0,
    bandwidthBreachedAt: null,
    heldAction: null,
    heldMetric: null,
    heldSince: null,
    pausedUntil: null,
    lastError: "",
    evaluatedAt: null,
  } satisfies typeof schema.siteUsageGuard.$inferSelect;
  const period = { start: new Date("2026-10-15T00:00:00Z"), end: new Date("2026-10-16T00:00:00Z") };
  const now = new Date("2026-10-15T12:00:00Z");

  it("compares exact counters beyond 2^53 at the warning threshold and the limit", () => {
    const limit = 10n ** 20n;
    const row = { ...base, bytesLimit: limit.toString(), requestsLimit: "1000" };
    const measure = (bytes: bigint, requests: bigint) =>
      assessGuard(row, { period, bytes, requests, bandwidthBps: 0 }, now);
    expect(measure((limit * 8n) / 10n - 1n, 0n)).toMatchObject({
      warn: [],
      limit: [],
      exceeded: null,
    });
    expect(measure((limit * 8n) / 10n, 0n)).toMatchObject({ warn: ["bytes"], limit: [] });
    expect(measure(limit, 999n)).toMatchObject({
      warn: ["bytes", "requests"],
      limit: ["bytes"],
      exceeded: "bytes",
    });
    expect(measure(0n, 1000n)).toMatchObject({ limit: ["requests"], exceeded: "requests" });
    // No warning threshold: only the limit.
    expect(
      assessGuard(
        { ...row, warnPercent: null },
        { period, bytes: limit, requests: 0n, bandwidthBps: 0 },
        now,
      ),
    ).toMatchObject({ warn: [], limit: ["bytes"] });
  });

  it("keeps the period's bandwidth peak and holds the action for the hold time (auto)", () => {
    const row = { ...base, bandwidthBps: 8000 };
    const over = assessGuard(row, { period, bytes: 0n, requests: 0n, bandwidthBps: 9000 }, now);
    expect(over).toMatchObject({ peak: 9000, limit: ["bandwidth"], exceeded: "bandwidth" });
    expect(over.breachedAt).toEqual(now);
    const later = (minutes: number) =>
      assessGuard(
        { ...row, periodStart: period.start, bandwidthPeakBps: 9000, bandwidthBreachedAt: now },
        { period, bytes: 0n, requests: 0n, bandwidthBps: 0 },
        new Date(now.getTime() + minutes * MINUTE),
      );
    // The peak keeps the alert for the period; the action holds for 30 minutes.
    expect(later(29)).toMatchObject({ peak: 9000, limit: ["bandwidth"], exceeded: "bandwidth" });
    expect(later(30)).toMatchObject({ peak: 9000, limit: ["bandwidth"], exceeded: null });
    // Manual recovery holds it for the period.
    expect(
      assessGuard(
        {
          ...row,
          recovery: "manual",
          periodStart: period.start,
          bandwidthPeakBps: 9000,
          bandwidthBreachedAt: now,
        },
        { period, bytes: 0n, requests: 0n, bandwidthBps: 0 },
        new Date(now.getTime() + 5 * HOUR),
      ),
    ).toMatchObject({ exceeded: "bandwidth" });
    // A new period starts from the current bandwidth.
    const next = { start: period.end, end: new Date(period.end.getTime() + DAY) };
    expect(
      assessGuard(
        { ...row, periodStart: period.start, bandwidthPeakBps: 9000, bandwidthBreachedAt: now },
        { period: next, bytes: 0n, requests: 0n, bandwidthBps: 100 },
        new Date(period.end.getTime() + MINUTE),
      ),
    ).toMatchObject({ peak: 100, limit: [], exceeded: null });
  });
});

describe("usage protection", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let node: { id: string; clusterId: string };
  let sequence = 1n;
  // Noon (UTC) two days ago: the guards below use daily UTC periods.
  const day0 = Math.floor(Date.now() / DAY) * DAY - 2 * DAY;
  const noon = day0 + 12 * HOUR;
  const nextDay = day0 + DAY + MINUTE;

  const report = (
    target: { id: string; clusterId: string },
    siteId: string,
    minute: number,
    requests: number,
    bytesSent: number,
  ) =>
    ingestStatsBatch(
      ctx.db,
      target,
      sequence++,
      [
        {
          minute: new Date(minute),
          siteId,
          requests,
          bytesSent,
          bytesReceived: 0,
          cacheHits: 0,
          cacheMisses: 0,
          statusCodes: { "200": requests },
        },
      ],
      noon,
    );
  let names = 0;
  const createSite = async (cluster?: string) => {
    const name = `guarded-${++names}`;
    return (
      await admin.sites.create({
        name,
        domains: [`${name}.test`],
        origins: [{ address: "origin.test" }],
        ...(cluster ? { clusterId: cluster } : {}),
      })
    ).site.id;
  };
  const guardRow = async (siteId: string) =>
    (
      await ctx.db
        .select()
        .from(schema.siteUsageGuard)
        .where(eq(schema.siteUsageGuard.siteId, siteId))
    )[0];
  const siteRow = async (siteId: string) => {
    const [row] = await ctx.db.select().from(schema.site).where(eq(schema.site.id, siteId));
    if (!row) throw new Error("site missing");
    return row;
  };
  const maintenanceOn = async (siteId: string) =>
    readMaintenance((await siteRow(siteId)).maintenance).enabled;
  const latestRevision = async (cluster: string) =>
    (
      await ctx.db
        .select()
        .from(schema.configRevision)
        .where(eq(schema.configRevision.clusterId, cluster))
        .orderBy(desc(schema.configRevision.revision))
        .limit(1)
    )[0];
  const auditOf = (siteId: string, action: string) =>
    ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.targetId, siteId), eq(schema.auditLog.action, action)));
  const daily = { period: "day" as const, timeZone: "UTC" };

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    const [row] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-1",
        enrolledAt: new Date(day0 - DAY),
        lastSeenAt: new Date(),
        supportedFeatures: ["site-content-v1"],
      })
      .returning();
    if (!row) throw new Error("node missing");
    node = { id: row.id, clusterId };
  });
  afterAll(() => pglite.close());

  it("sums the period's computed windows and the minutes not computed yet", async () => {
    const siteId = await createSite();
    const period = { start: new Date(day0), end: new Date(day0 + DAY) };
    // Yesterday's minute is not in the period.
    await report(node, siteId, day0 - 10 * MINUTE, 1000, 1);
    await report(node, siteId, noon - 3 * HOUR, 3, 300);
    await report(node, siteId, noon - 20 * MINUTE, 4, 400);
    await rollupUsage(ctx.db, new Date(noon));
    // Late data for a computed window, and the open window's minutes.
    await report(node, siteId, noon - 19 * MINUTE, 5, 500);
    await report(node, siteId, noon - 2 * MINUTE, 6, 600);
    const usage = await periodUsage(ctx.db, siteId, period.start, period.end, new Date(noon));
    expect(usage).toEqual({ bytes: 1800n, requests: 18n });
    // Bandwidth: the 5 minutes before the last one, every node.
    expect(await currentBandwidth(ctx.db, siteId, new Date(noon))).toBe((600 * 8) / 300);
    expect(await currentBandwidth(ctx.db, siteId, new Date(noon + 2 * MINUTE))).toBe(
      (600 * 8) / 300,
    );
    expect(await currentBandwidth(ctx.db, siteId, new Date(noon - MINUTE))).toBe(0);
  });

  it("validates the settings and answers a site without them", async () => {
    const siteId = await createSite();
    expect(await admin.usageGuard.get({ id: siteId })).toMatchObject({
      settings: null,
      period: null,
      usage: null,
      held: null,
    });
    expect((await rpcError(admin.usageGuard.update({ id: siteId, ...daily }))).code).toBe(
      "BAD_REQUEST",
    );
    expect(
      (
        await rpcError(
          admin.usageGuard.update({
            id: siteId,
            period: "day",
            timeZone: "Mars/Olympus",
            requestsLimit: "1",
          }),
        )
      ).code,
    ).toBe("BAD_REQUEST");
    expect(
      (await rpcError(admin.usageGuard.update({ id: siteId, ...daily, bytesLimit: "0" }))).code,
    ).toBe("BAD_REQUEST");
    const saved = await admin.usageGuard.update({ id: siteId, ...daily, requestsLimit: "10" });
    expect(saved.settings).toMatchObject({
      requestsLimit: "10",
      warnPercent: 80,
      action: "maintenance",
      recovery: "auto",
    });
    expect(saved.period).not.toBeNull();
    const stale = await rpcError(
      admin.usageGuard.update({
        id: siteId,
        ...daily,
        requestsLimit: "20",
        expectedUpdatedAt: new Date(0).toISOString(),
      }),
    );
    expect(stale.code).toBe("UPDATED_AT_MISMATCH");
    expect((await rpcError(admin.usageGuard.restore({ id: siteId }))).code).toBe(
      "USAGE_GUARD_NOT_HELD",
    );
    expect(await auditOf(siteId, "site.usage_guard_update")).toHaveLength(1);
  });

  it("alerts at the warning threshold and the limit once per period and turns maintenance on", async () => {
    const siteId = await createSite();
    await admin.usageGuard.update({ id: siteId, ...daily, requestsLimit: "100", warnPercent: 50 });
    const policy = await getAlertPolicy(ctx);
    const alerts = async (at: number) =>
      [...(await alertConditions(ctx, policy, at)).active.keys()].filter((key) =>
        key.includes(siteId),
      );
    await report(node, siteId, noon - 3 * MINUTE, 60, 1000);
    expect(await evaluateUsageGuard(ctx.db, siteId, new Date(noon))).toBe(true);
    expect(await guardRow(siteId)).toMatchObject({
      warnMetrics: ["requests"],
      limitMetrics: [],
      heldAction: null,
    });
    expect(await alerts(noon)).toEqual([`usage_warning/${siteId}/requests`]);
    const before = await latestRevision(clusterId);
    // Unchanged: no new alert, nothing published.
    expect(await evaluateUsageGuard(ctx.db, siteId, new Date(noon + MINUTE))).toBe(false);
    expect((await latestRevision(clusterId))?.revision).toBe(before?.revision);

    await report(node, siteId, noon - 2 * MINUTE, 50, 1000);
    expect(await evaluateUsageGuard(ctx.db, siteId, new Date(noon + MINUTE))).toBe(true);
    expect(await guardRow(siteId)).toMatchObject({
      warnMetrics: ["requests"],
      limitMetrics: ["requests"],
      heldAction: "maintenance",
      heldMetric: "requests",
      lastError: "",
    });
    expect(await maintenanceOn(siteId)).toBe(true);
    const applied = await latestRevision(clusterId);
    expect(applied?.reasonCode).toBe("usage_limit_reached");
    const [audit] = await auditOf(siteId, "site.usage_guard_apply");
    expect(audit).toMatchObject({ actorType: "system" });
    expect(audit?.metadata).toMatchObject({
      action: "maintenance",
      metric: "requests",
      usage: { requests: "110" },
      revision: applied?.revision,
    });
    expect((await alerts(noon + MINUTE)).sort()).toEqual([
      `usage_limit/${siteId}/requests`,
      `usage_warning/${siteId}/requests`,
    ]);
    // Held: nothing is applied again.
    await evaluateUsageGuard(ctx.db, siteId, new Date(noon + 2 * MINUTE));
    expect((await latestRevision(clusterId))?.revision).toBe(applied?.revision);
    expect(await auditOf(siteId, "site.usage_guard_apply")).toHaveLength(1);
    const dto = await admin.usageGuard.get({ id: siteId });
    expect(dto.held).toMatchObject({ action: "maintenance", metric: "requests" });
    expect((await admin.sites.get({ id: siteId })).usageGuardHeld).toBe("maintenance");

    // The next period lifts it (auto recovery) and ends the alerts.
    expect(await evaluateUsageGuard(ctx.db, siteId, new Date(nextDay))).toBe(true);
    expect(await maintenanceOn(siteId)).toBe(false);
    expect(await guardRow(siteId)).toMatchObject({
      warnMetrics: [],
      limitMetrics: [],
      heldAction: null,
      periodStart: new Date(day0 + DAY),
    });
    expect((await latestRevision(clusterId))?.reasonCode).toBe("usage_limit_released");
    const [released] = await auditOf(siteId, "site.usage_guard_release");
    expect(released).toMatchObject({ actorType: "system" });
    expect(await alerts(nextDay)).toEqual([]);
    expect((await admin.sites.get({ id: siteId })).usageGuardHeld).toBeNull();
  });

  it("holds a manual guard across periods until restored, then pauses it until the period ends", async () => {
    const siteId = await createSite();
    await admin.usageGuard.update({
      id: siteId,
      ...daily,
      bytesLimit: "1000",
      action: "disable",
      recovery: "manual",
    });
    await report(node, siteId, noon - 3 * MINUTE, 1, 1500);
    await evaluateUsageGuard(ctx.db, siteId, new Date(noon));
    expect((await siteRow(siteId)).enabled).toBe(false);
    expect(await guardRow(siteId)).toMatchObject({ heldAction: "disable", heldMetric: "bytes" });
    await evaluateUsageGuard(ctx.db, siteId, new Date(nextDay));
    expect((await siteRow(siteId)).enabled).toBe(false);

    const restored = await admin.usageGuard.restore({ id: siteId });
    expect(restored.held).toBeNull();
    expect(restored.pausedUntil).not.toBeNull();
    expect((await siteRow(siteId)).enabled).toBe(true);
    expect((await latestRevision(clusterId))?.reasonCode).toBe("usage_limit_released");
    const [audit] = await auditOf(siteId, "site.usage_guard_restore");
    expect(audit).toMatchObject({ actorType: "user" });
    expect((await rpcError(admin.usageGuard.restore({ id: siteId }))).code).toBe(
      "USAGE_GUARD_NOT_HELD",
    );
    // Still over in that period, but paused.
    await evaluateUsageGuard(ctx.db, siteId, new Date(noon + 10 * MINUTE));
    expect((await siteRow(siteId)).enabled).toBe(true);
    // Saving the settings re-arms it.
    await admin.usageGuard.update({
      id: siteId,
      ...daily,
      bytesLimit: "1000",
      action: "disable",
      recovery: "manual",
    });
    expect((await guardRow(siteId))?.pausedUntil).toBeNull();
    await evaluateUsageGuard(ctx.db, siteId, new Date(noon + 11 * MINUTE));
    expect((await siteRow(siteId)).enabled).toBe(false);
  });

  it("lets go when the operator turns the site on or maintenance off, until the period ends", async () => {
    const disabled = await createSite();
    await admin.usageGuard.update({
      id: disabled,
      ...daily,
      requestsLimit: "5",
      action: "disable",
    });
    await report(node, disabled, noon - 3 * MINUTE, 5, 1);
    await evaluateUsageGuard(ctx.db, disabled, new Date(noon));
    expect((await siteRow(disabled)).enabled).toBe(false);
    await admin.sites.setEnabled({ id: disabled, enabled: true });
    const row = await guardRow(disabled);
    expect(row?.heldAction).toBeNull();
    expect(row?.pausedUntil).not.toBeNull();
    await evaluateUsageGuard(ctx.db, disabled, new Date(noon + MINUTE));
    expect((await siteRow(disabled)).enabled).toBe(true);

    const maintained = await createSite();
    await admin.usageGuard.update({ id: maintained, ...daily, requestsLimit: "5" });
    await report(node, maintained, noon - 3 * MINUTE, 5, 1);
    await evaluateUsageGuard(ctx.db, maintained, new Date(noon));
    expect(await maintenanceOn(maintained)).toBe(true);
    const current = await admin.maintenance.get({ id: maintained });
    await admin.maintenance.update({ ...current, id: maintained, enabled: false });
    expect((await guardRow(maintained))?.heldAction).toBeNull();
    await evaluateUsageGuard(ctx.db, maintained, new Date(noon + MINUTE));
    expect(await maintenanceOn(maintained)).toBe(false);

    // Undone another way (not through those procedures): noticed at the next evaluation.
    const copied = await createSite();
    await admin.usageGuard.update({ id: copied, ...daily, requestsLimit: "5" });
    await report(node, copied, noon - 3 * MINUTE, 5, 1);
    await evaluateUsageGuard(ctx.db, copied, new Date(noon));
    await ctx.db
      .update(schema.site)
      .set({ maintenance: { enabled: false } })
      .where(eq(schema.site.id, copied));
    await evaluateUsageGuard(ctx.db, copied, new Date(noon + MINUTE));
    expect(await guardRow(copied)).toMatchObject({ heldAction: null });
    expect((await guardRow(copied))?.pausedUntil).toEqual(new Date(day0 + DAY));
    expect(await maintenanceOn(copied)).toBe(false);
  });

  it("leaves a site the operator already put in maintenance alone", async () => {
    const siteId = await createSite();
    const current = await admin.maintenance.get({ id: siteId });
    await admin.maintenance.update({ ...current, id: siteId, enabled: true });
    await admin.usageGuard.update({ id: siteId, ...daily, requestsLimit: "5" });
    await report(node, siteId, noon - 3 * MINUTE, 9, 1);
    await evaluateUsageGuard(ctx.db, siteId, new Date(noon));
    expect(await guardRow(siteId)).toMatchObject({ heldAction: null, limitMetrics: ["requests"] });
    await evaluateUsageGuard(ctx.db, siteId, new Date(nextDay));
    expect(await maintenanceOn(siteId)).toBe(true);
    expect(await auditOf(siteId, "site.usage_guard_apply")).toHaveLength(0);
  });

  it("lifts the action once a higher limit is no longer reached (auto)", async () => {
    const siteId = await createSite();
    await admin.usageGuard.update({ id: siteId, ...daily, requestsLimit: "5" });
    await report(node, siteId, noon - 3 * MINUTE, 9, 1);
    await evaluateUsageGuard(ctx.db, siteId, new Date(noon));
    expect(await maintenanceOn(siteId)).toBe(true);
    await admin.usageGuard.update({ id: siteId, ...daily, requestsLimit: "50" });
    await evaluateUsageGuard(ctx.db, siteId, new Date(noon + MINUTE));
    expect(await maintenanceOn(siteId)).toBe(false);
    expect(await guardRow(siteId)).toMatchObject({
      heldAction: null,
      warnMetrics: [],
      limitMetrics: [],
    });
  });

  it("switches to another action or to alerts only when the settings change", async () => {
    const siteId = await createSite();
    await admin.usageGuard.update({ id: siteId, ...daily, requestsLimit: "5" });
    await report(node, siteId, noon - 3 * MINUTE, 9, 1);
    await evaluateUsageGuard(ctx.db, siteId, new Date(noon));
    await admin.usageGuard.update({ id: siteId, ...daily, requestsLimit: "5", action: "disable" });
    await evaluateUsageGuard(ctx.db, siteId, new Date(noon + MINUTE));
    expect(await maintenanceOn(siteId)).toBe(false);
    expect((await siteRow(siteId)).enabled).toBe(false);
    expect((await guardRow(siteId))?.heldAction).toBe("disable");
    await admin.usageGuard.update({ id: siteId, ...daily, requestsLimit: "5", action: "alert" });
    await evaluateUsageGuard(ctx.db, siteId, new Date(noon + 2 * MINUTE));
    expect((await siteRow(siteId)).enabled).toBe(true);
    expect(await guardRow(siteId)).toMatchObject({ heldAction: null, limitMetrics: ["requests"] });
  });

  it("holds an action for bandwidth for the hold time while the alert lasts the period", async () => {
    const siteId = await createSite();
    await admin.usageGuard.update({
      id: siteId,
      ...daily,
      bandwidthBps: 8000,
      bandwidthHoldMinutes: 30,
    });
    // 400 kB in the window: 10.7 kbps.
    await report(node, siteId, noon - 3 * MINUTE, 10, 400_000);
    await evaluateUsageGuard(ctx.db, siteId, new Date(noon));
    expect(await guardRow(siteId)).toMatchObject({
      heldAction: "maintenance",
      heldMetric: "bandwidth",
      limitMetrics: ["bandwidth"],
    });
    await evaluateUsageGuard(ctx.db, siteId, new Date(noon + 20 * MINUTE));
    expect(await maintenanceOn(siteId)).toBe(true);
    await evaluateUsageGuard(ctx.db, siteId, new Date(noon + 31 * MINUTE));
    expect(await maintenanceOn(siteId)).toBe(false);
    expect(await guardRow(siteId)).toMatchObject({ heldAction: null, limitMetrics: ["bandwidth"] });
  });

  it("keeps an action nodes cannot take as last_error and retries it", async () => {
    const other = await admin.clusters.create({ name: "older-nodes" });
    const [old] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId: other.id,
        name: "old-edge",
        enrolledAt: new Date(day0 - DAY),
        lastSeenAt: new Date(),
      })
      .returning();
    if (!old) throw new Error("node missing");
    const siteId = await createSite(other.id);
    await admin.usageGuard.update({ id: siteId, ...daily, requestsLimit: "5" });
    await report({ id: old.id, clusterId: other.id }, siteId, noon - 3 * MINUTE, 9, 1);
    expect(await evaluateUsageGuard(ctx.db, siteId, new Date(noon))).toBe(true);
    expect(await guardRow(siteId)).toMatchObject({
      heldAction: null,
      limitMetrics: ["requests"],
      lastError: "NODE_CAPABILITY_REQUIRED",
    });
    expect(await maintenanceOn(siteId)).toBe(false);
    expect((await admin.usageGuard.get({ id: siteId })).lastError).toBe("NODE_CAPABILITY_REQUIRED");
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: ["site-content-v1"] })
      .where(eq(schema.node.id, old.id));
    await evaluateUsageGuard(ctx.db, siteId, new Date(noon + MINUTE));
    expect(await guardRow(siteId)).toMatchObject({ heldAction: "maintenance", lastError: "" });
    expect(await maintenanceOn(siteId)).toBe(true);
  });

  it("lifts the action when the settings are deleted and goes with the site", async () => {
    const siteId = await createSite();
    await admin.usageGuard.update({ id: siteId, ...daily, requestsLimit: "5" });
    await report(node, siteId, noon - 3 * MINUTE, 9, 1);
    await evaluateUsageGuard(ctx.db, siteId, new Date(noon));
    expect(await maintenanceOn(siteId)).toBe(true);
    const deleted = await admin.usageGuard.delete({ id: siteId });
    expect(deleted.settings).toBeNull();
    expect(await maintenanceOn(siteId)).toBe(false);
    expect(await guardRow(siteId)).toBeUndefined();
    expect(await auditOf(siteId, "site.usage_guard_delete")).toHaveLength(1);
    // Deleting again changes nothing.
    await admin.usageGuard.delete({ id: siteId });
    expect(await auditOf(siteId, "site.usage_guard_delete")).toHaveLength(1);

    const gone = await createSite();
    await admin.usageGuard.update({ id: gone, ...daily, requestsLimit: "5" });
    await admin.sites.delete({ id: gone });
    expect(await guardRow(gone)).toBeUndefined();
  });
});
