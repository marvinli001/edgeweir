import { schema } from "@edgeweir/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { pruneBans, reportAutoBans } from "../../src/server/services/bans";
import {
  type ApiClient,
  createTestContext,
  PASSWORD,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const HOUR = 3600;

describe("dynamic bans", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let owner: ApiClient;
  let orgAdmin: ApiClient;
  let member: ApiClient;
  let outsider: ApiClient;
  let clusterId: string;
  let orgId: string;
  let otherOrgId: string;
  let siteId: string;
  let otherSiteId: string;
  const origins = [{ address: "origin.test", port: 8080 }];
  const api = (key: string, method: string, path: string, body?: unknown) =>
    app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const auditOf = async (targetId: string) =>
    (
      await ctx.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.targetId, targetId))
        .orderBy(schema.auditLog.id)
    ).map((row) => ({
      action: row.action,
      organizationId: row.organizationId,
      metadata: row.metadata,
    }));
  const liftAll = async () => {
    await ctx.db
      .update(schema.ipBan)
      .set({ removedAt: new Date() })
      .where(sql`${schema.ipBan.removedAt} is null`);
  };

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    orgId = (await admin.organizations.create({ name: "Banned", defaultClusterId: clusterId })).id;
    otherOrgId = (await admin.organizations.create({ name: "Other", defaultClusterId: clusterId }))
      .id;
    const users: [string, string, "owner" | "admin" | "member"][] = [
      ["owner@bans.test", orgId, "owner"],
      ["admin@bans.test", orgId, "admin"],
      ["member@bans.test", orgId, "member"],
      ["owner@other.test", otherOrgId, "owner"],
    ];
    for (const [email, organizationId, role] of users)
      await admin.users.create({ name: email, email, password: PASSWORD, organizationId, role });
    owner = rpcClient(app, origin, await signIn(app, origin, "owner@bans.test"));
    orgAdmin = rpcClient(app, origin, await signIn(app, origin, "admin@bans.test"));
    member = rpcClient(app, origin, await signIn(app, origin, "member@bans.test"));
    outsider = rpcClient(app, origin, await signIn(app, origin, "owner@other.test"));
    siteId = (await owner.sites.create({ name: "shop", domains: ["shop.bans.test"], origins })).site
      .id;
    otherSiteId = (
      await outsider.sites.create({ name: "other", domains: ["other.bans.test"], origins })
    ).site.id;
  });
  afterAll(() => pglite.close());

  it("creates, lists, bans again and lifts a site ban, with audit entries", async () => {
    const created = await owner.bans.create({
      siteId,
      cidr: "203.0.113.7",
      reason: "abuse",
      durationSeconds: HOUR,
    });
    expect(created).toMatchObject({
      scope: "site",
      cidr: "203.0.113.7/32",
      reason: "abuse",
      source: "manual",
      siteId,
      siteName: "shop",
      organizationId: orgId,
      organizationName: "Banned",
      node: null,
      trigger: null,
      createdBy: { type: "user", name: "owner@bans.test" },
      distributed: true,
      unappliedNodes: 0,
    });
    const lifetime = Date.parse(created.expiresAt) - Date.parse(created.createdAt);
    expect(Math.abs(lifetime - HOUR * 1000)).toBeLessThan(5000);
    const listed = await owner.bans.list({});
    expect(listed.total).toBe(1);
    expect(listed.items.map((b) => b.id)).toEqual([created.id]);

    // Banning the same address of the same site again updates reason and expiry.
    const again = await orgAdmin.bans.create({
      siteId,
      cidr: "203.0.113.7/32",
      reason: "attack",
      durationSeconds: 2 * HOUR,
    });
    expect(again.id).toBe(created.id);
    expect(again.reason).toBe("attack");
    expect(BigInt(again.seq)).toBeGreaterThan(BigInt(created.seq));
    expect(Date.parse(again.expiresAt)).toBeGreaterThan(Date.parse(created.expiresAt));
    expect(again.createdBy?.name).toBe("owner@bans.test");
    expect((await owner.bans.list({})).total).toBe(1);

    expect(await owner.bans.delete({ id: created.id })).toEqual({ ok: true });
    expect((await owner.bans.list({})).total).toBe(0);
    const gone = await rpcError(owner.bans.delete({ id: created.id }));
    expect(gone).toMatchObject({ code: "BAN_NOT_FOUND", status: 404 });
    const [row] = await ctx.db.select().from(schema.ipBan).where(eq(schema.ipBan.id, created.id));
    expect(row?.removedAt).not.toBeNull();
    expect(row?.seq).toBeGreaterThan(BigInt(again.seq));

    const audit = await auditOf(created.id);
    expect(audit.map((a) => a.action)).toEqual(["ban.create", "ban.update", "ban.delete"]);
    for (const entry of audit) expect(entry.organizationId).toBe(orgId);
    expect(audit[0]?.metadata).toMatchObject({
      scope: "site",
      siteId,
      siteName: "shop",
      cidr: "203.0.113.7/32",
      reason: "abuse",
    });
    expect(audit[1]?.metadata).toMatchObject({ reason: "attack", previousReason: "abuse" });
    expect(audit[2]?.metadata).toMatchObject({ source: "manual", seq: row?.seq.toString() });

    // A lifted ban leaves room for a new entry of the same address.
    const fresh = await owner.bans.create({
      siteId,
      cidr: "203.0.113.7",
      reason: "spam",
      durationSeconds: HOUR,
    });
    expect(fresh.id).not.toBe(created.id);
    await owner.bans.delete({ id: fresh.id });
  });

  it("canonicalizes addresses and validates prefix, expiry and address syntax", async () => {
    const cases: [string, string][] = [
      ["198.51.100.77/24", "198.51.100.0/24"],
      ["2001:DB8:0:0::1/64", "2001:db8::/64"],
      ["2001:db8:0:0:0:0:0:1", "2001:db8::1/128"],
      ["::ffff:192.0.2.9", "192.0.2.9/32"],
      ["10.20.0.0/16", "10.20.0.0/16"],
      ["2001:db8:1::/48", "2001:db8:1::/48"],
    ];
    for (const [input, cidr] of cases) {
      const ban = await owner.bans.create({
        siteId,
        cidr: input,
        reason: "scanner",
        durationSeconds: 60,
      });
      expect(ban.cidr, input).toBe(cidr);
    }
    for (const [input, min] of [
      ["10.0.0.0/15", 16],
      ["0.0.0.0/0", 16],
      ["2001:db8::/47", 48],
    ] as const) {
      const error = await rpcError(
        owner.bans.create({ siteId, cidr: input, reason: "other", durationSeconds: 60 }),
      );
      expect(error, input).toMatchObject({
        code: "BAN_PREFIX_TOO_SHORT",
        status: 400,
        data: { min },
      });
    }
    for (const input of ["not-an-ip", "300.1.1.1", "1.2.3.4/33", "1.2.3.04", "fe80::1%eth0"]) {
      const error = await rpcError(
        owner.bans.create({ siteId, cidr: input, reason: "other", durationSeconds: 60 }),
      );
      expect(error, input).toMatchObject({ code: "BAN_INVALID_CIDR", status: 400 });
    }
    for (const durationSeconds of [0, 59, 7 * 24 * HOUR + 1]) {
      const error = await rpcError(
        owner.bans.create({ siteId, cidr: "192.0.2.200", reason: "other", durationSeconds }),
      );
      expect(error, String(durationSeconds)).toMatchObject({
        code: "BAN_EXPIRY_OUT_OF_RANGE",
        status: 400,
      });
    }
    const week = await owner.bans.create({
      siteId,
      cidr: "192.0.2.200",
      reason: "other",
      durationSeconds: 7 * 24 * HOUR,
    });
    expect(Date.parse(week.expiresAt) - Date.parse(week.createdAt)).toBeLessThanOrEqual(
      7 * 24 * HOUR * 1000 + 1000,
    );
    // Reason codes are fixed; automatic reasons cannot be set by hand.
    expect(
      (
        await rpcError(
          owner.bans.create({
            siteId,
            cidr: "192.0.2.201",
            reason: "cc_ip_rate" as "other",
            durationSeconds: 60,
          }),
        )
      ).code,
    ).toBe("BAD_REQUEST");
    await liftAll();
  });

  it("refuses bans covering loopback, unspecified, node and platform allow-list addresses", async () => {
    for (const [cidr, address] of [
      ["127.0.0.1", "127.0.0.0/8"],
      ["::1", "::1/128"],
      ["0.0.0.0/16", "0.0.0.0/8"],
      ["::/48", "::/128"],
      ["::ffff:127.0.0.1", "127.0.0.0/8"],
    ] as const) {
      const error = await rpcError(
        owner.bans.create({ siteId, cidr, reason: "other", durationSeconds: 60 }),
      );
      expect(error, cidr).toMatchObject({
        code: "BAN_PROTECTED_ADDRESS",
        status: 400,
        data: { address },
      });
    }
    const [node] = await ctx.db
      .insert(schema.node)
      .values({ clusterId, name: "edge-protected" })
      .returning();
    await ctx.db.insert(schema.nodeIp).values([
      { nodeId: node?.id ?? "", address: "192.0.2.10" },
      { nodeId: node?.id ?? "", address: "2001:db8:ffff::10" },
    ]);
    expect(
      (
        await rpcError(
          owner.bans.create({ siteId, cidr: "192.0.2.0/24", reason: "other", durationSeconds: 60 }),
        )
      ).data,
    ).toEqual({ address: "192.0.2.10" });
    expect(
      (
        await rpcError(
          admin.admin.bans.create({
            scope: "platform",
            cidr: "2001:db8:ffff::/48",
            reason: "attack",
            durationSeconds: 60,
          }),
        )
      ).data,
    ).toEqual({ address: "2001:db8:ffff::10" });
    await admin.platformIpLists.create({
      name: "trusted",
      kind: "allow",
      entries: ["198.18.0.0/15"],
    });
    expect(
      (
        await rpcError(
          owner.bans.create({ siteId, cidr: "198.18.7.1", reason: "other", durationSeconds: 60 }),
        )
      ).data,
    ).toEqual({ address: "198.18.0.0/15" });
    // Collections that are not allow lists do not protect anything.
    await admin.platformIpLists.create({ name: "watch", entries: ["198.51.100.0/24"] });
    await owner.bans.create({ siteId, cidr: "198.51.100.1", reason: "other", durationSeconds: 60 });
    await liftAll();
  });

  it("limits active manual site bans per organization, also under concurrent creation", async () => {
    await admin.admin.organizations.setLimits({ id: orgId, limits: { bans: 3 } });
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, (_, i) =>
        owner.bans.create({
          siteId,
          cidr: `203.0.113.${10 + i}`,
          reason: "abuse",
          durationSeconds: HOUR,
        }),
      ),
    );
    const refused = results.filter((r) => r.status === "rejected");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    for (const r of refused)
      expect((r as PromiseRejectedResult).reason).toMatchObject({
        code: "ORG_LIMIT_EXCEEDED",
        status: 409,
        data: { resource: "bans", limit: 3, current: 3 },
      });
    expect((await owner.bans.list({})).total).toBe(3);
    expect((await owner.organization.limits()).usage.bans).toBe(3);
    // Banning an active entry again does not add a ban.
    const [first] = (await owner.bans.list({})).items;
    await owner.bans.create({
      siteId,
      cidr: first?.cidr ?? "",
      reason: "attack",
      durationSeconds: HOUR,
    });
    // Automatic bans do not count.
    const [edge] = await ctx.db
      .insert(schema.node)
      .values({ clusterId, name: "edge-auto" })
      .returning();
    const accepted = await reportAutoBans(ctx.db, { id: edge?.id ?? "", clusterId }, [
      {
        siteId,
        cidr: "198.51.100.200/32",
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
        reason: "cc_ip_rate",
        metric: "ip_qps",
        observed: 250,
        threshold: 100,
        windowSeconds: 10,
      },
    ]);
    expect(accepted).toBe(1);
    expect((await owner.organization.limits()).usage.bans).toBe(3);
    expect((await owner.bans.list({ source: "auto" })).total).toBe(1);
    // Lifting one makes room again; other organizations are not limited.
    await owner.bans.delete({ id: first?.id ?? "" });
    await owner.bans.create({
      siteId,
      cidr: "203.0.113.99",
      reason: "abuse",
      durationSeconds: HOUR,
    });
    await outsider.bans.create({
      siteId: otherSiteId,
      cidr: "203.0.113.10",
      reason: "abuse",
      durationSeconds: HOUR,
    });
    await admin.admin.organizations.setLimits({ id: orgId, limits: {} });
    await liftAll();
  });

  it("limits active manual bans across the platform (system setting)", async () => {
    expect(await admin.settings.bans()).toEqual({ maxTotal: 10000, shareAutoBans: true });
    expect(
      (await rpcError(admin.settings.setBans({ maxTotal: 99, shareAutoBans: true }))).code,
    ).toBe("BAD_REQUEST");
    expect(
      (await rpcError(admin.settings.setBans({ maxTotal: 100001, shareAutoBans: true }))).code,
    ).toBe("BAD_REQUEST");
    await admin.settings.setBans({ maxTotal: 100, shareAutoBans: true });
    const [entry] = (await admin.auditLogs.list({ action: "system.bans_update" })).items;
    expect(entry?.metadata).toEqual({
      from: { maxTotal: 10000, shareAutoBans: true },
      to: { maxTotal: 100, shareAutoBans: true },
    });
    const expiresAt = new Date(Date.now() + 3_600_000);
    await ctx.db.insert(schema.ipBan).values(
      Array.from({ length: 99 }, (_, i) => ({
        scope: "platform",
        cidr: `10.${Math.floor(i / 250)}.${i % 250}.1/32`,
        reason: "abuse",
        source: "manual",
        expiresAt,
        seq: sql`nextval('ip_ban_seq')`,
      })),
    );
    const last = await owner.bans.create({
      siteId,
      cidr: "203.0.113.50",
      reason: "abuse",
      durationSeconds: HOUR,
    });
    const error = await rpcError(
      admin.admin.bans.create({
        scope: "platform",
        cidr: "203.0.113.51",
        reason: "abuse",
        durationSeconds: HOUR,
      }),
    );
    expect(error).toMatchObject({ code: "BAN_PLATFORM_LIMIT", status: 409, data: { limit: 100 } });
    expect(
      (
        await rpcError(
          owner.bans.create({
            siteId,
            cidr: "203.0.113.52",
            reason: "abuse",
            durationSeconds: HOUR,
          }),
        )
      ).code,
    ).toBe("BAN_PLATFORM_LIMIT");
    // Banning an active entry again still works at the limit.
    await owner.bans.create({ siteId, cidr: last.cidr, reason: "spam", durationSeconds: HOUR });
    await admin.settings.setBans({ maxTotal: 10000, shareAutoBans: true });
    await liftAll();
  });

  it("lets members read bans but only owners and admins change them", async () => {
    const ban = await owner.bans.create({
      siteId,
      cidr: "192.0.2.77",
      reason: "abuse",
      durationSeconds: HOUR,
    });
    expect((await member.bans.list({})).items.map((b) => b.id)).toEqual([ban.id]);
    const create = await rpcError(
      member.bans.create({ siteId, cidr: "192.0.2.78", reason: "abuse", durationSeconds: HOUR }),
    );
    expect(create).toMatchObject({ code: "ORG_ADMIN_REQUIRED", status: 403 });
    expect(await rpcError(member.bans.delete({ id: ban.id }))).toMatchObject({
      code: "ORG_ADMIN_REQUIRED",
      status: 403,
    });

    // Tenants never reach the admin procedures.
    for (const call of [
      () => owner.admin.bans.list({}),
      () =>
        owner.admin.bans.create({
          scope: "platform",
          cidr: "192.0.2.79",
          reason: "abuse",
          durationSeconds: HOUR,
        }),
      () => owner.admin.bans.delete({ id: ban.id }),
      () => owner.settings.bans(),
      () => owner.settings.setBans({ maxTotal: 100, shareAutoBans: false }),
    ])
      expect((await rpcError(call())).status).toBe(403);

    // Another organization neither sees nor touches the site or its bans.
    expect((await outsider.bans.list({})).items.map((b) => b.id)).not.toContain(ban.id);
    expect((await rpcError(outsider.bans.list({ siteId }))).code).toBe("SITE_NOT_FOUND");
    expect(
      (
        await rpcError(
          outsider.bans.create({
            siteId,
            cidr: "192.0.2.80",
            reason: "abuse",
            durationSeconds: HOUR,
          }),
        )
      ).code,
    ).toBe("SITE_NOT_FOUND");
    expect((await rpcError(outsider.bans.delete({ id: ban.id }))).code).toBe("BAN_NOT_FOUND");

    // Read-only AccessKeys read but cannot write.
    const key = await owner.accessKeys.create({ name: "bans-read", scope: "read" });
    const read = await api(key.key, "GET", `/bans?siteId=${siteId}`);
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { items: { id: string }[] };
    expect(readBody.items.map((b) => b.id)).toEqual([ban.id]);
    const post = await api(key.key, "POST", "/bans", {
      siteId,
      cidr: "192.0.2.81",
      reason: "abuse",
      durationSeconds: HOUR,
    });
    expect(post.status).toBe(403);
    expect(await post.json()).toMatchObject({ code: "ACCESS_KEY_READ_ONLY" });
    const del = await api(key.key, "DELETE", `/bans/${ban.id}`);
    expect(del.status).toBe(403);
    // A read-write key works through /api/v1.
    const writer = await owner.accessKeys.create({ name: "bans-write", scope: "write" });
    const created = await api(writer.key, "POST", "/bans", {
      siteId,
      cidr: "192.0.2.82",
      reason: "scanner",
      durationSeconds: HOUR,
    });
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({ cidr: "192.0.2.82/32", source: "manual" });
    expect((await api(writer.key, "DELETE", `/bans/${ban.id}`)).status).toBe(200);
    await liftAll();
  });

  it("gives platform administrators every ban and platform bans", async () => {
    const platform = await admin.admin.bans.create({
      scope: "platform",
      cidr: "203.0.113.0/24",
      reason: "attack",
      durationSeconds: 6 * HOUR,
    });
    expect(platform).toMatchObject({
      scope: "platform",
      siteId: null,
      siteName: null,
      organizationId: null,
      createdBy: { type: "user", name: "Platform Admin" },
    });
    for (const input of [
      { scope: "platform" as const, siteId },
      { scope: "site" as const, siteId: undefined },
    ])
      expect(
        (
          await rpcError(
            admin.admin.bans.create({
              ...input,
              cidr: "203.0.114.0/24",
              reason: "attack",
              durationSeconds: HOUR,
            }),
          )
        ).code,
      ).toBe("BAD_REQUEST");
    const site = await admin.admin.bans.create({
      scope: "site",
      siteId: otherSiteId,
      cidr: "203.0.113.5",
      reason: "spam",
      durationSeconds: HOUR,
    });
    expect(site).toMatchObject({ scope: "site", organizationId: otherOrgId, siteName: "other" });
    expect((await auditOf(site.id))[0]).toMatchObject({
      action: "ban.create",
      organizationId: otherOrgId,
    });
    expect((await auditOf(platform.id))[0]).toMatchObject({
      action: "ban.create",
      organizationId: null,
    });

    expect((await admin.admin.bans.list({ scope: "platform" })).items.map((b) => b.id)).toEqual([
      platform.id,
    ]);
    expect(
      (await admin.admin.bans.list({ organizationId: otherOrgId })).items.map((b) => b.id),
    ).toEqual([site.id]);
    expect((await admin.admin.bans.list({})).total).toBe(2);
    // Tenant procedures only ever see site bans.
    expect((await outsider.bans.list({})).items.map((b) => b.id)).toEqual([site.id]);
    expect((await admin.bans.list({})).items.map((b) => b.id)).toEqual([site.id]);
    expect((await rpcError(admin.bans.delete({ id: platform.id }))).code).toBe("BAN_NOT_FOUND");
    // Banning a platform address again renews the same entry.
    const renewed = await admin.admin.bans.create({
      scope: "platform",
      cidr: "203.0.113.9/24",
      reason: "scanner",
      durationSeconds: HOUR,
    });
    expect(renewed.id).toBe(platform.id);
    expect(await admin.admin.bans.delete({ id: platform.id })).toEqual({ ok: true });
    expect(await outsider.bans.delete({ id: site.id })).toEqual({ ok: true });
    expect((await admin.admin.bans.list({})).total).toBe(0);
    expect((await auditOf(platform.id)).map((a) => a.action)).toEqual([
      "ban.create",
      "ban.update",
      "ban.delete",
    ]);
  });

  it("counts online nodes that report a ban as not applied", async () => {
    const ban = await owner.bans.create({
      siteId,
      cidr: "192.0.2.150",
      reason: "abuse",
      durationSeconds: HOUR,
    });
    const status = (ids: string[]) => ({
      appliedSequence: "1",
      entries: 1,
      capacity: 1,
      unappliedIds: ids,
      unapplied: ids.length,
      kernelEntries: 0,
      autoEvicted: "0",
      reportedAt: new Date().toISOString(),
    });
    await ctx.db.insert(schema.node).values([
      { clusterId, name: "full-1", lastSeenAt: new Date(), banStatus: status([ban.id]) },
      { clusterId, name: "full-2", lastSeenAt: new Date(), banStatus: status([ban.id]) },
      { clusterId, name: "fine", lastSeenAt: new Date(), banStatus: status([]) },
      {
        clusterId,
        name: "offline",
        lastSeenAt: new Date(Date.now() - 3_600_000),
        banStatus: status([ban.id]),
      },
      {
        clusterId,
        name: "disabled",
        status: "disabled",
        lastSeenAt: new Date(),
        banStatus: status([ban.id]),
      },
    ]);
    const [listed] = (await owner.bans.list({})).items;
    expect(listed).toMatchObject({ id: ban.id, unappliedNodes: 2 });
    await liftAll();
  });

  it("serializes ban writes so that sequence order is commit order", async () => {
    const before = await ctx.db.select({ id: schema.auditLog.id }).from(schema.auditLog);
    const floor = Math.max(0, ...before.map((row) => row.id));
    const created = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 ? owner : admin).bans.create({
          siteId,
          cidr: `198.51.100.${100 + i}`,
          reason: "abuse",
          durationSeconds: HOUR,
        }),
      ),
    );
    await Promise.all(created.slice(0, 6).map((ban) => owner.bans.delete({ id: ban.id })));
    const entries = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          sql`${schema.auditLog.id} > ${floor}`,
          inArray(schema.auditLog.action, ["ban.create", "ban.delete"]),
        ),
      )
      .orderBy(schema.auditLog.id);
    expect(entries).toHaveLength(18);
    // Each write took its sequence number under the lock, in the order it committed.
    const seqs = entries.map((entry) => BigInt(String(entry.metadata.seq)));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect([...seqs].sort((a, b) => (a < b ? -1 : 1))).toEqual(seqs);
    await liftAll();
  });

  it("deletes bans an hour after they expired", async () => {
    const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);
    const rows = await ctx.db
      .insert(schema.ipBan)
      .values(
        [
          ["192.0.2.1/32", at(-120), null],
          ["192.0.2.2/32", at(-61), at(-100)],
          ["192.0.2.3/32", at(-30), null],
          ["192.0.2.4/32", at(30), at(-5)],
        ].map(([cidr, expiresAt, removedAt]) => ({
          scope: "site",
          organizationId: orgId,
          siteId,
          clusterId,
          cidr: cidr as string,
          reason: "abuse",
          source: "manual",
          expiresAt: expiresAt as Date,
          removedAt: removedAt as Date | null,
          seq: sql`nextval('ip_ban_seq')`,
        })),
      )
      .returning({ id: schema.ipBan.id, cidr: schema.ipBan.cidr });
    expect(await pruneBans(ctx.db)).toBeGreaterThanOrEqual(2);
    const left = await ctx.db
      .select({ cidr: schema.ipBan.cidr })
      .from(schema.ipBan)
      .where(
        inArray(
          schema.ipBan.id,
          rows.map((row) => row.id),
        ),
      );
    expect(left.map((row) => row.cidr).sort()).toEqual(["192.0.2.3/32", "192.0.2.4/32"]);
  });

  it("deletes a site's bans with the site", async () => {
    const doomed = (
      await owner.sites.create({ name: "doomed", domains: ["doomed.bans.test"], origins })
    ).site;
    const ban = await owner.bans.create({
      siteId: doomed.id,
      cidr: "192.0.2.160",
      reason: "abuse",
      durationSeconds: HOUR,
    });
    await owner.sites.delete({ id: doomed.id });
    expect(
      await ctx.db.select().from(schema.ipBan).where(eq(schema.ipBan.id, ban.id)),
    ).toHaveLength(0);
  });
});
