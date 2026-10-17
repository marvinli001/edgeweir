import type { CcLevel } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  evaluateAutoMitigation,
  nudgeAutoMitigation,
  sweepAutoMitigation,
} from "../../src/server/services/auto-mitigation";
import { siteCcLevel } from "../../src/server/services/cc-level";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const SECOND = 1000;
const MINUTE = 60_000;

describe("automatic mitigation", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let nodeId: string;
  let names = 0;
  // A fixed clock: heartbeats and evaluations are placed on it, 45 s is the online window.
  const t0 = Date.parse("2026-10-17T12:00:00Z");
  const at = (offset: number) => new Date(t0 + offset);

  const createSite = async (cluster?: string) => {
    const name = `mitigated-${++names}`;
    return (
      await admin.sites.create({
        name,
        domains: [`${name}.test`],
        origins: [{ address: "origin.test" }],
        ...(cluster ? { clusterId: cluster } : {}),
      })
    ).site.id;
  };
  /** The node's heartbeat at `time`: the level it holds for each site. */
  const heartbeat = (time: Date, levels: Record<string, CcLevel>, target: string = nodeId) =>
    ctx.db
      .update(schema.node)
      .set({
        lastSeenAt: time,
        securityState: Object.entries(levels)
          .filter(([, level]) => level !== "normal")
          .map(([siteId, level]) => ({ siteId, level, escalatedPaths: 0 })),
      })
      .where(eq(schema.node.id, target));
  const row = async (siteId: string) =>
    (
      await ctx.db
        .select()
        .from(schema.siteAutoMitigation)
        .where(eq(schema.siteAutoMitigation.siteId, siteId))
    )[0];
  const underAttack = async (siteId: string) =>
    (
      await ctx.db
        .select()
        .from(schema.siteProtection)
        .where(eq(schema.siteProtection.siteId, siteId))
    )[0]?.underAttack ?? false;
  const revisions = async (cluster: string) =>
    ctx.db
      .select()
      .from(schema.configRevision)
      .where(eq(schema.configRevision.clusterId, cluster))
      .orderBy(desc(schema.configRevision.revision));
  const auditOf = (siteId: string, action: string) =>
    ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.targetId, siteId), eq(schema.auditLog.action, action)));
  const evaluate = (siteId: string, time: Date) => evaluateAutoMitigation(ctx.db, siteId, time);
  /** A site with the mitigation on at `pow` for 30 minutes, held since t0 by a node at `pow`. */
  const held = async (extra: { threshold?: "js" | "pow"; durationMinutes?: number } = {}) => {
    const siteId = await createSite();
    await admin.autoMitigation.update({
      id: siteId,
      enabled: true,
      threshold: extra.threshold ?? "pow",
      durationMinutes: extra.durationMinutes ?? 30,
    });
    await heartbeat(at(0), { [siteId]: "pow" });
    await evaluate(siteId, at(0));
    expect(await underAttack(siteId)).toBe(true);
    return siteId;
  };

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-1",
        enrolledAt: at(-60 * MINUTE),
        lastSeenAt: at(0),
        supportedFeatures: ["challenge-v1"],
      })
      .returning();
    if (!node) throw new Error("node missing");
    nodeId = node.id;
  });
  afterAll(() => pglite.close());

  it("validates the settings and answers a site without them", async () => {
    const siteId = await createSite();
    expect(await admin.autoMitigation.get({ id: siteId })).toMatchObject({
      siteId,
      settings: null,
      updatedAt: null,
      level: "normal",
      active: null,
      paused: false,
      lastError: "",
    });
    const input = { id: siteId, enabled: true, threshold: "pow", durationMinutes: 30 } as const;
    // `normal` is not a level that starts it, and the hold is 5 minutes to a day.
    for (const bad of [
      { ...input, threshold: "normal" },
      { ...input, durationMinutes: 4 },
      { ...input, durationMinutes: 1441 },
      { ...input, durationMinutes: 30.5 },
    ])
      expect((await rpcError(admin.autoMitigation.update(bad as never))).code).toBe("BAD_REQUEST");
    const saved = await admin.autoMitigation.update(input);
    expect(saved.settings).toEqual({ enabled: true, threshold: "pow", durationMinutes: 30 });
    expect(saved.updatedAt).not.toBeNull();
    expect(await admin.autoMitigation.get({ id: siteId })).toEqual(saved);
    const [audit] = await auditOf(siteId, "site.auto_mitigation_update");
    expect(audit?.metadata).toEqual({
      from: null,
      to: { enabled: true, threshold: "pow", durationMinutes: 30 },
    });
    // The defaults, and the optimistic check.
    const defaults = await admin.autoMitigation.update({ id: siteId } as never);
    expect(defaults.settings).toEqual({ enabled: true, threshold: "pow", durationMinutes: 30 });
    const stale = await rpcError(
      admin.autoMitigation.update({ ...input, expectedUpdatedAt: saved.updatedAt ?? undefined }),
    );
    expect(stale.code).toBe("UPDATED_AT_MISMATCH");
    expect((await rpcError(admin.autoMitigation.get({ id: crypto.randomUUID() }))).code).toBe(
      "SITE_NOT_FOUND",
    );
  });

  it("starts when a node's level reaches the threshold, once, by the system", async () => {
    const siteId = await createSite();
    await admin.autoMitigation.update({
      id: siteId,
      enabled: true,
      threshold: "pow",
      durationMinutes: 30,
    });
    // Below the threshold, and normal: nothing.
    await heartbeat(at(0), { [siteId]: "js" });
    await evaluate(siteId, at(0));
    expect(await underAttack(siteId)).toBe(false);
    expect(await auditOf(siteId, "site.auto_mitigation_apply")).toHaveLength(0);

    const before = (await revisions(clusterId)).length;
    await heartbeat(at(SECOND * 10), { [siteId]: "pow" });
    // Several evaluations at once (the sweep, a node's report, a retried job): one change.
    await Promise.all([1, 2, 3].map(() => evaluate(siteId, at(SECOND * 10))));
    expect(await underAttack(siteId)).toBe(true);
    const after = await revisions(clusterId);
    expect(after.length).toBe(before + 1);
    expect(after[0]?.reasonCode).toBe("auto_mitigation_started");
    const [apply, ...rest] = await auditOf(siteId, "site.auto_mitigation_apply");
    expect(rest).toHaveLength(0);
    expect(apply).toMatchObject({ actorType: "system", targetId: siteId });
    expect(apply?.metadata).toMatchObject({
      level: "pow",
      threshold: "pow",
      durationMinutes: 30,
      revision: Number(after[0]?.revision),
    });
    expect(await row(siteId)).toMatchObject({
      triggerLevel: "pow",
      paused: false,
      lastError: "",
      activeSince: at(SECOND * 10),
      expiresAt: at(SECOND * 10 + 30 * MINUTE),
    });
    expect(await admin.autoMitigation.get({ id: siteId })).toMatchObject({
      level: "pow",
      active: {
        since: at(SECOND * 10).toISOString(),
        expiresAt: at(SECOND * 10 + 30 * MINUTE).toISOString(),
        level: "pow",
      },
    });
    // The protection the operator sees says Under Attack is on.
    expect((await admin.protection.get({ id: siteId })).underAttack).toBe(true);
  });

  it("holds while the level stays at the threshold and lifts after the duration", async () => {
    const siteId = await held();
    const count = (await revisions(clusterId)).length;
    // Still at the threshold ten minutes later: the hold moves, nothing is published.
    await heartbeat(at(10 * MINUTE), { [siteId]: "captcha" });
    await evaluate(siteId, at(10 * MINUTE));
    expect(await row(siteId)).toMatchObject({ expiresAt: at(40 * MINUTE), triggerLevel: "pow" });
    expect((await revisions(clusterId)).length).toBe(count);
    expect(await auditOf(siteId, "site.auto_mitigation_apply")).toHaveLength(1);

    // The level is gone: it stays on until 30 minutes after the last time at the threshold.
    await heartbeat(at(11 * MINUTE), { [siteId]: "normal" });
    await evaluate(siteId, at(11 * MINUTE));
    await evaluate(siteId, at(39 * MINUTE));
    expect(await underAttack(siteId)).toBe(true);
    await heartbeat(at(40 * MINUTE), { [siteId]: "normal" });
    await evaluate(siteId, at(40 * MINUTE));
    expect(await underAttack(siteId)).toBe(false);
    expect(await row(siteId)).toMatchObject({
      activeSince: null,
      expiresAt: null,
      triggerLevel: null,
      paused: false,
    });
    const latest = (await revisions(clusterId))[0];
    expect(latest?.reasonCode).toBe("auto_mitigation_ended");
    const [release, ...rest] = await auditOf(siteId, "site.auto_mitigation_release");
    expect(rest).toHaveLength(0);
    expect(release).toMatchObject({ actorType: "system" });
    expect(release?.metadata).toMatchObject({
      reason: "expired",
      revision: Number(latest?.revision),
    });
    // Evaluating again changes nothing.
    await evaluate(siteId, at(41 * MINUTE));
    expect(await auditOf(siteId, "site.auto_mitigation_release")).toHaveLength(1);
    expect((await revisions(clusterId))[0]?.revision).toBe(latest?.revision);
  });

  it("extends instead of lifting when the level is at the threshold at the expiry", async () => {
    const siteId = await held({ durationMinutes: 5 });
    await heartbeat(at(5 * MINUTE), { [siteId]: "pow" });
    await evaluate(siteId, at(5 * MINUTE));
    expect(await underAttack(siteId)).toBe(true);
    expect((await row(siteId))?.expiresAt).toEqual(at(10 * MINUTE));
    expect(await auditOf(siteId, "site.auto_mitigation_release")).toHaveLength(0);
  });

  it("uses the heartbeat's level, a newer level event, and online nodes only", async () => {
    const siteId = await createSite();
    const site = { id: siteId, clusterId };
    await heartbeat(at(0), { [siteId]: "js" });
    expect(await siteCcLevel(ctx.db, site, at(0).getTime())).toBe("js");
    // A level change reported after the heartbeat is newer than the heartbeat's state.
    await ctx.db.insert(schema.securityEvent).values({
      nodeId,
      nodeEventId: `up-${siteId}`,
      siteId,
      occurredAt: at(5 * SECOND),
      receivedAt: at(5 * SECOND),
      kind: "site_level",
      level: "captcha",
      previousLevel: "js",
    });
    expect(await siteCcLevel(ctx.db, site, at(6 * SECOND).getTime())).toBe("captcha");
    // The next heartbeat is newer than the event: its state counts.
    await heartbeat(at(10 * SECOND), { [siteId]: "cookie302" });
    expect(await siteCcLevel(ctx.db, site, at(11 * SECOND).getTime())).toBe("cookie302");
    // A later de-escalation event.
    await ctx.db.insert(schema.securityEvent).values({
      nodeId,
      nodeEventId: `down-${siteId}`,
      siteId,
      occurredAt: at(20 * SECOND),
      receivedAt: at(20 * SECOND),
      kind: "site_level",
      level: "normal",
      previousLevel: "cookie302",
      metric: "cooldown",
    });
    expect(await siteCcLevel(ctx.db, site, at(21 * SECOND).getTime())).toBe("normal");
    // Path level events are not the site's level; a node that stopped reporting is not counted.
    await heartbeat(at(30 * SECOND), { [siteId]: "pow" });
    expect(await siteCcLevel(ctx.db, site, at(30 * SECOND).getTime())).toBe("pow");
    expect(await siteCcLevel(ctx.db, site, at(30 * SECOND + 46 * SECOND).getTime())).toBe("normal");
    // The highest of several nodes.
    const [second] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-2",
        enrolledAt: at(-60 * MINUTE),
        lastSeenAt: at(30 * SECOND),
        securityState: [{ siteId, level: "captcha", escalatedPaths: 0 }],
      })
      .returning();
    expect(await siteCcLevel(ctx.db, site, at(30 * SECOND).getTime())).toBe("captcha");
    if (second) await ctx.db.delete(schema.node).where(eq(schema.node.id, second.id));
    await heartbeat(at(0), {});
  });

  it("leaves Under Attack the operator turned on, before or while it holds", async () => {
    const siteId = await createSite();
    await admin.protection.update({ id: siteId, underAttack: true });
    await admin.autoMitigation.update({
      id: siteId,
      enabled: true,
      threshold: "js",
      durationMinutes: 5,
    });
    await heartbeat(at(0), { [siteId]: "pow" });
    const count = (await revisions(clusterId)).length;
    await evaluate(siteId, at(0));
    expect(await row(siteId)).toMatchObject({ activeSince: null, paused: false });
    expect((await revisions(clusterId)).length).toBe(count);
    await heartbeat(at(MINUTE), { [siteId]: "normal" });
    await evaluate(siteId, at(10 * MINUTE));
    expect(await underAttack(siteId)).toBe(true);
    expect(await auditOf(siteId, "site.auto_mitigation_apply")).toHaveLength(0);
    expect(await auditOf(siteId, "site.auto_mitigation_release")).toHaveLength(0);

    // While it holds: the operator saving Under Attack on takes it over; it is never lifted.
    const other = await held({ durationMinutes: 5 });
    await admin.protection.update({ id: other, underAttack: true });
    expect(await row(other)).toMatchObject({ activeSince: null, expiresAt: null, paused: false });
    await heartbeat(at(MINUTE), { [other]: "normal" });
    await evaluate(other, at(20 * MINUTE));
    expect(await underAttack(other)).toBe(true);
    expect(await auditOf(other, "site.auto_mitigation_release")).toHaveLength(0);
  });

  it("is not changed by the operator picking another challenge type", async () => {
    const siteId = await held();
    await admin.protection.update({ id: siteId, underAttackChallenge: "pow" });
    expect(await row(siteId)).toMatchObject({ activeSince: at(0), paused: false });
    expect(await underAttack(siteId)).toBe(true);
  });

  it("ends the hold and waits for the escalation to end when the operator turns Under Attack off", async () => {
    const siteId = await held();
    await admin.protection.update({ id: siteId, underAttack: false });
    expect(await row(siteId)).toMatchObject({ activeSince: null, expiresAt: null, paused: true });
    expect(await underAttack(siteId)).toBe(false);
    // The level is still at the threshold: nothing starts again.
    const count = (await revisions(clusterId)).length;
    await heartbeat(at(MINUTE), { [siteId]: "pow" });
    await evaluate(siteId, at(MINUTE));
    expect(await underAttack(siteId)).toBe(false);
    expect((await revisions(clusterId)).length).toBe(count);
    expect(await row(siteId)).toMatchObject({ paused: true });
    expect(await admin.autoMitigation.get({ id: siteId })).toMatchObject({
      active: null,
      paused: true,
    });
    // The escalation ends; a new one starts the mitigation again.
    await heartbeat(at(2 * MINUTE), { [siteId]: "normal" });
    await evaluate(siteId, at(2 * MINUTE));
    expect(await row(siteId)).toMatchObject({ paused: false });
    await heartbeat(at(3 * MINUTE), { [siteId]: "pow" });
    await evaluate(siteId, at(3 * MINUTE));
    expect(await underAttack(siteId)).toBe(true);
    expect(await auditOf(siteId, "site.auto_mitigation_apply")).toHaveLength(2);
  });

  it("notices Under Attack turned off by another way and pauses", async () => {
    const siteId = await held();
    await ctx.db
      .update(schema.siteProtection)
      .set({ underAttack: false })
      .where(eq(schema.siteProtection.siteId, siteId));
    await heartbeat(at(MINUTE), { [siteId]: "pow" });
    await evaluate(siteId, at(MINUTE));
    expect(await row(siteId)).toMatchObject({ activeSince: null, paused: true });
    expect(await underAttack(siteId)).toBe(false);
    expect(await auditOf(siteId, "site.auto_mitigation_apply")).toHaveLength(1);
    expect(await auditOf(siteId, "site.auto_mitigation_release")).toHaveLength(0);
  });

  it("ends now on request, then waits for the escalation to end", async () => {
    const siteId = await held();
    const restored = await admin.autoMitigation.restore({ id: siteId });
    expect(restored).toMatchObject({ active: null, paused: true });
    expect(await underAttack(siteId)).toBe(false);
    const [audit] = await auditOf(siteId, "site.auto_mitigation_restore");
    expect(audit).toMatchObject({ actorType: "user" });
    expect((await revisions(clusterId))[0]?.reasonCode).toBe("auto_mitigation_ended");
    expect((await rpcError(admin.autoMitigation.restore({ id: siteId }))).code).toBe(
      "AUTO_MITIGATION_NOT_ACTIVE",
    );
    expect((await rpcError(admin.autoMitigation.restore({ id: await createSite() }))).status).toBe(
      409,
    );
    await heartbeat(at(MINUTE), { [siteId]: "pow" });
    await evaluate(siteId, at(MINUTE));
    expect(await underAttack(siteId)).toBe(false);
    await heartbeat(at(2 * MINUTE), {});
    await evaluate(siteId, at(2 * MINUTE));
    expect(await row(siteId)).toMatchObject({ paused: false });
    // Saving the settings also ends a pause.
    const paused = await held();
    await admin.autoMitigation.restore({ id: paused });
    await admin.autoMitigation.update({
      id: paused,
      enabled: true,
      threshold: "pow",
      durationMinutes: 30,
    });
    expect(await row(paused)).toMatchObject({ paused: false });
  });

  it("lifts what it holds when turned off, and shortens a long hold with the duration", async () => {
    const siteId = await held();
    const saved = await admin.autoMitigation.update({
      id: siteId,
      enabled: false,
      threshold: "pow",
      durationMinutes: 30,
    });
    expect(saved).toMatchObject({ settings: { enabled: false }, active: null });
    expect(await underAttack(siteId)).toBe(false);
    const [release] = await auditOf(siteId, "site.auto_mitigation_release");
    expect(release?.metadata).toMatchObject({ reason: "disabled" });
    expect(release).toMatchObject({ actorType: "user" });
    // Off: nothing starts.
    await heartbeat(at(MINUTE), { [siteId]: "captcha" });
    await evaluate(siteId, at(MINUTE));
    expect(await underAttack(siteId)).toBe(false);

    const long = await held({ durationMinutes: 600 });
    expect((await row(long))?.expiresAt).toEqual(at(600 * MINUTE));
    await admin.autoMitigation.update({
      id: long,
      enabled: true,
      threshold: "pow",
      durationMinutes: 5,
    });
    const capped = (await row(long))?.expiresAt?.getTime() ?? 0;
    expect(capped).toBeLessThanOrEqual(Date.now() + 5 * MINUTE);
    expect(await underAttack(long)).toBe(true);
  });

  it("keeps a change nodes cannot take as last_error and retries it", async () => {
    const other = await admin.clusters.create({ name: "older-nodes" });
    const [old] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId: other.id,
        name: "old-edge",
        enrolledAt: at(-60 * MINUTE),
        lastSeenAt: at(0),
      })
      .returning();
    if (!old) throw new Error("node missing");
    const siteId = await createSite(other.id);
    await admin.autoMitigation.update({
      id: siteId,
      enabled: true,
      threshold: "pow",
      durationMinutes: 30,
    });
    await heartbeat(at(0), { [siteId]: "pow" }, old.id);
    await evaluate(siteId, at(0));
    expect(await row(siteId)).toMatchObject({
      activeSince: null,
      lastError: "NODE_CAPABILITY_REQUIRED",
    });
    expect(await underAttack(siteId)).toBe(false);
    expect(await auditOf(siteId, "site.auto_mitigation_apply")).toHaveLength(0);
    expect((await admin.autoMitigation.get({ id: siteId })).lastError).toBe(
      "NODE_CAPABILITY_REQUIRED",
    );
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: ["challenge-v1"] })
      .where(eq(schema.node.id, old.id));
    await heartbeat(at(MINUTE), { [siteId]: "pow" }, old.id);
    await evaluate(siteId, at(MINUTE));
    expect(await row(siteId)).toMatchObject({ lastError: "", triggerLevel: "pow" });
    expect(await underAttack(siteId)).toBe(true);
  });

  it("does not start for a disabled site", async () => {
    const siteId = await createSite();
    await admin.autoMitigation.update({
      id: siteId,
      enabled: true,
      threshold: "cookie302",
      durationMinutes: 5,
    });
    await admin.sites.setEnabled({ id: siteId, enabled: false });
    await heartbeat(at(0), { [siteId]: "captcha" });
    await evaluate(siteId, at(0));
    expect(await underAttack(siteId)).toBe(false);
    expect(await row(siteId)).toMatchObject({ activeSince: null });
  });

  it("is evaluated by the sweep and after a node reports a level, only where enabled", async () => {
    const first = await createSite();
    const second = await createSite();
    const off = await createSite();
    const none = await createSite();
    for (const [id, enabled] of [
      [first, true],
      [second, true],
      [off, false],
    ] as const)
      await admin.autoMitigation.update({ id, enabled, threshold: "pow", durationMinutes: 30 });
    const now = new Date();
    await ctx.db
      .update(schema.node)
      .set({
        lastSeenAt: now,
        securityState: [first, second, off, none].map((siteId) => ({
          siteId,
          level: "pow",
          escalatedPaths: 0,
        })),
      })
      .where(eq(schema.node.id, nodeId));
    await sweepAutoMitigation(ctx, now);
    expect(await underAttack(first)).toBe(true);
    expect(await underAttack(second)).toBe(true);
    expect(await underAttack(off)).toBe(false);
    expect(await underAttack(none)).toBe(false);
    // The nudge of a node's report evaluates just those sites.
    await ctx.db
      .update(schema.siteProtection)
      .set({ underAttack: false })
      .where(eq(schema.siteProtection.siteId, first));
    await ctx.db
      .update(schema.siteAutoMitigation)
      .set({ activeSince: null, expiresAt: null, triggerLevel: null, paused: false })
      .where(eq(schema.siteAutoMitigation.siteId, first));
    await nudgeAutoMitigation(ctx, [first, none]);
    expect(await underAttack(first)).toBe(true);
    await nudgeAutoMitigation(ctx, []);
    // A restart between evaluations loses nothing: the next one reads the stored expiry.
    await ctx.db
      .update(schema.node)
      .set({ lastSeenAt: new Date(now.getTime() + 31 * MINUTE), securityState: [] })
      .where(eq(schema.node.id, nodeId));
    await sweepAutoMitigation(ctx, new Date(now.getTime() + 31 * MINUTE));
    expect(await underAttack(second)).toBe(false);
    expect(await row(second)).toMatchObject({ activeSince: null });
    expect(await auditOf(second, "site.auto_mitigation_release")).toHaveLength(1);
  });

  it("does not copy Under Attack it holds, and lets go when a copy sets the switch", async () => {
    const source = await held();
    const plain = await createSite();
    await admin.sites.copySettings({ id: source, targetIds: [plain], parts: ["protection"] });
    // The source's switch is the mitigation's, not its setting.
    expect(await underAttack(plain)).toBe(false);
    expect(await underAttack(source)).toBe(true);

    // A site that holds it keeps the switch the copy leaves as it is (off), other settings change.
    const target = await held();
    await admin.protection.update({ id: plain, passTtlSeconds: 600 });
    await admin.sites.copySettings({ id: plain, targetIds: [target], parts: ["protection"] });
    expect((await admin.protection.get({ id: target })).passTtlSeconds).toBe(600);
    expect(await underAttack(target)).toBe(true);
    expect(await row(target)).toMatchObject({ activeSince: at(0), paused: false });
    // A copy that turns it on is the operator's: it is never lifted.
    const opted = await createSite();
    await admin.protection.update({ id: opted, underAttack: true });
    const taken = await held();
    await admin.sites.copySettings({ id: opted, targetIds: [taken], parts: ["protection"] });
    expect(await underAttack(taken)).toBe(true);
    expect(await row(taken)).toMatchObject({ activeSince: null, paused: false });
  });

  it("goes with the site", async () => {
    const siteId = await held();
    await admin.sites.delete({ id: siteId });
    expect(await row(siteId)).toBeUndefined();
    await evaluate(siteId, at(MINUTE));
  });
});
