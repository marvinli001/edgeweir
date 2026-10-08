import type { Ban } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  banChanges,
  currentBanSequence,
  pruneBans,
  reportAutoBans,
} from "../../src/server/services/bans";
import {
  type ApiClient,
  createTestContext,
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
  let clusterId: string;
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
    ).map((row) => ({ action: row.action, metadata: row.metadata }));
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
    siteId = (await admin.sites.create({ name: "shop", domains: ["shop.bans.test"], origins })).site
      .id;
    otherSiteId = (
      await admin.sites.create({ name: "other", domains: ["other.bans.test"], origins })
    ).site.id;
  });
  afterAll(() => pglite.close());

  it("creates, lists, bans again and lifts a site ban, with audit entries", async () => {
    const created = await admin.bans.create({
      scope: "site",
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
      node: null,
      trigger: null,
      createdBy: { type: "user", name: "Platform Admin" },
      distributed: true,
      unappliedNodes: 0,
    });
    const lifetime = Date.parse(created.expiresAt) - Date.parse(created.createdAt);
    expect(Math.abs(lifetime - HOUR * 1000)).toBeLessThan(5000);
    const listed = await admin.bans.list({});
    expect(listed.total).toBe(1);
    expect(listed.items.map((b) => b.id)).toEqual([created.id]);

    // Banning the same address of the same site again updates reason and expiry;
    // the ban keeps who created it (here it is banned again with an AccessKey).
    const writer = await admin.accessKeys.create({ name: "bans-again", scope: "write" });
    const res = await api(writer.key, "POST", "/bans", {
      scope: "site",
      siteId,
      cidr: "203.0.113.7/32",
      reason: "attack",
      durationSeconds: 2 * HOUR,
    });
    expect(res.status).toBe(200);
    const again = (await res.json()) as Ban;
    expect(again.id).toBe(created.id);
    expect(again.reason).toBe("attack");
    expect(BigInt(again.seq)).toBeGreaterThan(BigInt(created.seq));
    expect(Date.parse(again.expiresAt)).toBeGreaterThan(Date.parse(created.expiresAt));
    expect(again.createdBy).toEqual(created.createdBy);
    expect((await admin.bans.list({})).total).toBe(1);

    expect(await admin.bans.delete({ id: created.id })).toEqual({ ok: true });
    expect((await admin.bans.list({})).total).toBe(0);
    const gone = await rpcError(admin.bans.delete({ id: created.id }));
    expect(gone).toMatchObject({ code: "BAN_NOT_FOUND", status: 404 });
    const [row] = await ctx.db.select().from(schema.ipBan).where(eq(schema.ipBan.id, created.id));
    expect(row?.removedAt).not.toBeNull();
    expect(row?.seq).toBeGreaterThan(BigInt(again.seq));

    const audit = await auditOf(created.id);
    expect(audit.map((a) => a.action)).toEqual(["ban.create", "ban.update", "ban.delete"]);
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
    const fresh = await admin.bans.create({
      scope: "site",
      siteId,
      cidr: "203.0.113.7",
      reason: "spam",
      durationSeconds: HOUR,
    });
    expect(fresh.id).not.toBe(created.id);
    await admin.bans.delete({ id: fresh.id });
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
      const ban = await admin.bans.create({
        scope: "site",
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
        admin.bans.create({
          scope: "site",
          siteId,
          cidr: input,
          reason: "other",
          durationSeconds: 60,
        }),
      );
      expect(error, input).toMatchObject({
        code: "BAN_PREFIX_TOO_SHORT",
        status: 400,
        data: { min },
      });
    }
    for (const input of ["not-an-ip", "300.1.1.1", "1.2.3.4/33", "1.2.3.04", "fe80::1%eth0"]) {
      const error = await rpcError(
        admin.bans.create({
          scope: "site",
          siteId,
          cidr: input,
          reason: "other",
          durationSeconds: 60,
        }),
      );
      expect(error, input).toMatchObject({ code: "BAN_INVALID_CIDR", status: 400 });
    }
    for (const durationSeconds of [0, 59, 7 * 24 * HOUR + 1]) {
      const error = await rpcError(
        admin.bans.create({
          scope: "site",
          siteId,
          cidr: "192.0.2.200",
          reason: "other",
          durationSeconds,
        }),
      );
      expect(error, String(durationSeconds)).toMatchObject({
        code: "BAN_EXPIRY_OUT_OF_RANGE",
        status: 400,
      });
    }
    const week = await admin.bans.create({
      scope: "site",
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
          admin.bans.create({
            scope: "site",
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

  it("refuses bans covering loopback, unspecified, node and allow-list addresses", async () => {
    for (const [cidr, address] of [
      ["127.0.0.1", "127.0.0.0/8"],
      ["::1", "::1/128"],
      ["0.0.0.0/16", "0.0.0.0/8"],
      ["::/48", "::/128"],
      ["::ffff:127.0.0.1", "127.0.0.0/8"],
    ] as const) {
      const error = await rpcError(
        admin.bans.create({ scope: "site", siteId, cidr, reason: "other", durationSeconds: 60 }),
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
          admin.bans.create({
            scope: "site",
            siteId,
            cidr: "192.0.2.0/24",
            reason: "other",
            durationSeconds: 60,
          }),
        )
      ).data,
    ).toEqual({ address: "192.0.2.10" });
    expect(
      (
        await rpcError(
          admin.bans.create({
            scope: "platform",
            cidr: "2001:db8:ffff::/48",
            reason: "attack",
            durationSeconds: 60,
          }),
        )
      ).data,
    ).toEqual({ address: "2001:db8:ffff::10" });
    await admin.ipLists.create({
      name: "trusted",
      kind: "allow",
      entries: ["198.18.0.0/15"],
    });
    expect(
      (
        await rpcError(
          admin.bans.create({
            scope: "site",
            siteId,
            cidr: "198.18.7.1",
            reason: "other",
            durationSeconds: 60,
          }),
        )
      ).data,
    ).toEqual({ address: "198.18.0.0/15" });
    // Collections that are not allow lists do not protect anything.
    await admin.ipLists.create({ name: "watch", entries: ["198.51.100.0/24"] });
    await admin.bans.create({
      scope: "site",
      siteId,
      cidr: "198.51.100.1",
      reason: "other",
      durationSeconds: 60,
    });
    await liftAll();
  });

  it("protects node addresses only within the node's cluster and never a reported range", async () => {
    const elsewhere = (await admin.clusters.create({ name: "bans-elsewhere" })).id;
    const [far, near] = await ctx.db
      .insert(schema.node)
      .values([
        { clusterId: elsewhere, name: "edge-elsewhere" },
        { clusterId, name: "edge-range" },
      ])
      .returning();
    // A node of another cluster, and rows stored before addresses were checked.
    await ctx.db.insert(schema.nodeIp).values([
      { nodeId: far?.id ?? "", address: "192.0.2.77" },
      { nodeId: near?.id ?? "", address: "0.0.0.0/0" },
      { nodeId: near?.id ?? "", address: "::/0" },
    ]);
    const siteBan = (cidr: string) =>
      admin.bans.create({ scope: "site", siteId, cidr, reason: "other", durationSeconds: 60 });
    expect((await siteBan("192.0.2.77")).cidr).toBe("192.0.2.77/32");
    await siteBan("203.0.113.99");
    await siteBan("2001:db8:9::/48");
    // A platform ban applies on every node, so every node's address holds it back.
    expect(
      (
        await rpcError(
          admin.bans.create({
            scope: "platform",
            cidr: "192.0.2.77",
            reason: "attack",
            durationSeconds: 60,
          }),
        )
      ).data,
    ).toEqual({ address: "192.0.2.77" });
    await liftAll();
    expect(
      await reportAutoBans(ctx.db, { id: near?.id ?? "", clusterId }, [
        {
          scope: "site",
          siteId,
          cidr: "192.0.2.77/32",
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 600_000),
          reason: "cc_ip_rate",
          metric: "ip_qps",
          observed: 250,
          threshold: 100,
          windowSeconds: 10,
        },
      ]),
    ).toBe(1);
    await liftAll();
    await ctx.db
      .delete(schema.node)
      .where(inArray(schema.node.id, [far?.id ?? "", near?.id ?? ""]));
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
    const last = await admin.bans.create({
      scope: "site",
      siteId,
      cidr: "203.0.113.50",
      reason: "abuse",
      durationSeconds: HOUR,
    });
    const error = await rpcError(
      admin.bans.create({
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
          admin.bans.create({
            scope: "site",
            siteId,
            cidr: "203.0.113.52",
            reason: "abuse",
            durationSeconds: HOUR,
          }),
        )
      ).code,
    ).toBe("BAN_PLATFORM_LIMIT");
    // Banning an active entry again still works at the limit.
    await admin.bans.create({
      scope: "site",
      siteId,
      cidr: last.cidr,
      reason: "spam",
      durationSeconds: HOUR,
    });
    await admin.settings.setBans({ maxTotal: 10000, shareAutoBans: true });
    await liftAll();
  });

  it("lets read-only AccessKeys read bans and read-write keys change them", async () => {
    const ban = await admin.bans.create({
      scope: "site",
      siteId,
      cidr: "192.0.2.77",
      reason: "abuse",
      durationSeconds: HOUR,
    });
    // Read-only AccessKeys read but cannot write.
    const key = await admin.accessKeys.create({ name: "bans-read", scope: "read" });
    const read = await api(key.key, "GET", `/bans?siteId=${siteId}`);
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { items: { id: string }[] };
    expect(readBody.items.map((b) => b.id)).toEqual([ban.id]);
    const post = await api(key.key, "POST", "/bans", {
      scope: "site",
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
    const writer = await admin.accessKeys.create({ name: "bans-write", scope: "write" });
    const created = await api(writer.key, "POST", "/bans", {
      scope: "site",
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

  it("lists, renews and lifts platform bans beside site bans", async () => {
    const platform = await admin.bans.create({
      scope: "platform",
      cidr: "203.0.113.0/24",
      reason: "attack",
      durationSeconds: 6 * HOUR,
    });
    expect(platform).toMatchObject({
      scope: "platform",
      siteId: null,
      siteName: null,
      createdBy: { type: "user", name: "Platform Admin" },
    });
    for (const input of [
      { scope: "platform" as const, siteId },
      { scope: "site" as const, siteId: undefined },
    ])
      expect(
        (
          await rpcError(
            admin.bans.create({
              ...input,
              cidr: "203.0.114.0/24",
              reason: "attack",
              durationSeconds: HOUR,
            }),
          )
        ).code,
      ).toBe("BAD_REQUEST");
    const site = await admin.bans.create({
      scope: "site",
      siteId: otherSiteId,
      cidr: "203.0.113.5",
      reason: "spam",
      durationSeconds: HOUR,
    });
    expect(site).toMatchObject({ scope: "site", siteId: otherSiteId, siteName: "other" });
    expect((await auditOf(site.id))[0]).toMatchObject({
      action: "ban.create",
      metadata: { scope: "site", siteId: otherSiteId },
    });
    expect((await auditOf(platform.id))[0]).toMatchObject({
      action: "ban.create",
      metadata: { scope: "platform", siteId: null },
    });

    expect((await admin.bans.list({ scope: "platform" })).items.map((b) => b.id)).toEqual([
      platform.id,
    ]);
    expect((await admin.bans.list({ scope: "site" })).items.map((b) => b.id)).toEqual([site.id]);
    expect((await admin.bans.list({})).total).toBe(2);
    // Banning a platform address again renews the same entry.
    const renewed = await admin.bans.create({
      scope: "platform",
      cidr: "203.0.113.9/24",
      reason: "scanner",
      durationSeconds: HOUR,
    });
    expect(renewed.id).toBe(platform.id);
    expect(await admin.bans.delete({ id: platform.id })).toEqual({ ok: true });
    expect(await admin.bans.delete({ id: site.id })).toEqual({ ok: true });
    expect((await admin.bans.list({})).total).toBe(0);
    expect((await auditOf(platform.id)).map((a) => a.action)).toEqual([
      "ban.create",
      "ban.update",
      "ban.delete",
    ]);
  });

  it("filters bans by an address they cover or that covers them", async () => {
    const ban = (scope: "site" | "platform", cidr: string, site = siteId) =>
      admin.bans.create({
        scope,
        ...(scope === "site" ? { siteId: site } : {}),
        cidr,
        reason: "abuse",
        durationSeconds: HOUR,
      });
    const single = await ban("site", "203.0.113.7");
    const range = await ban("platform", "203.0.113.0/24");
    const other = await ban("site", "198.51.100.7", otherSiteId);
    const v6 = await ban("site", "2001:db8:1:2::/64");
    const ids = async (input: { address: string; siteId?: string }) =>
      (await admin.bans.list(input)).items.map((b) => b.id).sort();
    // The address itself and the ranges that cover it.
    expect(await ids({ address: "203.0.113.7" })).toEqual([single.id, range.id].sort());
    expect(await ids({ address: "203.0.113.7/32", siteId })).toEqual([single.id]);
    // A range lists the bans inside it.
    expect(await ids({ address: "203.0.113.0/16" })).toEqual([single.id, range.id].sort());
    expect(await ids({ address: "203.0.113.8" })).toEqual([range.id]);
    expect(await ids({ address: "198.51.100.7" })).toEqual([other.id]);
    // IPv6 clients are banned by their /64; IPv4-mapped addresses are IPv4.
    expect(await ids({ address: "2001:DB8:1:2::abcd" })).toEqual([v6.id]);
    expect(await ids({ address: "::ffff:203.0.113.7" })).toEqual([single.id, range.id].sort());
    expect(await ids({ address: "192.0.2.1" })).toEqual([]);
    expect(await rpcError(admin.bans.list({ address: "not-an-ip" }))).toMatchObject({
      code: "BAN_INVALID_CIDR",
      status: 400,
    });
    await liftAll();
  });

  it("counts online nodes that report a ban as not applied", async () => {
    const ban = await admin.bans.create({
      scope: "site",
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
    const [listed] = (await admin.bans.list({})).items;
    expect(listed).toMatchObject({ id: ban.id, unappliedNodes: 2 });
    await liftAll();
  });

  it("serializes ban writes so that sequence order is commit order", async () => {
    const before = await ctx.db.select({ id: schema.auditLog.id }).from(schema.auditLog);
    const floor = Math.max(0, ...before.map((row) => row.id));
    const created = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        admin.bans.create({
          scope: "site",
          siteId,
          cidr: `198.51.100.${100 + i}`,
          reason: "abuse",
          durationSeconds: HOUR,
        }),
      ),
    );
    await Promise.all(created.slice(0, 6).map((ban) => admin.bans.delete({ id: ban.id })));
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
      await admin.sites.create({ name: "doomed", domains: ["doomed.bans.test"], origins })
    ).site;
    const ban = await admin.bans.create({
      scope: "site",
      siteId: doomed.id,
      cidr: "192.0.2.160",
      reason: "abuse",
      durationSeconds: HOUR,
    });
    await admin.sites.delete({ id: doomed.id });
    expect(
      await ctx.db.select().from(schema.ipBan).where(eq(schema.ipBan.id, ban.id)),
    ).toHaveLength(0);
  });

  it("keeps a manual site ban beside an unshared automatic one of the same address", async () => {
    const [edge] = await ctx.db
      .insert(schema.node)
      .values({ clusterId, name: "edge-cc", supportedFeatures: ["bans-v1"] })
      .returning();
    const nodeId = edge?.id ?? "";
    await admin.settings.setBans({ maxTotal: 10000, shareAutoBans: false });
    expect(
      await reportAutoBans(ctx.db, { id: nodeId, clusterId }, [
        {
          scope: "site",
          siteId,
          cidr: "198.51.100.120",
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 600_000),
          reason: "cc_ip_rate",
          metric: "ip_qps",
          observed: 250,
          threshold: 100,
          windowSeconds: 10,
        },
      ]),
    ).toBe(1);
    const byCidr = () =>
      ctx.db.select().from(schema.ipBan).where(eq(schema.ipBan.cidr, "198.51.100.120/32"));
    const [auto] = await byCidr();
    expect(auto).toMatchObject({ source: "auto", distributed: false, nodeId });
    const before = await currentBanSequence(ctx.db);
    // Its own entry, sent to the site's cluster; the automatic one stays as it is.
    const manual = await admin.bans.create({
      scope: "site",
      siteId,
      cidr: "198.51.100.120",
      reason: "abuse",
      durationSeconds: HOUR,
    });
    expect(manual).toMatchObject({ source: "manual", distributed: true, node: null });
    expect(manual.id).not.toBe(auto?.id);
    const page = await banChanges(ctx.db, { id: nodeId, clusterId }, before, 1000);
    expect(page.bans.map((b) => b.id)).toEqual([manual.id]);
    expect((await byCidr()).find((row) => row.id === auto?.id)).toEqual(auto);
    await admin.settings.setBans({ maxTotal: 10000, shareAutoBans: true });
    await liftAll();
    await ctx.db.delete(schema.node).where(eq(schema.node.id, nodeId));
  });
});
