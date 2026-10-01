import "reflect-metadata";
import { webcrypto } from "node:crypto";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { siteCreateInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { ApplyState, BanScope, BanSource, NodeService, WatchEvent } from "@edgeweir/proto";
import * as x509 from "@peculiar/x509";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type NodeChannel, startNodeChannel } from "../../src/server/node-channel/server";
import {
  createBan,
  currentBanSequence,
  deleteBan,
  listBans,
  setBanSettings,
} from "../../src/server/services/bans";
import { createClusterTx } from "../../src/server/services/clusters";
import { createEnrollmentToken } from "../../src/server/services/enrollment";
import { createSite } from "../../src/server/services/sites";
import { createTestContext, seedOrganization } from "./helpers";

const actor = { type: "user" as const, id: "user_admin", name: "Admin" };
const admin = { scope: { all: true } as const, actor };
const HOUR = 3600;

async function nodeKeyAndCsr() {
  const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const keys = (await webcrypto.subtle.generateKey(alg, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: "CN=edge-host",
    keys: keys as never,
    signingAlgorithm: alg,
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey));
  const keyPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString("base64")}\n-----END PRIVATE KEY-----\n`;
  return { csrPem: csr.toString("pem"), keyPem };
}

describe("dynamic ban channel", async () => {
  const { ctx, client: pglite } = await createTestContext();
  let channel: NodeChannel;
  let baseUrl: string;
  let clusterId: string;
  let otherClusterId: string;
  let organizationId: string;
  let siteId: string;
  let secondSiteId: string;
  let foreignSiteId: string;

  const enroll = async (clusterOf: string, nodeName: string, supportedFeatures: string[]) => {
    const token = await createEnrollmentToken(
      ctx.db,
      { clusterId: clusterOf, nodeName, ttlMinutes: 10 },
      {
        actor,
        consoleUrl: ctx.env.EDGEWEIR_PUBLIC_URL,
        serverUrl: ctx.env.nodeApiUrl,
        caSha256: ctx.nodeCa.fingerprintSha256,
      },
    );
    const { csrPem, keyPem } = await nodeKeyAndCsr();
    const anonymous = createClient(
      NodeService,
      createConnectTransport({
        baseUrl,
        httpVersion: "2",
        nodeOptions: { ca: ctx.nodeCa.certificatePem, servername: "localhost" },
      }),
    );
    const enrolled = await anonymous.enroll({
      token: token.token,
      csrPem,
      info: { hostname: nodeName, agentVersion: "test", supportedFeatures },
    });
    const mtls = createClient(
      NodeService,
      createConnectTransport({
        baseUrl,
        httpVersion: "2",
        nodeOptions: {
          ca: enrolled.caCertificatePem,
          cert: enrolled.certificatePem,
          key: keyPem,
          servername: "localhost",
        },
      }),
    );
    return { nodeId: enrolled.nodeId, mtls };
  };
  const site = async (name: string, cluster?: string) =>
    (
      await createSite(
        ctx.db,
        siteCreateInput.parse({
          name,
          clusterId: cluster,
          domains: [`${name}.test`],
          origins: [{ address: "origin.test" }],
        }),
        { organizationId, actor, masterKey: ctx.masterKey },
      )
    ).site.id;
  const siteBan = (cidr: string, target = siteId, durationSeconds = HOUR) =>
    createBan(
      ctx.db,
      { scope: "site", siteId: target, cidr, reason: "abuse", durationSeconds },
      admin,
    );
  const autoBan = (cidr: string, target: string, minutes = 10) => ({
    siteId: target,
    cidr,
    createdAt: timestampFromDate(new Date()),
    expiresAt: timestampFromDate(new Date(Date.now() + minutes * 60_000)),
    reason: "cc_ip_rate",
    metric: "ip_qps",
    observed: 250,
    threshold: 100,
    windowSeconds: 10,
  });
  const liftAll = () =>
    ctx.db
      .update(schema.ipBan)
      .set({ removedAt: new Date() })
      .where(isNull(schema.ipBan.removedAt));

  beforeAll(async () => {
    ({ organizationId } = await seedOrganization(ctx.db));
    clusterId = (
      await ctx.db.transaction((tx) =>
        createClusterTx(tx, { name: "default", description: "" }, actor),
      )
    ).id;
    otherClusterId = (
      await ctx.db.transaction((tx) =>
        createClusterTx(tx, { name: "other", description: "" }, actor),
      )
    ).id;
    channel = await startNodeChannel(ctx);
    const address = channel.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    baseUrl = `https://localhost:${address.port}`;
    siteId = await site("banned");
    secondSiteId = await site("second");
    foreignSiteId = await site("foreign", otherClusterId);
  });

  afterAll(async () => {
    await channel.close();
    await pglite.close();
  });

  it("starts with a snapshot of the cluster's active bans and pages by sequence", async () => {
    const { mtls } = await enroll(clusterId, "edge-snapshot", ["bans-v1"]);
    const empty = await mtls.getBans({ afterSequence: 0n });
    expect(empty).toMatchObject({ reset: true, bans: [], removedIds: [], more: false });
    expect(empty.sequence).toBe(await currentBanSequence(ctx.db));

    const a = await siteBan("192.0.2.1");
    const platform = await createBan(
      ctx.db,
      { scope: "platform", cidr: "203.0.113.0/24", reason: "attack", durationSeconds: HOUR },
      admin,
    );
    const b = await siteBan("2001:db8::7", secondSiteId);
    const foreign = await siteBan("192.0.2.3", foreignSiteId);
    const lifted = await siteBan("192.0.2.4");
    await deleteBan(ctx.db, lifted.id, { platform: true, ...admin });
    const expired = await siteBan("192.0.2.5");
    await ctx.db
      .update(schema.ipBan)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.ipBan.id, expired.id));
    const current = await currentBanSequence(ctx.db);

    const snapshot = await mtls.getBans({ afterSequence: 0n });
    expect(snapshot.reset).toBe(true);
    expect(snapshot.more).toBe(false);
    expect(snapshot.removedIds).toEqual([]);
    expect(snapshot.sequence).toBe(current);
    expect(snapshot.bans.map((ban) => ban.id)).toEqual([a.id, platform.id, b.id]);
    expect(snapshot.bans.map((ban) => ban.id)).not.toContain(foreign.id);
    const [first, second, third] = snapshot.bans;
    expect(first).toMatchObject({
      cidr: "192.0.2.1/32",
      scope: BanScope.SITE,
      siteId,
      source: BanSource.MANUAL,
      reason: "abuse",
    });
    expect(first?.expiresAt && timestampDate(first.expiresAt).toISOString()).toBe(a.expiresAt);
    expect(first?.createdAt && timestampDate(first.createdAt).toISOString()).toBe(a.createdAt);
    expect(second).toMatchObject({ scope: BanScope.PLATFORM, siteId: "", reason: "attack" });
    expect(third?.cidr).toBe("2001:db8::7/128");

    // Pages end at the last sequence they hold; the last page ends at the current value.
    const page1 = await mtls.getBans({ afterSequence: 0n, limit: 2 });
    expect(page1).toMatchObject({ reset: true, more: true });
    expect(page1.bans.map((ban) => ban.id)).toEqual([a.id, platform.id]);
    expect(page1.sequence).toBe(BigInt(platform.seq));
    const page2 = await mtls.getBans({ afterSequence: page1.sequence, limit: 2 });
    expect(page2.reset).toBe(false);
    // The lifted ban was never in this node's snapshot; its removal is harmless.
    expect(page2.bans.map((ban) => ban.id)).toEqual([b.id]);
    expect(page2.removedIds).toEqual([lifted.id]);
    expect(page2.more).toBe(false);
    expect(page2.sequence).toBe(current);

    // The console caps the page size.
    await ctx.db.execute(sql`
      insert into ip_ban (scope, organization_id, site_id, cluster_id, cidr, reason, source,
        expires_at, seq)
      select 'site', ${organizationId}, ${siteId}::uuid, ${clusterId}::uuid,
        '10.' || (i / 256) || '.' || (i % 256) || '.1/32', 'abuse', 'manual',
        now() + interval '1 hour', nextval('ip_ban_seq')
      from generate_series(0, 5000) as i`);
    const capped = await mtls.getBans({ afterSequence: 0n, limit: 100000 });
    expect(capped.bans).toHaveLength(5000);
    expect(capped.more).toBe(true);
    const byDefault = await mtls.getBans({ afterSequence: 0n });
    expect(byDefault.bans).toHaveLength(2000);
    expect(byDefault.more).toBe(true);
    const [last] = await ctx.db
      .select({ seq: schema.ipBan.seq })
      .from(schema.ipBan)
      .where(eq(schema.ipBan.id, byDefault.bans.at(-1)?.id ?? ""));
    expect(byDefault.sequence).toBe(last?.seq);
    await liftAll();
  });

  it("returns the changes after a sequence: active bans, lifted ids, no expired bans", async () => {
    const { mtls } = await enroll(clusterId, "edge-changes", ["bans-v1"]);
    const kept = await siteBan("198.51.100.1");
    const renewed = await siteBan("198.51.100.2");
    const doomed = await siteBan("198.51.100.3");
    const fading = await siteBan("198.51.100.4");
    const start = (await mtls.getBans({ afterSequence: 0n })).sequence;

    const added = await siteBan("198.51.100.5");
    const again = await createBan(
      ctx.db,
      {
        scope: "site",
        siteId,
        cidr: "198.51.100.2",
        reason: "scanner",
        durationSeconds: 2 * HOUR,
      },
      admin,
    );
    expect(again.id).toBe(renewed.id);
    await deleteBan(ctx.db, doomed.id, { platform: false, ...admin });
    // An entry that expires is left to the node's TTL.
    const bumped = await siteBan("198.51.100.4", siteId, 60);
    expect(bumped.id).toBe(fading.id);
    await ctx.db
      .update(schema.ipBan)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.ipBan.id, fading.id));
    // Changes of other clusters are invisible.
    await siteBan("198.51.100.6", foreignSiteId);
    const current = await currentBanSequence(ctx.db);

    const changes = await mtls.getBans({ afterSequence: start });
    expect(changes.reset).toBe(false);
    expect(changes.bans.map((ban) => ban.id)).toEqual([added.id, renewed.id]);
    expect(changes.bans.map((ban) => ban.id)).not.toContain(kept.id);
    expect(changes.bans[1]?.reason).toBe("scanner");
    expect(changes.removedIds).toEqual([doomed.id]);
    expect(changes.sequence).toBe(current);
    expect(changes.more).toBe(false);

    // Nothing visible changed: the node still moves to the current value.
    await siteBan("198.51.100.7", foreignSiteId);
    const quiet = await mtls.getBans({ afterSequence: current });
    expect(quiet).toMatchObject({ reset: false, bans: [], removedIds: [], more: false });
    expect(quiet.sequence).toBe(await currentBanSequence(ctx.db));
    await liftAll();
  });

  it("resets a node whose sequence is ahead of the console (restored database)", async () => {
    const { mtls } = await enroll(clusterId, "edge-restore", ["bans-v1"]);
    const ban = await siteBan("198.51.100.20");
    const current = await currentBanSequence(ctx.db);
    const ahead = await mtls.getBans({ afterSequence: current + 1000n });
    expect(ahead.reset).toBe(true);
    expect(ahead.bans.map((b) => b.id)).toEqual([ban.id]);
    expect(ahead.sequence).toBe(current);
    // A restore also rewinds the sequence itself.
    await ctx.db.execute(sql`select setval('ip_ban_seq', ${Number(current) - 1})`);
    const rewound = await mtls.getBans({ afterSequence: current });
    expect(rewound.reset).toBe(true);
    expect(rewound.sequence).toBe(current - 1n);
    await ctx.db.execute(sql`select setval('ip_ban_seq', ${Number(current)})`);
    await liftAll();
  });

  it("stores automatic bans idempotently and shares them in the cluster", async () => {
    const reporter = await enroll(clusterId, "edge-reporter", ["bans-v1"]);
    const peer = await enroll(clusterId, "edge-peer", ["bans-v1"]);
    const start = await currentBanSequence(ctx.db);
    const report = autoBan("198.51.100.30/32", siteId);
    expect((await reporter.mtls.reportBans({ bans: [report] })).accepted).toBe(1);
    const [row] = await ctx.db
      .select()
      .from(schema.ipBan)
      .where(and(eq(schema.ipBan.source, "auto"), eq(schema.ipBan.cidr, "198.51.100.30/32")));
    expect(row).toMatchObject({
      scope: "site",
      siteId,
      clusterId,
      organizationId,
      nodeId: reporter.nodeId,
      reason: "cc_ip_rate",
      distributed: true,
      trigger: { metric: "ip_qps", observed: 250, threshold: 100, windowSeconds: 10 },
    });

    // Retrying the same report changes nothing, not even the sequence.
    expect((await reporter.mtls.reportBans({ bans: [report] })).accepted).toBe(1);
    const [retried] = await ctx.db
      .select()
      .from(schema.ipBan)
      .where(eq(schema.ipBan.id, row?.id ?? ""));
    expect(retried?.seq).toBe(row?.seq);
    // A later expiry extends the entry; an earlier one never shortens it.
    const longer = autoBan("198.51.100.30", siteId, 30);
    expect((await reporter.mtls.reportBans({ bans: [longer] })).accepted).toBe(1);
    const shorter = autoBan("198.51.100.30", siteId, 5);
    await reporter.mtls.reportBans({ bans: [shorter] });
    const [extended] = await ctx.db
      .select()
      .from(schema.ipBan)
      .where(eq(schema.ipBan.id, row?.id ?? ""));
    expect(extended?.expiresAt.toISOString()).toBe(
      longer.expiresAt && timestampDate(longer.expiresAt).toISOString(),
    );
    expect(extended?.seq).toBeGreaterThan(row?.seq ?? 0n);
    expect(
      await ctx.db
        .select()
        .from(schema.ipBan)
        .where(and(eq(schema.ipBan.source, "auto"), eq(schema.ipBan.cidr, "198.51.100.30/32"))),
    ).toHaveLength(1);

    // Expiry is capped at seven days after creation.
    const week = autoBan("198.51.100.31", siteId, 30 * 24 * 60);
    await reporter.mtls.reportBans({ bans: [week] });
    const [capped] = await ctx.db
      .select()
      .from(schema.ipBan)
      .where(eq(schema.ipBan.cidr, "198.51.100.31/32"));
    expect(
      (capped?.expiresAt.getTime() ?? 0) - (capped?.createdAt.getTime() ?? 0),
    ).toBeLessThanOrEqual(7 * 24 * HOUR * 1000);

    // Other nodes of the cluster receive shared automatic bans.
    const shared = await peer.mtls.getBans({ afterSequence: start });
    expect(shared.bans.map((ban) => ban.cidr).sort()).toEqual([
      "198.51.100.30/32",
      "198.51.100.31/32",
    ]);
    expect(shared.bans[0]?.source).toBe(BanSource.AUTO);

    // Invalid reports are skipped: other cluster, prefixes, unknown reasons, expired, protected.
    const skipped = await reporter.mtls.reportBans({
      bans: [
        autoBan("198.51.100.40", foreignSiteId),
        autoBan("198.51.100.0/24", siteId),
        { ...autoBan("198.51.100.41", siteId), reason: "because" },
        autoBan("198.51.100.42", siteId, -1),
        { ...autoBan("198.51.100.43", siteId), expiresAt: undefined },
        autoBan("127.0.0.1", siteId),
        autoBan("not-an-ip", siteId),
        autoBan("198.51.100.44", "not-a-site"),
      ],
    });
    expect(skipped.accepted).toBe(0);
    await expect(
      reporter.mtls.reportBans({
        bans: Array.from({ length: 1001 }, (_, i) =>
          autoBan(`10.9.${Math.floor(i / 250)}.${i % 250}`, siteId),
        ),
      }),
    ).rejects.toMatchObject({ code: Code.InvalidArgument });

    // Without sharing, automatic bans are kept for viewing only.
    await setBanSettings(ctx.db, { maxTotal: 10000, shareAutoBans: false }, actor);
    const before = await currentBanSequence(ctx.db);
    await reporter.mtls.reportBans({ bans: [autoBan("198.51.100.50", siteId)] });
    const hidden = await peer.mtls.getBans({ afterSequence: before });
    expect(hidden.bans).toEqual([]);
    const listed = await listBans(
      ctx.db,
      { source: "auto", page: 1, pageSize: 50 },
      { platform: true, scope: { all: true } },
    );
    const local = listed.items.find((ban) => ban.cidr === "198.51.100.50/32");
    expect(local).toMatchObject({
      distributed: false,
      source: "auto",
      node: { id: reporter.nodeId, name: "edge-reporter" },
      trigger: { metric: "ip_qps", observed: 250, threshold: 100, windowSeconds: 10 },
      createdBy: null,
    });
    await setBanSettings(ctx.db, { maxTotal: 10000, shareAutoBans: true }, actor);

    // A tenant lifting an automatic ban tells the nodes.
    const beforeLift = await currentBanSequence(ctx.db);
    await deleteBan(ctx.db, row?.id ?? "", {
      platform: false,
      scope: { all: false, organizationId },
      actor,
    });
    const lift = await peer.mtls.getBans({ afterSequence: beforeLift });
    expect(lift.removedIds).toEqual([row?.id]);
    await liftAll();
  });

  it("keeps at most 10000 active automatic bans per cluster", async () => {
    const { nodeId, mtls } = await enroll(clusterId, "edge-flood", ["bans-v1"]);
    const created = new Date(Date.now() - 3_600_000);
    await ctx.db.execute(sql`
      insert into ip_ban (scope, organization_id, site_id, cluster_id, cidr, reason, source,
        node_id, created_at, expires_at, seq, distributed)
      select 'site', ${organizationId}, ${siteId}::uuid, ${clusterId}::uuid,
        '10.' || (i / 65536) || '.' || ((i / 256) % 256) || '.' || (i % 256) || '/32',
        'cc_ip_rate', 'auto', ${nodeId}::uuid,
        ${created.toISOString()}::timestamptz + make_interval(secs => i),
        now() + interval '1 hour', nextval('ip_ban_seq'), i >= 2
      from generate_series(0, 9999) as i`);
    const before = await currentBanSequence(ctx.db);
    const accepted = await mtls.reportBans({
      bans: [
        autoBan("198.51.100.60", siteId),
        autoBan("198.51.100.61", siteId),
        autoBan("198.51.100.62", siteId),
      ],
    });
    expect(accepted.accepted).toBe(3);
    const active = await ctx.db
      .select({ cidr: schema.ipBan.cidr, removedAt: schema.ipBan.removedAt })
      .from(schema.ipBan)
      .where(
        and(
          eq(schema.ipBan.clusterId, clusterId),
          eq(schema.ipBan.source, "auto"),
          isNull(schema.ipBan.removedAt),
        ),
      );
    expect(active).toHaveLength(10000);
    // The oldest go first: never-sent ones are deleted, sent ones are lifted.
    const oldest = await ctx.db
      .select({ cidr: schema.ipBan.cidr, removedAt: schema.ipBan.removedAt })
      .from(schema.ipBan)
      .where(
        and(
          eq(schema.ipBan.nodeId, nodeId),
          sql`${schema.ipBan.cidr} in ('10.0.0.0/32', '10.0.0.1/32', '10.0.0.2/32')`,
        ),
      );
    expect(oldest.map((row) => row.cidr)).toEqual(["10.0.0.2/32"]);
    expect(oldest[0]?.removedAt).not.toBeNull();
    const changes = await mtls.getBans({ afterSequence: before });
    expect(changes.removedIds).toHaveLength(1);
    expect(changes.bans.map((ban) => ban.cidr).sort()).toEqual([
      "198.51.100.60/32",
      "198.51.100.61/32",
      "198.51.100.62/32",
    ]);
    await ctx.db.delete(schema.ipBan).where(eq(schema.ipBan.nodeId, nodeId));
  });

  it("sends BANS watch events only to nodes with bans-v1", async () => {
    const modern = await enroll(clusterId, "edge-watch", ["bans-v1"]);
    const legacy = await enroll(clusterId, "edge-legacy", []);
    const abort = new AbortController();
    const stream = modern.mtls.watchConfig({ knownRevision: 0n }, { signal: abort.signal });
    const events = stream[Symbol.asyncIterator]();
    expect((await events.next()).value?.event).toBe(WatchEvent.REVISION);
    // Once when the stream opens, with the current sequence.
    const opened = (await events.next()).value;
    expect(opened?.event).toBe(WatchEvent.BANS);
    expect(opened?.banSequence).toBe(await currentBanSequence(ctx.db));

    await siteBan("198.51.100.70");
    ctx.events.emitBansLocal({ clusterIds: [clusterId] });
    const changed = (await events.next()).value;
    expect(changed?.event).toBe(WatchEvent.BANS);
    expect(changed?.banSequence).toBe(await currentBanSequence(ctx.db));
    // Platform bans concern every cluster.
    ctx.events.emitBansLocal({ clusterIds: null });
    expect((await events.next()).value?.event).toBe(WatchEvent.BANS);
    // Another cluster's bans do not wake this node.
    ctx.events.emitBansLocal({ clusterIds: [otherClusterId] });
    ctx.events.emitTasksLocal({ clusterIds: [clusterId] });
    expect((await events.next()).value?.event).toBe(WatchEvent.TASKS);
    abort.abort();

    const legacyAbort = new AbortController();
    const legacyEvents = legacy.mtls
      .watchConfig({ knownRevision: 0n }, { signal: legacyAbort.signal })
      [Symbol.asyncIterator]();
    expect((await legacyEvents.next()).value?.event).toBe(WatchEvent.REVISION);
    ctx.events.emitBansLocal({ clusterIds: null });
    ctx.events.emitBansLocal({ clusterIds: [clusterId] });
    ctx.events.emitTasksLocal({ clusterIds: [clusterId] });
    expect((await legacyEvents.next()).value?.event).toBe(WatchEvent.TASKS);
    legacyAbort.abort();
    await liftAll();
  });

  it("stores the BanStatus of every heartbeat on the node", async () => {
    const { nodeId, mtls } = await enroll(clusterId, "edge-status", ["bans-v1", "kernel-ban-v1"]);
    const ban = await siteBan("198.51.100.80");
    await mtls.reportStatus({
      appliedRevision: 0n,
      state: ApplyState.APPLIED,
      dataPlaneHealthy: true,
      bans: {
        appliedSequence: 42n,
        entries: 3,
        capacity: 100000,
        unappliedIds: [ban.id, "not-an-id", ban.id],
        unapplied: 2,
        kernelEntries: 1,
        autoEvicted: 7n,
      },
    });
    const [row] = await ctx.db.select().from(schema.node).where(eq(schema.node.id, nodeId));
    expect(row?.banStatus).toMatchObject({
      appliedSequence: "42",
      entries: 3,
      capacity: 100000,
      unappliedIds: [ban.id],
      unapplied: 2,
      kernelEntries: 1,
      autoEvicted: "7",
    });
    const listed = await listBans(
      ctx.db,
      { page: 1, pageSize: 50 },
      { platform: true, scope: { all: true } },
    );
    expect(listed.items.find((item) => item.id === ban.id)?.unappliedNodes).toBe(1);
    // A heartbeat without BanStatus (no bans-v1) clears it.
    await mtls.reportStatus({ appliedRevision: 0n, state: ApplyState.APPLIED });
    const [cleared] = await ctx.db.select().from(schema.node).where(eq(schema.node.id, nodeId));
    expect(cleared?.banStatus).toBeNull();
    await liftAll();
  });
});
