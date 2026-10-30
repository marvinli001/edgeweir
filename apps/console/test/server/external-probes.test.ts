import { createHmac } from "node:crypto";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import { reconcileDns } from "../../src/server/services/dns";
import {
  listProbeSources,
  pollProbeSources,
  recordObservations,
  sweepProbeSourceAlerts,
} from "../../src/server/services/external-probes";
import { ProbeSourceWebhooks } from "../../src/server/services/probe-source-webhook";
import type { Http, Observation } from "../../src/server/services/probe-sources/types";
import { type Prober, recordProbeResults } from "../../src/server/services/probes";
import { latestRevision } from "../../src/server/services/revisions";
import { addressFailing, evaluateScheduling } from "../../src/server/services/scheduling";
import { dnsFixture } from "./dns-fixture";
import { type ApiClient, createTestContext, rpcClient, setupPlatform, signIn } from "./helpers";

// External probe sources (ADR-0069): results of other monitoring services
// drive address reachability under the probe mode, with the same majority,
// hold and recovery as the probes; stale or failing sources never remove.

vi.mock("../../src/server/services/certificate-worker", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/server/services/certificate-worker")>();
  const { makeFakeCertd } = await import("./dns-fixture");
  return { ...actual, runCertd: vi.fn(makeFakeCertd(actual.CertdError)) };
});

