import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { banChanges } from "../../src/server/services/bans";
import { greylistChallenges } from "../../src/server/services/greylist";
import { latestRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const HOUR = 3600;

describe("IP greylist", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let siteId: string;
  const origins = [{ address: "origin.test", port: 8080 }];
  const auditOf = async (targetId: string) =>
    (
      await ctx.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.targetId, targetId))
        .orderBy(schema.auditLog.id)
    ).map((row) => row.action);
  const liftAll = () =>
    ctx.db
      .update(schema.ipBan)
      .set({ removedAt: new Date() })
      .where(sql`${schema.ipBan.removedAt} is null`);
  const config = async () => {
    const latest = await latestRevision(ctx.db, clusterId);
    if (!latest) throw new Error("no revision");
    return decodeNodeConfig(latest.ir);
  };

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = (await admin.sites.create({ name: "shop", domains: ["shop.grey.test"], origins })).site
      .id;
  });
  afterAll(() => pglite.close());

  it("creates, lists, renews and lifts an entry apart from the bans, with audit entries", async () => {
    const created = await admin.greylist.create({
      scope: "site",
      siteId,
      cidr: "203.0.113.7",
      reason: "abuse",
      durationSeconds: HOUR,
      action: { kind: "rate_limit", requests: 30, windowSeconds: 60 },
    });
    expect(created).toMatchObject({
      scope: "site",
      cidr: "203.0.113.7/32",
      siteId,
      siteName: "shop",
      action: { kind: "rate_limit", requests: 30, windowSeconds: 60 },
    });
    // A ban of the same address is a separate entry.
    const ban = await admin.bans.create({
      scope: "site",
      siteId,
      cidr: "203.0.113.7",
      reason: "abuse",
      durationSeconds: HOUR,
    });
    expect(ban.id).not.toBe(created.id);
    expect((await admin.bans.list({})).items.map((b) => b.id)).toEqual([ban.id]);
    const listed = await admin.greylist.list({ address: "203.0.113.0/24" });
    expect(listed.items.map((e) => e.id)).toEqual([created.id]);
    expect(listed.total).toBe(1);

    const renewed = await admin.greylist.create({
      scope: "site",
      siteId,
      cidr: "203.0.113.7/32",
      reason: "scanner",
      durationSeconds: 2 * HOUR,
      action: { kind: "challenge", challenge: "pow" },
    });
    expect(renewed).toMatchObject({
      id: created.id,
      reason: "scanner",
      action: { kind: "challenge", challenge: "pow" },
    });

    await admin.greylist.delete({ id: created.id });
    expect((await admin.greylist.list({})).items).toEqual([]);
    expect((await rpcError(admin.greylist.delete({ id: created.id }))).code).toBe("BAN_NOT_FOUND");
    // Lifting the greylist entry leaves the ban.
    expect((await admin.bans.list({})).items.map((b) => b.id)).toEqual([ban.id]);
    expect(await auditOf(created.id)).toEqual([
      "greylist.create",
      "greylist.update",
      "greylist.delete",
    ]);
    await liftAll();
  });

  it("refuses protected addresses and counts against the platform total", async () => {
    const error = await rpcError(
      admin.greylist.create({
        scope: "platform",
        cidr: "127.0.0.1",
        reason: "abuse",
        durationSeconds: HOUR,
        action: { kind: "challenge", challenge: "js" },
      }),
    );
    expect(error.code).toBe("BAN_PROTECTED_ADDRESS");

    await admin.settings.setBans({ maxTotal: 100, shareAutoBans: true });
    const expiresAt = new Date(Date.now() + HOUR * 1000);
    await ctx.db.insert(schema.ipBan).values(
      Array.from({ length: 100 }, (_, i) => ({
        scope: "platform",
        cidr: `10.9.0.${i}/32`,
        reason: "abuse",
        source: "manual",
        expiresAt,
        seq: BigInt(1_000_000 + i),
      })),
    );
    const full = await rpcError(
      admin.greylist.create({
        scope: "platform",
        cidr: "198.51.100.2",
        reason: "abuse",
        durationSeconds: HOUR,
        action: { kind: "challenge", challenge: "js" },
      }),
    );
    expect(full.code).toBe("BAN_PLATFORM_LIMIT");
    await liftAll();
    await admin.settings.setBans({ maxTotal: 10000, shareAutoBans: true });
  });

  it("travels in GetBans only to nodes that ask for greylist entries", async () => {
    const entry = await admin.greylist.create({
      scope: "platform",
      cidr: "192.0.2.0/24",
      reason: "abuse",
      durationSeconds: HOUR,
      action: { kind: "rate_limit", requests: 10, windowSeconds: 1 },
    });
    const [node] = await ctx.db
      .insert(schema.node)
      .values({ clusterId, name: "edge-grey", status: "active" })
      .returning({ id: schema.node.id, clusterId: schema.node.clusterId });
    if (!node) throw new Error("no node");
    const plain = await banChanges(ctx.db, node, 0n, 100);
    expect(plain.bans.map((b) => b.id)).not.toContain(entry.id);
    const grey = await banChanges(ctx.db, node, 0n, 100, new Date(), true);
    expect(grey.bans.find((b) => b.id === entry.id)).toMatchObject({
      action: "rate_limit",
      rateLimitRequests: 10,
      rateLimitWindowSeconds: 1,
    });
    await ctx.db.delete(schema.node).where(eq(schema.node.id, node.id));
    await liftAll();
  });

  it("compiles challenge keys while a challenge entry lasts", async () => {
    expect(await greylistChallenges(ctx.db, clusterId)).toBe(false);
    await admin.greylist.create({
      scope: "platform",
      cidr: "198.51.100.0/24",
      reason: "abuse",
      durationSeconds: HOUR,
      action: { kind: "rate_limit", requests: 5, windowSeconds: 10 },
    });
    expect(await greylistChallenges(ctx.db, clusterId)).toBe(false);
    await admin.greylist.create({
      scope: "site",
      siteId,
      cidr: "2001:db8::/48",
      reason: "abuse",
      durationSeconds: HOUR,
      action: { kind: "challenge", challenge: "captcha" },
    });
    expect(await greylistChallenges(ctx.db, clusterId)).toBe(true);
    expect((await config()).challengeKeys.length).toBeGreaterThan(0);
    await liftAll();
    expect(await greylistChallenges(ctx.db, clusterId)).toBe(false);
  });
});
