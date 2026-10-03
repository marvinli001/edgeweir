import { schema } from "@edgeweir/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import { systemActor } from "../../src/server/services/audit";
import { pruneDnsRevisions, reconcileDns } from "../../src/server/services/dns";
import { acquireLease, releaseLease } from "../../src/server/services/dns-lease";
import { latestRevision } from "../../src/server/services/revisions";
import { dnsFixture } from "./dns-fixture";
import { type ApiClient, createTestContext, rpcClient, setupPlatform, signIn } from "./helpers";

// When nodes enter and leave a cluster's DNS records around a publication,
// in which order records are replaced, and how many DNS revisions stay
// (audit 2026-10-01 P1-25, P1-28, P1-29).

vi.mock("../../src/server/services/certificate-worker", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/server/services/certificate-worker")>();
  const { makeFakeCertd } = await import("./dns-fixture");
  return { ...actual, runCertd: vi.fn(makeFakeCertd(actual.CertdError)) };
});

describe("DNS publication", async () => {
  const { ctx, client: db } = await createTestContext({
    EDGEWEIR_DNS_TEST_ENDPOINT: "http://fixture.invalid",
  });
  const app = createApp(ctx),
    origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId = "";
  let siteId = "";
  const nodes: string[] = [];

  const report = async (
    nodeId: string,
    revision: number,
    state: "applied" | "applying" | "failed" = "applied",
  ) => {
    const [row] = await ctx.db
      .select()
      .from(schema.configRevision)
      .where(
        and(
          eq(schema.configRevision.clusterId, clusterId),
          eq(schema.configRevision.revision, revision),
        ),
      );
    const values = {
      nodeId,
      appliedRevision: revision,
      appliedContentHash: row?.contentHash ?? "",
      state,
      dataPlaneHealthy: true,
    };
    await ctx.db
      .insert(schema.nodeConfigStatus)
      .values(values)
      .onConflictDoUpdate({ target: schema.nodeConfigStatus.nodeId, set: values });
    await ctx.db
      .update(schema.node)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.node.id, nodeId));
  };
  const latest = async () => (await latestRevision(ctx.db, clusterId))?.revision ?? 0;
  /** A node configuration change: a new revision. */
  const publish = async (name: string) => {
    await admin.sites.update({ id: siteId, name });
    return latest();
  };
  /** Published `minutes` ago. */
  const age = (revision: number, minutes: number) =>
    ctx.db
      .update(schema.configRevision)
      .set({ createdAt: new Date(Date.now() - minutes * 60_000) })
      .where(
        and(
          eq(schema.configRevision.clusterId, clusterId),
          eq(schema.configRevision.revision, revision),
        ),
      );
  const addresses = (type = "A") =>
    dnsFixture
      .records("token-p", "p.test")
      .filter((r) => r.name === "all.edge" && r.type === type)
      .map((r) => r.data)
      .sort();
  const blocked = async () => (await admin.dns.binding({ clusterId })).blocked;

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    dnsFixture.reset();
    dnsFixture.accounts.set("token-p", { zones: ["p.test"] });
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    const groupId = (await admin.nodeGroups.list({ clusterId }))[0]?.id ?? "";
    siteId = (
      await admin.sites.create({
        name: "shop",
        domains: ["shop.customer.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
    for (const [name, address] of [
      ["n1", "8.8.4.1"],
      ["n2", "8.8.4.2"],
    ] as const) {
      const [node] = await ctx.db
        .insert(schema.node)
        .values({ clusterId, nodeGroupId: groupId, name, lastSeenAt: new Date() })
        .returning();
      if (!node) throw new Error("node missing");
      await ctx.db.insert(schema.nodeIp).values({ nodeId: node.id, address });
      nodes.push(node.id);
      await report(node.id, await latest());
    }
    const providerId = (
      await admin.dns.createProvider({
        name: "Account",
        provider: "test",
        zone: "p.test",
        credentials: { api_token: "token-p" },
      })
    ).id;
    await admin.dns.saveBinding({
      clusterId,
      binding: {
        mode: "auto",
        providerId,
        domain: "edge.p.test",
        ttl: 60,
        lines: [{ name: "main", nodeGroupId: groupId, overrides: [] }],
      },
    });
    await reconcileDns(ctx);
  });
  afterAll(() => db.close());

  it("keeps nodes applying a new revision for 2 minutes, then removes those still behind", async () => {
    const [n1 = "", n2 = ""] = nodes;
    expect(addresses()).toEqual(["8.8.4.1", "8.8.4.2"]);
    // Both nodes are still on the previous revision when the next run comes.
    const second = await publish("shop-2");
    await reconcileDns(ctx);
    expect(addresses()).toEqual(["8.8.4.1", "8.8.4.2"]);
    expect(await blocked()).toBeNull();
    await report(n2, second, "applying");
    await reconcileDns(ctx);
    expect(addresses()).toEqual(["8.8.4.1", "8.8.4.2"]);

    // n1 applies it; n2 does not within 2 minutes and loses its records.
    await report(n1, second);
    await age(second, 3);
    await reconcileDns(ctx);
    expect(addresses()).toEqual(["8.8.4.1"]);
    await report(n2, second);
    await reconcileDns(ctx);
    expect(addresses()).toEqual(["8.8.4.1", "8.8.4.2"]);

    // A failed apply removes a node at once.
    const third = await publish("shop-3");
    await report(n2, third, "failed");
    await reconcileDns(ctx);
    expect(addresses()).toEqual(["8.8.4.1"]);

    // A node that was already behind gets no grace from the next publication.
    await report(n1, third);
    await report(n2, second);
    await age(third, 3);
    await publish("shop-4");
    await reconcileDns(ctx);
    expect(addresses()).toEqual(["8.8.4.1"]);
  });

  it("gives no grace to a node that never applied a revision", async () => {
    const [n1 = "", n2 = ""] = nodes;
    const current = await latest();
    await report(n1, current);
    await report(n2, current);
    await reconcileDns(ctx);
    expect(addresses()).toEqual(["8.8.4.1", "8.8.4.2"]);
    const [fresh] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        nodeGroupId: (await admin.nodeGroups.list({ clusterId }))[0]?.id ?? "",
        name: "n3",
        lastSeenAt: new Date(),
      })
      .returning();
    if (!fresh) throw new Error("node missing");
    await ctx.db.insert(schema.nodeIp).values({ nodeId: fresh.id, address: "8.8.4.3" });
    await ctx.db.insert(schema.nodeConfigStatus).values({
      nodeId: fresh.id,
      state: "applying",
      dataPlaneHealthy: true,
    });
    await reconcileDns(ctx);
    expect(addresses()).toEqual(["8.8.4.1", "8.8.4.2"]);
    await ctx.db.delete(schema.node).where(eq(schema.node.id, fresh.id));
  });

  it("repairs a cluster after the run in progress, which may have planned before the change", async () => {
    const [n1 = "", n2 = ""] = nodes;
    const current = await latest();
    await report(n1, current);
    await report(n2, current);
    await reconcileDns(ctx);
    expect(addresses()).toEqual(["8.8.4.1", "8.8.4.2"]);
    const key = `binding:${clusterId}`;
    /** Runs `fn` while another run (the worker's) holds the binding. */
    const busy = async (fn: (release: () => Promise<void>) => Promise<void>) => {
      const holder = await acquireLease(ctx.db, key, 60);
      if (!holder) throw new Error("lease taken");
      const release = () => releaseLease(ctx.db, key, holder);
      try {
        await fn(release);
      } finally {
        await release();
      }
    };
    try {
      // n2 goes offline while the other run holds the binding.
      await ctx.db
        .update(schema.node)
        .set({ lastSeenAt: new Date(Date.now() - 120_000) })
        .where(eq(schema.node.id, n2));
      await busy(async (release) => {
        let done = false;
        const repair = admin.dns.reconcile({ clusterId }).then(() => {
          done = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(done).toBe(false);
        expect(addresses()).toEqual(["8.8.4.1", "8.8.4.2"]);
        await release();
        await repair;
        expect(addresses()).toEqual(["8.8.4.1"]);
      });

      // A run that outlasts the wait is reported, not passed off as done.
      await report(n2, current);
      await busy(async () => {
        await expect(reconcileDns(ctx, systemActor, clusterId, 300)).rejects.toMatchObject({
          code: "DNS_RECONCILE_BUSY",
          status: 409,
        });
        expect(addresses()).toEqual(["8.8.4.1"]);
      });
    } finally {
      await report(n2, current);
    }
    await reconcileDns(ctx, systemActor, clusterId);
    expect(addresses()).toEqual(["8.8.4.1", "8.8.4.2"]);
  });

  it("writes new records before deleting those they replace", async () => {
    await admin.dns.setProtection({ massRemovalRatio: 1 });
    // Both nodes move to IPv6: the A sets give way to AAAA sets.
    for (const [index, nodeId] of nodes.entries())
      await ctx.db
        .update(schema.nodeIp)
        .set({ address: `2606:4700:4700::${index + 1}` })
        .where(eq(schema.nodeIp.nodeId, nodeId));
    const calls = dnsFixture.calls.length;
    await reconcileDns(ctx);
    expect(addresses()).toEqual([]);
    expect(addresses("AAAA")).toEqual(["2606:4700:4700::1", "2606:4700:4700::2"]);
    const writes = dnsFixture.calls.slice(calls);
    const touches = (command: string, type: string) =>
      writes.findIndex(
        (c) =>
          c.command === command && c.records?.some((r) => r.name === "all.edge" && r.type === type),
      );
    expect(touches("dns.set", "AAAA")).toBeGreaterThanOrEqual(0);
    expect(touches("dns.cleanup", "A")).toBeGreaterThan(touches("dns.set", "AAAA"));
    await admin.dns.setProtection({ massRemovalRatio: 0.5 });
  });

  it("keeps the newest DNS revisions of each binding, and the desired, applied and blocked ones", async () => {
    const binding = (await admin.dns.binding({ clusterId })).binding;
    const [row] = await ctx.db
      .select()
      .from(schema.dnsBinding)
      .where(eq(schema.dnsBinding.clusterId, clusterId));
    const kept = [row?.desiredRevision, row?.appliedRevision].filter(
      (r): r is number => typeof r === "number",
    );
    expect(kept.length).toBe(2);
    // Older revisions than the binding's own, so they rank below the newest two.
    await ctx.db
      .update(schema.dnsRevision)
      .set({ status: "superseded" })
      .where(
        and(eq(schema.dnsRevision.clusterId, clusterId), eq(schema.dnsRevision.status, "pending")),
      );
    const insert = async (status: string) =>
      (
        await ctx.db
          .insert(schema.dnsRevision)
          .values({ clusterId, policy: binding, contentHash: status, reason: "health", status })
          .returning()
      )[0]?.revision ?? 0;
    const blockedRevision = await insert("blocked");
    const newer = [await insert("superseded"), await insert("superseded")];
    const before = await ctx.db
      .select({ revision: schema.dnsRevision.revision })
      .from(schema.dnsRevision)
      .where(eq(schema.dnsRevision.clusterId, clusterId));
    const expected = [...new Set([...kept, blockedRevision, ...newer])].sort((x, y) => x - y);
    expect(before.length).toBeGreaterThan(expected.length);
    expect(await pruneDnsRevisions(ctx.db, 2)).toBe(before.length - expected.length);
    const after = await ctx.db
      .select({ revision: schema.dnsRevision.revision })
      .from(schema.dnsRevision)
      .where(eq(schema.dnsRevision.clusterId, clusterId))
      .orderBy(sql`${schema.dnsRevision.revision}`);
    expect(after.map((r) => r.revision)).toEqual(expected);
    expect(await pruneDnsRevisions(ctx.db)).toBe(0);
  });
});