const sign = (secret: string, timestamp: number, body: string) =>
  `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;

type ResultRow = Parameters<typeof addressFailing>[0][number];
const row = (kind: string, prober: string, lost: number): ResultRow => ({
  proberKind: kind,
  proberId: prober,
  regionId: null,
  nodeId: "n",
  address: "192.0.2.1",
  port: 0,
  method: "tcp",
  sent: 100,
  lost,
  rttMs: 10,
  error: "",
  checkedAt: new Date(),
});

describe("addressFailing", () => {
  const internalDown = [row("probe", "a", 100), row("probe", "b", 100), row("probe", "c", 0)];
  const externalDown = [row("external", "s:fra", 100), row("external", "s:sin", 100)];
  const externalUp = [row("external", "s:fra", 0), row("external", "s:sin", 0)];
  it("counts each kind by its own strict majority", () => {
    expect(addressFailing([...internalDown, ...externalUp], "internal", 50)).toBe(true);
    expect(addressFailing([...internalDown, ...externalUp], "any", 50)).toBe(true);
    expect(addressFailing([...internalDown, ...externalUp], "all", 50)).toBe(false);
    expect(addressFailing([...internalDown, ...externalDown], "all", 50)).toBe(true);
    // Half is not a majority.
    expect(
      addressFailing([row("external", "s:fra", 100), row("external", "s:sin", 0)], "any", 50),
    ).toBe(false);
  });
  it("never fails a kind without results", () => {
    expect(addressFailing([], "any", 50)).toBe(false);
    expect(addressFailing(internalDown, "all", 50)).toBe(false);
    expect(addressFailing(externalDown, "all", 50)).toBe(false);
  });
});

describe("external probe sources", async () => {
  const { ctx, client: db } = await createTestContext({
    EDGEWEIR_DNS_TEST_ENDPOINT: "http://fixture.invalid",
  });
  const app = createApp(ctx),
    origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId = "";
  let group = "";
  let region = "";
  const nodes: Record<string, string> = {};
  const probers: Prober[] = [];
  let now = new Date();
  const tick = (seconds: number) => {
    now = new Date(now.getTime() + seconds * 1000);
  };
  const nextHour = () => {
    now = new Date(Math.ceil((now.getTime() + 3_600_000) / 3_600_000) * 3_600_000);
  };
  const evaluate = () => evaluateScheduling(ctx, { now });
  const published = async () => (await admin.dns.binding({ clusterId })).records;
  const allEdge = async () =>
    (await published())
      .filter((r) => r.name === "all.edge" && r.type === "A" && !r.line)
      .map((r) => r.data)
      .sort();
  const revisions = () => admin.dns.bindingRevisions({ clusterId });
  const audits = (action: string) =>
    ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));

  const addNode = async (name: string, address: string) => {
    const [node] = await ctx.db
      .insert(schema.node)
      .values({ clusterId, nodeGroupId: group, name, lastSeenAt: new Date() })
      .returning();
    if (!node) throw new Error("node missing");
    await ctx.db.insert(schema.nodeIp).values({ nodeId: node.id, address });
    const revision = await latestRevision(ctx.db, clusterId);
    if (!revision) throw new Error("revision missing");
    await ctx.db.insert(schema.nodeConfigStatus).values({
      nodeId: node.id,
      appliedRevision: revision.revision,
      appliedContentHash: revision.contentHash,
      state: "applied",
      dataPlaneHealthy: true,
    });
    nodes[name] = node.id;
  };
  /** Observations of a monitor from locations: true up, false down. */
  const results = (monitorId: string, locations: Record<string, boolean>): Observation[] =>
    Object.entries(locations).map(([location, up]) => ({
      monitorId,
      location,
      up,
      rttMs: up ? 30 : null,
      lossPercent: null,
      error: up ? "" : "timeout",
      checkedAt: now,
    }));
  /** One round of every internal prober for x1: lost 0 or 4 of 4. */
  const probeRound = async (lost: number) => {
    for (const prober of probers)
      await recordProbeResults(
        ctx.db,
        prober,
        [
          {
            nodeId: nodes.x1 ?? "",
            address: "8.8.3.1",
            port: 80,
            sent: 4,
            lost,
            rttMs: 20,
            error: "",
          },
        ],
        now,
      );
  };

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    dnsFixture.reset();
    dnsFixture.accounts.set("token-x", { zones: ["x.test"] });
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    group = (await admin.nodeGroups.list({ clusterId }))[0]?.id ?? "";
    region = (await admin.regions.create({ name: "West", code: "west" })).id;
    await admin.sites.create({
      name: "ext",
      domains: ["ext.sched.test"],
      origins: [{ address: "origin.test" }],
    });
    await addNode("x1", "8.8.3.1");
    await addNode("x2", "8.8.3.2");
    await addNode("x3", "8.8.3.3");
    for (const name of ["q1", "q2", "q3"]) {
      const [p] = await ctx.db.insert(schema.probe).values({ name, regionId: region }).returning();
      if (!p) throw new Error("probe missing");
      probers.push({ kind: "probe", id: p.id, name, regionId: region });
    }
    const provider = await admin.dns.createProvider({
      name: "Ext",
      provider: "test",
      zone: "x.test",
      credentials: { api_token: "token-x" },
    });
    await admin.dns.saveBinding({
      clusterId,
      binding: { mode: "auto", providerId: provider.id, domain: "edge.x.test", ttl: 60, lines: [] },
    });
    await reconcileDns(ctx);
  });
  afterAll(() => db.close());

  it("never returns secrets and shows a made webhook secret once", async () => {
    const created = await admin.probeSources.create({ name: "hooks", provider: "generic_webhook" });
    expect(created.webhookSecret).toMatch(/^ewh_[A-Za-z0-9_-]{43}$/);
    expect(created.source.webhookUrl).toBe(
      `${origin}/api/hooks/probe-sources/${created.source.id}`,
    );
    expect(created.source.status).toBe("waiting");
    const listed = await admin.probeSources.list();
    expect(JSON.stringify(listed)).not.toContain(created.webhookSecret ?? "-");
    const [stored] = await ctx.db
      .select()
      .from(schema.externalProbeSource)
      .where(eq(schema.externalProbeSource.id, created.source.id));
    expect(stored?.webhookSecretEnvelope).not.toContain(created.webhookSecret ?? "-");
    const audit = (await audits("probe_source.create")).find(
      (a) => a.targetId === created.source.id,
    );
    expect(JSON.stringify(audit)).not.toContain(created.webhookSecret ?? "-");
    // A pull provider's key is sealed, listed by name only.
    const pull = await admin.probeSources.create({
      name: "robot",
      provider: "uptimerobot",
      fields: { api_key: "u1234567-abcdefghijklmnop" },
    });
    expect(pull.webhookSecret).toBeNull();
    expect(pull.source.secretsSet).toEqual(["api_key"]);
    expect(JSON.stringify(await admin.probeSources.list())).not.toContain("abcdefghijklmnop");
    // An update without the secret keeps it.
    const renamed = await admin.probeSources.update({
      id: pull.source.id,
      name: "robot 2",
      fields: {},
    });
    expect(renamed.secretsSet).toEqual(["api_key"]);
    await expect(
      admin.probeSources.create({ name: "bad", provider: "uptimerobot", fields: { nope: "x" } }),
    ).rejects.toMatchObject({ code: "PROBE_SOURCE_FIELD_INVALID", data: { field: "nope" } });
    await expect(
      admin.probeSources.create({
        name: "fast",
        provider: "uptimerobot",
        fields: { api_key: "u1234567-abcdefghijklmnop" },
        pollIntervalSeconds: 30,
      }),
    ).rejects.toMatchObject({ code: "PROBE_SOURCE_POLL_TOO_FAST" });
    await admin.probeSources.delete({ id: pull.source.id });
    await admin.probeSources.delete({ id: created.source.id });
  });

  it("validates mappings", async () => {
    const { source } = await admin.probeSources.create({
      name: "map",
      provider: "generic_webhook",
    });
    await expect(
      admin.probeSources.setMappings({
        id: source.id,
        mappings: [
          { monitorId: "a", nodeId: nodes.x1 ?? "" },
          { monitorId: "a", nodeId: nodes.x2 ?? "" },
        ],
      }),
    ).rejects.toMatchObject({ code: "PROBE_SOURCE_MAPPING_INVALID", data: { monitor: "a" } });
    await expect(
      admin.probeSources.setMappings({
        id: source.id,
        mappings: [{ monitorId: "a", nodeId: nodes.x1 ?? "", address: "8.8.3.2" }],
      }),
    ).rejects.toMatchObject({ code: "PROBE_SOURCE_MAPPING_INVALID" });
    const saved = await admin.probeSources.setMappings({
      id: source.id,
      mappings: [{ monitorId: "a", nodeId: nodes.x1 ?? "", address: "8.8.3.1" }],
    });
    expect(saved).toMatchObject([{ monitorId: "a", nodeName: "x1", address: "8.8.3.1" }]);
    await admin.probeSources.delete({ id: source.id });
  });

  it("verifies deliveries: signature, timestamp, replay, unknown and disabled sources", async () => {
    const { source, webhookSecret } = await admin.probeSources.create({
      name: "signed",
      provider: "generic_webhook",
    });
    const secret = webhookSecret ?? "";
    const url = `${origin}/api/hooks/probe-sources/${source.id}`;
    const post = (body: string, headers: Record<string, string>, to = url) =>
      app.request(to, {
        method: "POST",
        body,
        headers: { "content-type": "application/json", ...headers },
      });
    const body = JSON.stringify({
      results: [{ monitor: "m1", location: "fra", up: true, latencyMs: 12 }],
    });
    const ts = Math.floor(Date.now() / 1000);
    const ok = await post(body, {
      "x-edgeweir-timestamp": String(ts),
      "x-edgeweir-signature": sign(secret, ts, body),
    });
    expect(ok.status).toBe(202);
    expect(await ok.json()).toEqual({ code: "accepted", accepted: 1 });
    // The same delivery again.
    const replay = await post(body, {
      "x-edgeweir-timestamp": String(ts),
      "x-edgeweir-signature": sign(secret, ts, body),
    });
    expect(replay.status).toBe(409);
    const wrong = await post(body, {
      "x-edgeweir-timestamp": String(ts),
      "x-edgeweir-signature": sign("other-secret-0123456789", ts, body),
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ code: "signature_invalid" });
    const old = ts - 301;
    const late = await post(body, {
      "x-edgeweir-timestamp": String(old),
      "x-edgeweir-signature": sign(secret, old, body),
    });
    expect(late.status).toBe(401);
    expect(await late.json()).toEqual({ code: "timestamp_invalid" });
    const garbage = "{";
    const bad = await post(garbage, {
      "x-edgeweir-timestamp": String(ts + 1),
      "x-edgeweir-signature": sign(secret, ts + 1, garbage),
    });
    expect(bad.status).toBe(400);
    const unknown = await post(
      body,
      {},
      `${origin}/api/hooks/probe-sources/00000000-0000-4000-8000-000000000000`,
    );
    expect(unknown.status).toBe(404);
    const huge = "x".repeat(300 * 1024);
    expect((await post(huge, {})).status).toBe(413);
    await admin.probeSources.update({ id: source.id, enabled: false });
    expect(
      (
        await post(body, {
          "x-edgeweir-timestamp": String(ts + 2),
          "x-edgeweir-signature": sign(secret, ts + 2, body),
        })
      ).status,
    ).toBe(404);
    // The stored result (no secret in the URL, the source's state updated).
    const stored = await admin.probeSources.results({ id: source.id });
    expect(stored).toMatchObject([
      { monitorId: "m1", location: "fra", up: true, rttMs: 12, counted: false },
    ]);
    await admin.probeSources.delete({ id: source.id });
  });

  it("limits deliveries per client address and per source", async () => {
    const { source, webhookSecret } = await admin.probeSources.create({
      name: "limited",
      provider: "generic_webhook",
    });
    let clock = Date.now();
    const hooks = new ProbeSourceWebhooks(() => clock);
    const deliver = (n: number, ip: string) => {
      const body = JSON.stringify({ results: [{ monitor: `m${n}`, up: true }] });
      const ts = Math.floor(clock / 1000);
      return hooks.handle(ctx, source.id, {
        ip,
        body: Buffer.from(body),
        headers: new Headers({
          "x-edgeweir-timestamp": String(ts),
          "x-edgeweir-signature": sign(webhookSecret ?? "", ts, body),
        }),
      });
    };
    for (let i = 0; i < 300; i++)
      expect((await deliver(i, `198.51.100.${i % 50}`)).status).toBe(202);
    const limited = await deliver(300, "198.51.100.99");
    expect(limited).toMatchObject({ status: 429, code: "rate_limited" });
    clock += 61_000;
    expect((await deliver(301, "198.51.100.99")).status).toBe(202);
    // One address sending to anything (here: unknown ids) is limited before any lookup.
    for (let i = 0; i < 600; i++)
      await hooks.handle(ctx, "not-a-uuid", {
        ip: "203.0.113.7",
        body: Buffer.alloc(0),
        headers: new Headers(),
      });
    expect(
      await hooks.handle(ctx, source.id, {
        ip: "203.0.113.7",
        body: Buffer.alloc(0),
        headers: new Headers(),
      }),
    ).toMatchObject({ status: 429 });
    await admin.probeSources.delete({ id: source.id });
  });

  it("ignores results older than the stored ones", async () => {
    const { source } = await admin.probeSources.create({
      name: "order",
      provider: "generic_webhook",
    });
    const t = new Date();
    const at = (offset: number) => new Date(t.getTime() + offset * 1000);
    await recordObservations(
      ctx.db,
      source.id,
      [{ ...results("m", { "": false })[0], checkedAt: at(0) } as Observation],
      at(0),
      "webhook",
    );
    await recordObservations(
      ctx.db,
      source.id,
      [{ ...results("m", { "": true })[0], checkedAt: at(-60) } as Observation],
      at(1),
      "webhook",
    );
    expect((await admin.probeSources.results({ id: source.id }))[0]?.up).toBe(false);
    await recordObservations(
      ctx.db,
      source.id,
      [{ ...results("m", { "": true })[0], checkedAt: at(2) } as Observation],
      at(2),
      "webhook",
    );
    expect((await admin.probeSources.results({ id: source.id }))[0]?.up).toBe(true);
    await admin.probeSources.delete({ id: source.id });
  });

  it("drives a node unreachable and back by an external source alone (mode external)", async () => {
    nextHour();
    const { source } = await admin.probeSources.create({
      name: "ext-only",
      provider: "generic_webhook",
    });
    await admin.probeSources.setMappings({
      id: source.id,
      mappings: [{ monitorId: "x1-http", nodeId: nodes.x1 ?? "" }],
    });
    await admin.probeSources.setClusterMode({ clusterId, mode: "external" });
    const round = async (locations: Record<string, boolean>) => {
      await recordObservations(ctx.db, source.id, results("x1-http", locations), now, "webhook");
      // Internal probes see it fine: ignored in this mode.
      await probeRound(0);
      await evaluate();
    };
    expect(await allEdge()).toEqual(["8.8.3.1", "8.8.3.2", "8.8.3.3"]);
    // One location of three: no majority.
    await round({ fra: false, sin: true, iad: true });
    tick(40);
    await round({ fra: false, sin: true, iad: true });
    expect(await allEdge()).toContain("8.8.3.1");
    // Two of three: down after ipDownSeconds (30 s).
    tick(10);
    await round({ fra: false, sin: false, iad: true });
    tick(20);
    await round({ fra: false, sin: false, iad: true });
    expect(await allEdge()).toContain("8.8.3.1");
    tick(10);
    await round({ fra: false, sin: false, iad: true });
    expect(await allEdge()).toEqual(["8.8.3.2", "8.8.3.3"]);
    expect((await revisions())[0]).toMatchObject({ reason: "health" });
    expect((await admin.probeSources.list()).find((s) => s.id === source.id)).toMatchObject({
      status: "healthy",
      down: 1,
    });
    // Up again after ipUpSeconds (60 s).
    tick(10);
    await round({ fra: true, sin: true, iad: true });
    tick(50);
    await round({ fra: true, sin: true, iad: true });
    expect(await allEdge()).toEqual(["8.8.3.2", "8.8.3.3"]);
    tick(10);
    await round({ fra: true, sin: true, iad: true });
    expect(await allEdge()).toEqual(["8.8.3.1", "8.8.3.2", "8.8.3.3"]);
    await admin.probeSources.delete({ id: source.id });
    await admin.probeSources.setClusterMode({ clusterId, mode: null });
  });

  it("needs both kinds in mode all and either in mode any", async () => {
    nextHour();
    const { source } = await admin.probeSources.create({
      name: "both",
      provider: "generic_webhook",
    });
    await admin.probeSources.setMappings({
      id: source.id,
      mappings: [{ monitorId: "x1", nodeId: nodes.x1 ?? "", address: "8.8.3.1" }],
    });
    await admin.probeSources.setClusterMode({ clusterId, mode: "all" });
    const round = async (externalUp: boolean, internalLost: number) => {
      await recordObservations(
        ctx.db,
        source.id,
        results("x1", { a: externalUp, b: externalUp }),
        now,
        "webhook",
      );
      await probeRound(internalLost);
      await evaluate();
    };
    // External down, internal fine: not in mode all.
    await round(false, 0);
    tick(40);
    await round(false, 0);
    expect(await allEdge()).toContain("8.8.3.1");
    // Internal down, external fine: not either.
    tick(10);
    await round(true, 4);
    tick(40);
    await round(true, 4);
    expect(await allEdge()).toContain("8.8.3.1");
    // Both down.
    tick(10);
    await round(false, 4);
    tick(30);
    await round(false, 4);
    expect(await allEdge()).not.toContain("8.8.3.1");
    tick(10);
    await round(true, 0);
    tick(60);
    await round(true, 0);
    expect(await allEdge()).toContain("8.8.3.1");
    // Mode any: the external source alone is enough.
    await admin.probeSources.setClusterMode({ clusterId, mode: "any" });
    tick(10);
    await round(false, 0);
    tick(30);
    await round(false, 0);
    expect(await allEdge()).not.toContain("8.8.3.1");
    tick(10);
    await round(true, 0);
    tick(60);
    await round(true, 0);
    expect(await allEdge()).toContain("8.8.3.1");
    // The global mode applies to a cluster without its own.
    await admin.probeSources.setClusterMode({ clusterId, mode: null });
    expect((await admin.probeSources.modes()).global).toBe("internal");
    const settings = await admin.settings.probes();
    await admin.settings.setProbes({ ...settings, mode: "external" });
    expect(await admin.probeSources.modes()).toMatchObject({
      global: "external",
      clusters: [{ clusterId, mode: null }],
    });
    await admin.settings.setProbes({ ...settings, mode: "internal" });
    await admin.probeSources.delete({ id: source.id });
  });

  it("never removes by a stale or failing source, and alerts", async () => {
    nextHour();
    const { source } = await admin.probeSources.create({
      name: "goes stale",
      provider: "generic_webhook",
      staleAfterSeconds: 120,
    });
    await admin.probeSources.setMappings({
      id: source.id,
      mappings: [{ monitorId: "x2", nodeId: nodes.x2 ?? "" }],
    });
    await admin.probeSources.setClusterMode({ clusterId, mode: "external" });
    // The last delivery says down, then the source falls silent before
    // ipDownSeconds: its results stop counting, nothing is removed.
    await recordObservations(ctx.db, source.id, results("x2", { a: false }), now, "webhook");
    await evaluate();
    tick(121);
    await evaluate();
    tick(60);
    await evaluate();
    expect(await allEdge()).toContain("8.8.3.2");
    expect((await listProbeSources(ctx, now)).find((s) => s.id === source.id)?.status).toBe(
      "stale",
    );
    await sweepProbeSourceAlerts(ctx.db, now);
    const alertKey = `probe_source_stale/platform/${source.id}`;
    const alert = async () =>
      (await ctx.db.select().from(schema.alertState).where(eq(schema.alertState.key, alertKey)))[0]
        ?.active ?? false;
    expect(await alert()).toBe(true);
    // A delivery again: healthy, the alert resolves.
    await recordObservations(ctx.db, source.id, results("x2", { a: true }), now, "webhook");
    await sweepProbeSourceAlerts(ctx.db, now);
    expect(await alert()).toBe(false);
    // A failed poll stops a source at once, even while recent.
    await ctx.db
      .update(schema.externalProbeSource)
      .set({ lastErrorAt: new Date(now.getTime() + 1000), lastError: "auth_failed" })
      .where(eq(schema.externalProbeSource.id, source.id));
    expect((await admin.probeSources.list()).find((s) => s.id === source.id)).toMatchObject({
      status: "failing",
      lastError: "auth_failed",
    });
    await admin.probeSources.delete({ id: source.id });
    await admin.probeSources.setClusterMode({ clusterId, mode: null });
  });

  it("keeps the records when every node would go (mass removal protection)", async () => {
    nextHour();
    const { source } = await admin.probeSources.create({
      name: "all down",
      provider: "generic_webhook",
    });
    await admin.probeSources.setMappings({
      id: source.id,
      mappings: ["x1", "x2", "x3"].map((n) => ({ monitorId: n, nodeId: nodes[n] ?? "" })),
    });
    await admin.probeSources.setClusterMode({ clusterId, mode: "external" });
    const round = async () => {
      for (const n of ["x1", "x2", "x3"])
        await recordObservations(ctx.db, source.id, results(n, { a: false }), now, "webhook");
      await evaluate();
    };
    await round();
    tick(31);
    await round();
    expect((await allEdge()).length).toBeGreaterThan(0);
    expect((await admin.dns.binding({ clusterId })).blocked).toMatchObject({ status: "blocked" });
    await admin.probeSources.delete({ id: source.id });
    await admin.probeSources.setClusterMode({ clusterId, mode: null });
    tick(61);
    await evaluate();
    tick(61);
    await evaluate();
    expect(await allEdge()).toEqual(["8.8.3.1", "8.8.3.2", "8.8.3.3"]);
  });

  it("polls a pull provider when due and marks failures", async () => {
    nextHour();
    const { source } = await admin.probeSources.create({
      name: "robot",
      provider: "uptimerobot",
      fields: { api_key: "u1234567-abcdefghijklmnop" },
      pollIntervalSeconds: 60,
    });
    await admin.probeSources.setMappings({
      id: source.id,
      mappings: [{ monitorId: "777", nodeId: nodes.x3 ?? "" }],
    });
    let answer: { status: number; body: unknown } = {
      status: 200,
      body: {
        nextLink: null,
        data: [{ id: 777, friendlyName: "x3", url: "8.8.3.3", type: "PING", status: "DOWN" }],
      },
    };
    const calls: string[] = [];
    const http: Http = async (request) => {
      calls.push(request.url);
      return { status: answer.status, body: Buffer.from(JSON.stringify(answer.body)) };
    };
    await pollProbeSources(ctx, now, http);
    expect(calls).toHaveLength(1);
    expect(await admin.probeSources.results({ id: source.id })).toMatchObject([
      { monitorId: "777", up: false, nodeName: "x3", counted: true },
    ]);
    // Not due yet.
    tick(30);
    await pollProbeSources(ctx, now, http);
    expect(calls).toHaveLength(1);
    answer = { status: 401, body: { message: "Unauthorized" } };
    tick(31);
    await pollProbeSources(ctx, now, http);
    expect((await admin.probeSources.list()).find((s) => s.id === source.id)).toMatchObject({
      status: "failing",
      lastError: "auth_failed",
    });
    expect((await admin.probeSources.results({ id: source.id }))[0]?.counted).toBe(false);
    await admin.probeSources.delete({ id: source.id });
  });
});
