import "reflect-metadata";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { DEVELOPMENT_MODE_FEATURE, decodeNodeConfig } from "@edgeweir/config-compiler";
import { DEVELOPMENT_MODE_SECONDS } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  expireDevelopmentModes,
  getDevelopmentMode,
  setDevelopmentMode,
  setDevelopmentModeSeconds,
} from "../../src/server/services/development-mode";
import { latestRevision } from "../../src/server/services/revisions";
import { rollbackToRevision } from "../../src/server/services/rollback";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const FULL = ["tls-v1", "rules-v1", "access-logs-v1"];
const HOUR = 3_600_000;
const service = {
  type: "service_account" as const,
  id: "service-account-dev",
  name: "integration",
};

describe("development mode", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId = "";
  let siteId = "";
  let otherSiteId = "";
  let nodeId = "";

  const ir = async () => {
    const row = await latestRevision(ctx.db, clusterId);
    if (!row) throw new Error("no revision");
    return decodeNodeConfig(row.ir);
  };
  const siteIr = async (id = siteId) => (await ir()).sites.find((s) => s.id === id);
  const revisionCount = async () =>
    (
      await ctx.db
        .select()
        .from(schema.configRevision)
        .where(eq(schema.configRevision.clusterId, clusterId))
    ).length;
  const latestReason = async () =>
    (
      await ctx.db
        .select()
        .from(schema.configRevision)
        .where(eq(schema.configRevision.clusterId, clusterId))
        .orderBy(desc(schema.configRevision.revision))
        .limit(1)
    )[0]?.reasonCode;
  const auditOf = (action: string, id = siteId) =>
    ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.targetId, id), eq(schema.auditLog.action, action)));
  const storedUntil = async (id = siteId) =>
    (await ctx.db.select().from(schema.site).where(eq(schema.site.id, id)))[0]
      ?.developmentModeUntil ?? null;
  const setUntil = (until: Date | null, id = siteId) =>
    ctx.db.update(schema.site).set({ developmentModeUntil: until }).where(eq(schema.site.id, id));

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    for (const name of ["app", "docs"]) {
      const id = (
        await admin.sites.create({
          name,
          domains: [`${name}.dev-mode.test`],
          origins: [{ address: "origin.example.com" }],
        })
      ).site.id;
      if (name === "app") siteId = id;
      else otherSiteId = id;
    }
    const [row] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-dev-mode",
        lastSeenAt: new Date(),
        supportedFeatures: [...FULL, DEVELOPMENT_MODE_FEATURE],
      })
      .returning();
    if (!row) throw new Error("node missing");
    nodeId = row.id;
  });
  afterAll(() => {
    setDevelopmentModeSeconds(undefined);
    return pglite.close();
  });

  it("is off by default; configurations encode as before", async () => {
    expect(await admin.developmentMode.get({ id: siteId })).toEqual({
      siteId,
      until: null,
      unsupportedNodes: 0,
    });
    expect((await siteIr())?.developmentMode).toBeUndefined();
    expect((await ir()).requiredFeatures).not.toContain(DEVELOPMENT_MODE_FEATURE);
    expect((await admin.sites.get({ id: siteId })).developmentModeUntil).toBeNull();
  });

  it("turns on for three hours: published with its deadline, audited, badge data", async () => {
    const before = await revisionCount();
    const start = Date.now();
    const on = await admin.developmentMode.set({ id: siteId, enabled: true });
    const until = Date.parse(on.until ?? "");
    expect(until).toBeGreaterThanOrEqual(start + DEVELOPMENT_MODE_SECONDS * 1000);
    expect(until).toBeLessThanOrEqual(Date.now() + DEVELOPMENT_MODE_SECONDS * 1000);
    expect(DEVELOPMENT_MODE_SECONDS).toBe(3 * 60 * 60);
    expect(await revisionCount()).toBe(before + 1);
    expect(await latestReason()).toBe("development_mode_on");
    const compiled = (await siteIr())?.developmentMode?.expiresAt;
    if (!compiled) throw new Error("no deadline in the configuration");
    // Whole seconds: nodes compare Unix seconds.
    expect(compiled.nanos).toBe(0);
    expect(timestampMs(compiled)).toBe(Math.floor(until / 1000) * 1000);
    expect((await ir()).requiredFeatures).toContain(DEVELOPMENT_MODE_FEATURE);
    // Only this site bypasses its cache.
    expect((await siteIr(otherSiteId))?.developmentMode).toBeUndefined();
    const [audit] = await auditOf("site.development_mode_on");
    expect(audit?.actorType).toBe("user");
    expect(audit?.metadata).toMatchObject({ until: on.until });
    expect((await admin.sites.get({ id: siteId })).developmentModeUntil).toBe(on.until);
    expect(
      (await admin.sites.list({})).items.find((s) => s.id === siteId)?.developmentModeUntil,
    ).toBe(on.until);
  });

  it("turning it on again keeps the deadline and publishes nothing", async () => {
    const { until } = await admin.developmentMode.get({ id: siteId });
    const before = await revisionCount();
    expect((await admin.developmentMode.set({ id: siteId, enabled: true })).until).toBe(until);
    expect(await revisionCount()).toBe(before);
    expect(await auditOf("site.development_mode_on")).toHaveLength(1);
  });

  it("turns off early: published without it and audited", async () => {
    const before = await revisionCount();
    expect((await admin.developmentMode.set({ id: siteId, enabled: false })).until).toBeNull();
    expect(await revisionCount()).toBe(before + 1);
    expect(await latestReason()).toBe("development_mode_off");
    expect((await siteIr())?.developmentMode).toBeUndefined();
    expect((await ir()).requiredFeatures).not.toContain(DEVELOPMENT_MODE_FEATURE);
    expect(await auditOf("site.development_mode_off")).toHaveLength(1);
    expect(await storedUntil()).toBeNull();
    // Off while off: nothing.
    await admin.developmentMode.set({ id: siteId, enabled: false });
    expect(await revisionCount()).toBe(before + 1);
  });

  it("expires at the deadline: the sweep turns it off as the system, once", async () => {
    setDevelopmentModeSeconds(60);
    const on = await setDevelopmentMode(
      ctx.db,
      { id: siteId, enabled: true },
      { actor: service },
    ).finally(() => setDevelopmentModeSeconds(undefined));
    const until = new Date(on.until ?? "");
    expect(until.getTime() - Date.now()).toBeLessThanOrEqual(60_000);
    // Before the deadline the sweep leaves it alone.
    expect(await expireDevelopmentModes(ctx, new Date(until.getTime() - 1000))).toBe(0);
    expect(await storedUntil()).toEqual(until);
    const before = await revisionCount();
    expect(await expireDevelopmentModes(ctx, new Date(until.getTime() + 1000))).toBe(1);
    expect(await storedUntil()).toBeNull();
    expect(await revisionCount()).toBe(before + 1);
    expect(await latestReason()).toBe("development_mode_expired");
    expect((await siteIr())?.developmentMode).toBeUndefined();
    const [expiry] = await auditOf("site.development_mode_expire");
    expect(expiry?.actorType).toBe("system");
    expect(expiry?.metadata).toMatchObject({ until: until.toISOString() });
    // A repeated or late sweep finds nothing.
    expect(await expireDevelopmentModes(ctx, new Date(until.getTime() + HOUR))).toBe(0);
    expect(await revisionCount()).toBe(before + 1);
  });

  it("reads a deadline that passed as off, before the sweep, and records its expiry first", async () => {
    // Left over by a console that was down at the deadline; nodes stopped on their own.
    await setUntil(new Date(Date.now() - 5 * 60_000));
    expect((await admin.developmentMode.get({ id: siteId })).until).toBeNull();
    expect((await admin.sites.get({ id: siteId })).developmentModeUntil).toBeNull();
    const expiries = (await auditOf("site.development_mode_expire")).length;
    const offs = (await auditOf("site.development_mode_off")).length;
    await admin.developmentMode.set({ id: siteId, enabled: false });
    expect(await auditOf("site.development_mode_expire")).toHaveLength(expiries + 1);
    expect(await auditOf("site.development_mode_off")).toHaveLength(offs);
    expect(await storedUntil()).toBeNull();
    // Turning it on after a stale deadline: the expiry, then a fresh three hours.
    await setUntil(new Date(Date.now() - 60_000));
    const on = await admin.developmentMode.set({ id: siteId, enabled: true });
    expect(Date.parse(on.until ?? "")).toBeGreaterThan(Date.now() + 2 * HOUR);
    expect(await auditOf("site.development_mode_expire")).toHaveLength(expiries + 2);
    await admin.developmentMode.set({ id: siteId, enabled: false });
  });

  it("keeps the current state when older content is published again (rollback)", async () => {
    const offRevision = (await ir()).revision;
    await admin.sites.update({ id: siteId, name: "app-renamed" });
    await admin.developmentMode.set({ id: siteId, enabled: true });
    const until = await storedUntil();
    const onRevision = (await ir()).revision;
    // Rolling back to a revision without it does not end it ...
    await ctx.db.transaction((tx) =>
      rollbackToRevision(tx, { clusterId, revision: Number(offRevision), actor: service }),
    );
    expect(await latestReason()).toBe("rollback");
    expect((await siteIr())?.name).toBe("app");
    const kept = (await siteIr())?.developmentMode?.expiresAt;
    expect(kept && timestampMs(kept)).toBe(Math.floor((until?.getTime() ?? 0) / 1000) * 1000);
    // ... and rolling back to one with it never revives it once off.
    await admin.developmentMode.set({ id: siteId, enabled: false });
    await ctx.db.transaction((tx) =>
      rollbackToRevision(tx, { clusterId, revision: Number(onRevision), actor: service }),
    );
    // (Its content is the current one then: nothing new to publish.)
    expect((await siteIr())?.name).toBe("app-renamed");
    expect((await siteIr())?.developmentMode).toBeUndefined();
  });

  it("needs an enabled site to turn on", async () => {
    await admin.sites.setEnabled({ id: otherSiteId, enabled: false });
    expect(
      await rpcError(admin.developmentMode.set({ id: otherSiteId, enabled: true })),
    ).toMatchObject({ code: "SITE_DISABLED" });
    expect(await storedUntil(otherSiteId)).toBeNull();
    await admin.sites.setEnabled({ id: otherSiteId, enabled: true });
  });

  it("counts nodes that cannot bypass their cache", async () => {
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: FULL })
      .where(eq(schema.node.id, nodeId));
    expect((await getDevelopmentMode(ctx.db, siteId)).unsupportedNodes).toBe(1);
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: [...FULL, DEVELOPMENT_MODE_FEATURE] })
      .where(eq(schema.node.id, nodeId));
    expect((await getDevelopmentMode(ctx.db, siteId)).unsupportedNodes).toBe(0);
  });

  it("is served over the API with an AccessKey", async () => {
    const key = (await admin.accessKeys.create({ name: "dev-mode" })).key;
    const call = async (method: string, body?: unknown) => {
      const res = await app.request(`${origin}/api/v1/sites/${siteId}/development-mode`, {
        method,
        headers: { "x-api-key": key, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    };
    const on = await call("PUT", { enabled: true });
    expect(on.status).toBe(200);
    expect(typeof on.json.until).toBe("string");
    expect((await call("GET")).json.until).toBe(on.json.until);
    expect((await call("PUT", { enabled: false })).json.until).toBeNull();
  });
});
