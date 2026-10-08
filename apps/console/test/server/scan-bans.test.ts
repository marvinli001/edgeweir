import { schema } from "@edgeweir/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  banChanges,
  currentBanSequence,
  deleteBan,
  listBans,
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

// Scan protection's platform-wide automatic bans: which nodes a lifted,
// never shared one reaches and with which expiry, and how bans covering
// protected addresses are kept.

const HOUR = 3600_000;
const actor = { type: "user" as const, id: "u1", name: "admin" };

describe("platform scan bans", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  /** Cluster A bans for an hour, cluster B for 10 minutes. */
  let clusterA = "";
  let clusterB = "";
  const nodes = { a: "", a2: "", b: "", old: "" };
  const scan = (cidr: string, expiresAt = new Date(Date.now() + HOUR), createdAt = new Date()) => ({
    scope: "platform" as const,
    siteId: "",
    cidr,
    createdAt,
    expiresAt,
    reason: "unknown_host_scan",
    metric: "unknown_host_requests",
    observed: 101,
    threshold: 100,
    windowSeconds: 60,
  });
  const rowOf = async (cidr: string) =>
    ctx.db.select().from(schema.ipBan).where(eq(schema.ipBan.cidr, cidr));
  const releases = async (node: string, cluster: string, after: bigint, now = new Date()) =>
    (await banChanges(ctx.db, { id: node, clusterId: cluster }, after, 1000, now)).liftedOwn;
  const share = async (shareAutoBans: boolean) => {
    const settings = await admin.settings.bans();
    await admin.settings.setBans({ ...settings, shareAutoBans });
  };
  const scanSettings = (banSeconds: number) => ({
    unknownHost: "page" as const,
    ipAccess: "page" as const,
    defaultCertificate: false,
    scan: { enabled: true, threshold: 100, banSeconds },
  });

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterA = (await admin.clusters.list())[0]?.id ?? "";
    clusterB = (await admin.clusters.create({ name: "scan-b" })).id;
    await ctx.db
      .update(schema.cluster)
      .set({ unknownHosts: scanSettings(3600) })
      .where(eq(schema.cluster.id, clusterA));
    await ctx.db
      .update(schema.cluster)
      .set({ unknownHosts: scanSettings(600) })
      .where(eq(schema.cluster.id, clusterB));
    const rows = await ctx.db
      .insert(schema.node)
      .values([
        { clusterId: clusterA, name: "scan-a", supportedFeatures: ["unknown-host-v1"] },
        { clusterId: clusterA, name: "scan-a2", supportedFeatures: ["unknown-host-v1"] },
        { clusterId: clusterB, name: "scan-b", supportedFeatures: ["unknown-host-v1"] },
        // A release from before scan protection (v0.2.x).
        { clusterId: clusterA, name: "scan-old", supportedFeatures: ["bans-v1"] },
      ])
      .returning();
    [nodes.a, nodes.a2, nodes.b, nodes.old] = rows.map((row) => row.id) as [
      string,
      string,
      string,
      string,
    ];
    await ctx.db.insert(schema.nodeIp).values([
      { nodeId: nodes.a2, address: "198.51.100.88" },
      { nodeId: nodes.b, address: "198.51.100.77" },
    ]);
  });
  afterAll(() => pglite.close());

  it("releases a lifted unshared scan ban on capable nodes only, guarded by each cluster's ban time", async () => {
    await share(false);
    expect(
      await reportAutoBans(ctx.db, { id: nodes.a, clusterId: clusterA }, [scan("203.0.113.5")]),
    ).toBe(1);
    const [row] = await rowOf("203.0.113.5/32");
    expect(row).toMatchObject({ distributed: false, nodeId: nodes.a });
    const before = await currentBanSequence(ctx.db);
    await deleteBan(ctx.db, row?.id ?? "", { actor });
    const [lifted] = await rowOf("203.0.113.5/32");
    const removedAt = lifted?.removedAt?.getTime() ?? 0;
    const expiresAt = lifted?.expiresAt.getTime() ?? 0;
    expect(removedAt).toBeGreaterThan(0);

    // The reporting node: its own ban expires with the row (before the lift plus an hour).
    const own = await releases(nodes.a, clusterA, before);
    expect(own.map((b) => [b.cidr, b.expiresAt.getTime()])).toEqual([
      ["203.0.113.5/32", Math.min(expiresAt, removedAt + HOUR)],
    ]);
    // A node of a cluster banning for 10 minutes: an own ban of the address
    // made after the lift expires later than the lift plus 10 minutes, and stays.
    const short = await releases(nodes.b, clusterB, before);
    expect(short.map((b) => [b.cidr, b.expiresAt.getTime()])).toEqual([
      ["203.0.113.5/32", removedAt + 600_000],
    ]);
    expect(removedAt + 600_000).toBeLessThan(expiresAt);
    // Once that guard has passed, its pre-lift bans are gone: nothing to send.
    expect(await releases(nodes.b, clusterB, before, new Date(removedAt + 600_001))).toEqual([]);
    expect(
      (await releases(nodes.a, clusterA, before, new Date(removedAt + 600_001))).map((b) => b.cidr),
    ).toEqual(["203.0.113.5/32"]);
    // A node without scan protection holds no platform bans of its own and refuses such rows.
    expect(await releases(nodes.old, clusterA, before)).toEqual([]);
  });

  it("keeps a scan ban covering another cluster's proxy or node to the reporting node, listed and liftable", async () => {
    await share(true);
    await admin.clusters.setClientIp({
      clusterId: clusterB,
      settings: { mode: "header", trustedCidrs: ["192.0.2.0/24"], header: "x-forwarded-for" },
    });
    const before = await currentBanSequence(ctx.db);
    expect(
      await reportAutoBans(ctx.db, { id: nodes.a, clusterId: clusterA }, [
        scan("192.0.2.9"),
        scan("198.51.100.77"),
        scan("203.0.113.6"),
      ]),
    ).toBe(3);
    // Not shared: no other node gets them, unlike the unprotected one.
    for (const [node, cluster] of [
      [nodes.b, clusterB],
      [nodes.a2, clusterA],
    ] as const) {
      const page = await banChanges(ctx.db, { id: node, clusterId: cluster }, before, 1000);
      expect(page.bans.map((b) => b.cidr)).toEqual(["203.0.113.6/32"]);
    }
    const listed = await listBans(ctx.db, { scope: "platform", page: 1, pageSize: 50 });
    const proxy = listed.items.find((b) => b.cidr === "192.0.2.9/32");
    const node = listed.items.find((b) => b.cidr === "198.51.100.77/32");
    expect(proxy).toMatchObject({ distributed: false, source: "auto", node: { id: nodes.a } });
    expect(node).toMatchObject({ distributed: false, source: "auto" });
    // Lifting it releases it on the node that holds it.
    const beforeLift = await currentBanSequence(ctx.db);
    await deleteBan(ctx.db, proxy?.id ?? "", { actor });
    expect((await releases(nodes.a, clusterA, beforeLift)).map((b) => b.cidr)).toEqual([
      "192.0.2.9/32",
    ]);
    // A shared ban is not extended over a range another cluster protects meanwhile.
    const [shared] = await rowOf("203.0.113.6/32");
    expect(shared?.distributed).toBe(true);
    await admin.clusters.setClientIp({
      clusterId: clusterB,
      settings: {
        mode: "header",
        trustedCidrs: ["192.0.2.0/24", "203.0.113.0/24"],
        header: "x-forwarded-for",
      },
    });
    await reportAutoBans(ctx.db, { id: nodes.a, clusterId: clusterA }, [
      scan("203.0.113.6", new Date(Date.now() + 2 * HOUR)),
    ]);
    const [unchanged] = await rowOf("203.0.113.6/32");
    expect(unchanged?.expiresAt.getTime()).toBe(shared?.expiresAt.getTime());
  });

  it("lifts a scan ban covering an address the reporting node must not ban, once per address", async () => {
    await share(true);
    await admin.ipLists.create({ name: "scan_allow", kind: "allow", entries: ["198.18.0.0/15"] });
    const before = await currentBanSequence(ctx.db);
    // An allow list and a node of the reporting node's own cluster.
    expect(
      await reportAutoBans(ctx.db, { id: nodes.a, clusterId: clusterA }, [
        scan("198.18.3.4"),
        scan("198.51.100.88"),
      ]),
    ).toBe(0);
    const stored = await ctx.db
      .select()
      .from(schema.ipBan)
      .where(and(eq(schema.ipBan.scope, "platform"), eq(schema.ipBan.cidr, "198.18.3.4/32")));
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ distributed: false, source: "auto", nodeId: nodes.a });
    expect(stored[0]?.removedAt).not.toBeNull();
    const listed = await listBans(ctx.db, { scope: "platform", page: 1, pageSize: 50 });
    expect(listed.items.map((b) => b.cidr)).not.toContain("198.18.3.4/32");
    expect((await releases(nodes.a, clusterA, before)).map((b) => b.cidr).sort()).toEqual([
      "198.18.3.4/32",
      "198.51.100.88/32",
    ]);
    // Banned again: the same row goes out again, lifted later.
    const again = await currentBanSequence(ctx.db);
    await reportAutoBans(ctx.db, { id: nodes.a, clusterId: clusterA }, [
      scan("198.18.3.4", new Date(Date.now() + 2 * HOUR)),
    ]);
    const rows = await rowOf("198.18.3.4/32");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(stored[0]?.id);
    expect(rows[0]?.seq).toBeGreaterThan(stored[0]?.seq ?? 0n);
    expect((await releases(nodes.a, clusterA, again)).map((b) => b.cidr)).toEqual([
      "198.18.3.4/32",
    ]);
    // The other nodes of the cluster must not ban it either; another cluster's nodes may.
    expect((await releases(nodes.a2, clusterA, again)).map((b) => b.cidr)).toEqual([
      "198.18.3.4/32",
    ]);
    expect(await releases(nodes.b, clusterB, again)).toEqual([]);
  });

  it("leaves another cluster's ban of an address lifted for the reporting node's cluster", async () => {
    await share(true);
    await ctx.db.insert(schema.nodeIp).values({ nodeId: nodes.a2, address: "198.51.100.99" });
    // For cluster B only another cluster's node: kept to node b, listed.
    expect(
      await reportAutoBans(ctx.db, { id: nodes.b, clusterId: clusterB }, [scan("198.51.100.99")]),
    ).toBe(1);
    const before = await currentBanSequence(ctx.db);
    // For cluster A a node of its own: lifted at once for cluster A.
    expect(
      await reportAutoBans(ctx.db, { id: nodes.a, clusterId: clusterA }, [scan("198.51.100.99")]),
    ).toBe(0);
    expect((await releases(nodes.a, clusterA, before)).map((b) => b.cidr)).toEqual([
      "198.51.100.99/32",
    ]);
    // Node b keeps its ban, which stays listed.
    expect(await releases(nodes.b, clusterB, before)).toEqual([]);
    const listed = await listBans(ctx.db, { scope: "platform", page: 1, pageSize: 50 });
    expect(listed.items.find((b) => b.cidr === "198.51.100.99/32")).toMatchObject({
      distributed: false,
      node: { id: nodes.b },
    });
    // Lifting it in the console releases it on every capable node again.
    const beforeLift = await currentBanSequence(ctx.db);
    const id = listed.items.find((b) => b.cidr === "198.51.100.99/32")?.id ?? "";
    await deleteBan(ctx.db, id, { actor });
    expect((await releases(nodes.b, clusterB, beforeLift)).map((b) => b.cidr)).toEqual([
      "198.51.100.99/32",
    ]);
  });

  it("guards a release with the longest scan ban time the node's cluster has had", async () => {
    await share(false);
    const long = (await admin.clusters.create({ name: "scan-long" })).id;
    const short = (await admin.clusters.create({ name: "scan-short" })).id;
    const [nodeLong, nodeShort] = (
      await ctx.db
        .insert(schema.node)
        .values([
          { clusterId: long, name: "scan-long", supportedFeatures: ["unknown-host-v1"] },
          { clusterId: short, name: "scan-short", supportedFeatures: ["unknown-host-v1"] },
        ])
        .returning()
    ).map((row) => row.id) as [string, string];
    const scanOn = (banSeconds: number) => ({
      scan: { enabled: true, threshold: 100, banSeconds },
    });
    await admin.clusters.setUnknownHosts({ clusterId: long, settings: scanOn(86_400) });
    // Turned on with 10 minutes: the default it replaced never banned anything.
    await admin.clusters.setUnknownHosts({ clusterId: short, settings: scanOn(600) });
    const t0 = Date.now();
    expect(
      await reportAutoBans(ctx.db, { id: nodeLong, clusterId: long }, [
        scan("203.0.113.40", new Date(t0 + 86_400_000), new Date(t0)),
      ]),
    ).toBe(1);
    // The ban time is shortened before the unban: the node's ban keeps its day.
    await admin.clusters.setUnknownHosts({ clusterId: long, settings: scanOn(600) });
    const [row] = await rowOf("203.0.113.40/32");
    const before = await currentBanSequence(ctx.db);
    await deleteBan(ctx.db, row?.id ?? "", { actor });
    const [lifted] = await rowOf("203.0.113.40/32");
    const removedAt = lifted?.removedAt?.getTime() ?? 0;
    const own = await releases(nodeLong, long, before);
    expect(own.map((b) => b.expiresAt.getTime())).toEqual([row?.expiresAt.getTime()]);
    expect(own[0]?.expiresAt.getTime()).toBeGreaterThanOrEqual(t0 + 86_400_000);
    // A cluster that only ever banned for 10 minutes keeps its later bans.
    expect((await releases(nodeShort, short, before)).map((b) => b.expiresAt.getTime())).toEqual([
      removedAt + 600_000,
    ]);
  });

  it("takes over an active scan ban as a manual ban that reaches every node", async () => {
    await share(true);
    await admin.clusters.setClientIp({
      clusterId: clusterB,
      settings: {
        mode: "header",
        trustedCidrs: ["192.0.2.0/24", "203.0.113.0/24"],
        header: "x-forwarded-for",
      },
    });
    // Cluster B's proxy: kept to node a, not shared.
    expect(
      await reportAutoBans(ctx.db, { id: nodes.a, clusterId: clusterA }, [scan("192.0.2.19")]),
    ).toBe(1);
    const [auto] = await rowOf("192.0.2.19/32");
    expect(auto).toMatchObject({ source: "auto", distributed: false, nodeId: nodes.a });
    const before = await currentBanSequence(ctx.db);
    const start = Date.now();
    const manual = await admin.bans.create({
      scope: "platform",
      cidr: "192.0.2.19",
      reason: "abuse",
      durationSeconds: 86_400,
    });
    // The entry becomes a manual ban as a new one would be: no trusted proxy holds that back.
    expect(manual).toMatchObject({
      id: auto?.id,
      scope: "platform",
      cidr: "192.0.2.19/32",
      reason: "abuse",
      source: "manual",
      node: null,
      trigger: null,
      createdBy: { type: "user", name: "Platform Admin" },
      distributed: true,
    });
    expect(Date.parse(manual.createdAt)).toBeGreaterThanOrEqual(start);
    expect(Date.parse(manual.expiresAt) - Date.parse(manual.createdAt)).toBe(86_400_000);
    for (const [node, cluster] of [
      [nodes.a, clusterA],
      [nodes.a2, clusterA],
      [nodes.b, clusterB],
    ] as const) {
      const page = await banChanges(ctx.db, { id: node, clusterId: cluster }, before, 1000);
      expect(page.bans.map((b) => [b.id, b.source])).toEqual([[manual.id, "manual"]]);
    }
    const audit = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, manual.id));
    expect(audit.map((a) => a.action)).toEqual(["ban.create"]);
    expect(audit[0]?.metadata).toMatchObject({
      scope: "platform",
      cidr: "192.0.2.19/32",
      reason: "abuse",
    });

    // Later scan reports leave it alone: a later expiry, and one lifted for the reporting cluster.
    const [held] = await rowOf("192.0.2.19/32");
    const later = new Date(Date.now() + 2 * 86_400_000);
    expect(
      await reportAutoBans(ctx.db, { id: nodes.a, clusterId: clusterA }, [
        scan("192.0.2.19", later),
      ]),
    ).toBe(1);
    await ctx.db.insert(schema.nodeIp).values({ nodeId: nodes.a2, address: "192.0.2.19" });
    expect(
      await reportAutoBans(ctx.db, { id: nodes.a, clusterId: clusterA }, [
        scan("192.0.2.19", later),
      ]),
    ).toBe(0);
    await ctx.db
      .delete(schema.nodeIp)
      .where(and(eq(schema.nodeIp.nodeId, nodes.a2), eq(schema.nodeIp.address, "192.0.2.19")));
    const rows = await rowOf("192.0.2.19/32");
    expect(rows.find((row) => row.id === manual.id)).toEqual(held);
    const others = rows.filter((row) => row.id !== manual.id);
    expect(others).toMatchObject([{ source: "auto", clusterId: clusterA, distributed: false }]);
    expect(others[0]?.removedAt).not.toBeNull();
    expect(
      (await listBans(ctx.db, { scope: "platform", page: 1, pageSize: 50 })).items.find(
        (b) => b.cidr === "192.0.2.19/32",
      ),
    ).toMatchObject({ id: manual.id, source: "manual", distributed: true });

    // Lifted like any manual ban: every node drops it.
    const beforeLift = await currentBanSequence(ctx.db);
    await deleteBan(ctx.db, manual.id, { actor });
    const page = await banChanges(ctx.db, { id: nodes.b, clusterId: clusterB }, beforeLift, 1000);
    expect(page.removedIds).toEqual([manual.id]);
  });

  it("takes over a scan ban only where a new manual ban may go", async () => {
    await share(true);
    // Another cluster's node: a manual ban of it is refused, and so is the takeover.
    await ctx.db.insert(schema.nodeIp).values({ nodeId: nodes.b, address: "198.51.100.79" });
    expect(
      await reportAutoBans(ctx.db, { id: nodes.a, clusterId: clusterA }, [scan("198.51.100.79")]),
    ).toBe(1);
    const [node] = await rowOf("198.51.100.79/32");
    expect(node).toMatchObject({ source: "auto", distributed: false });
    expect(
      await rpcError(
        admin.bans.create({
          scope: "platform",
          cidr: "198.51.100.79",
          reason: "abuse",
          durationSeconds: 3600,
        }),
      ),
    ).toMatchObject({ code: "BAN_PROTECTED_ADDRESS", data: { address: "198.51.100.79" } });
    expect(await rowOf("198.51.100.79/32")).toEqual([node]);

    // At the limit of manual bans, as a new ban.
    expect(
      await reportAutoBans(ctx.db, { id: nodes.a, clusterId: clusterA }, [scan("192.0.2.29")]),
    ).toBe(1);
    const [auto] = await rowOf("192.0.2.29/32");
    await admin.settings.setBans({ maxTotal: 100, shareAutoBans: true });
    const { total } = await listBans(ctx.db, { source: "manual", page: 1, pageSize: 1 });
    const filler = await ctx.db
      .insert(schema.ipBan)
      .values(
        Array.from({ length: 100 - total }, (_, i) => ({
          scope: "platform",
          cidr: `10.77.${Math.floor(i / 250)}.${i % 250}/32`,
          reason: "abuse",
          source: "manual",
          expiresAt: new Date(Date.now() + HOUR),
          seq: sql`nextval('ip_ban_seq')`,
        })),
      )
      .returning({ id: schema.ipBan.id });
    expect(
      await rpcError(
        admin.bans.create({
          scope: "platform",
          cidr: "192.0.2.29",
          reason: "abuse",
          durationSeconds: 3600,
        }),
      ),
    ).toMatchObject({ code: "BAN_PLATFORM_LIMIT", data: { limit: 100 } });
    expect(await rowOf("192.0.2.29/32")).toEqual([auto]);
    await ctx.db
      .update(schema.ipBan)
      .set({ removedAt: new Date() })
      .where(
        inArray(
          schema.ipBan.id,
          filler.map((row) => row.id),
        ),
      );
    await admin.settings.setBans({ maxTotal: 10000, shareAutoBans: true });

    // An expired automatic entry banned again starts over as a manual ban.
    await ctx.db
      .update(schema.ipBan)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.ipBan.id, auto?.id ?? ""));
    const before = await currentBanSequence(ctx.db);
    const again = await admin.bans.create({
      scope: "platform",
      cidr: "192.0.2.29",
      reason: "spam",
      durationSeconds: 3600,
    });
    expect(again).toMatchObject({
      id: auto?.id,
      source: "manual",
      reason: "spam",
      node: null,
      trigger: null,
      distributed: true,
    });
    const page = await banChanges(ctx.db, { id: nodes.b, clusterId: clusterB }, before, 1000);
    expect(page.bans.map((b) => b.id)).toEqual([again.id]);
    await deleteBan(ctx.db, again.id, { actor });
  });
});
