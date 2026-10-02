import { randomUUID } from "node:crypto";
import type { AlertPolicy } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { afterAll, describe, expect, it } from "vitest";
import { alertConditions } from "../../src/server/services/alerts";
import { createTestContext } from "./helpers";

/** Deterministic pseudo-random numbers in [0, 1) (mulberry32). */
function random(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface FixtureNode {
  id: string;
  clusterId: string;
  name: string;
  status: string;
  enrolledAt: number | null;
  lastSeenAt: number | null;
  /** node_config_status.data_plane_healthy; undefined: no receipt. */
  dataPlaneHealthy?: boolean;
  security: { siteId: string; level: string; escalatedPaths: number }[];
}
interface FixtureSite {
  id: string;
  clusterId: string;
  name: string;
  enabled: boolean;
  certificateId: string | null;
  domains: string[];
  origins: string[];
}
interface Fixture {
  nodes: FixtureNode[];
  certificates: { id: string; notAfter: number | null }[];
  sites: FixtureSite[];
  health: {
    nodeId: string;
    originId: string;
    siteId: string;
    healthy: boolean;
    reportedAt: number;
    source: string;
  }[];
  traffic: {
    minute: number;
    nodeId: string;
    siteId: string;
    requests: number;
    statusCodes: Record<string, number>;
  }[];
  events: { siteId: string; kind: string; level: string; receivedAt: number }[];
}

const LEVELS = ["normal", "cookie302", "js", "pow", "captcha"];

/** Clusters, nodes, sites, origins, health, traffic and CC events in every state the sweep tells apart. */
function generate(seed: number, clusterIds: string[], now: number): Fixture {
  const rand = random(seed);
  const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)] as T;
  const chance = (p: number) => rand() < p;
  const ago = (maxMs: number) => now - Math.floor(rand() * maxMs);
  const nodes: FixtureNode[] = Array.from({ length: 48 }, (_, i) => ({
    id: randomUUID(),
    clusterId: pick(clusterIds),
    name: `node-${i}`,
    status: chance(0.85) ? "active" : "disabled",
    enrolledAt: chance(0.1) ? null : chance(0.2) ? ago(400_000) : ago(30 * 86400_000),
    lastSeenAt: chance(0.1) ? null : chance(0.7) ? ago(40_000) : ago(900_000),
    dataPlaneHealthy: chance(0.15) ? undefined : chance(0.85),
    security: [],
  }));
  const certificates = Array.from({ length: 12 }, () => ({
    id: randomUUID(),
    notAfter: chance(0.15)
      ? null
      : now + Math.floor((chance(0.5) ? rand() * 12 - 2 : 40 + rand() * 300) * 86400_000),
  }));
  const sites: FixtureSite[] = Array.from({ length: 90 }, (_, i) => ({
    id: randomUUID(),
    clusterId: pick(clusterIds),
    name: `site-${i}`,
    enabled: chance(0.85),
    certificateId: chance(0.7) ? pick(certificates).id : null,
    domains: Array.from({ length: chance(0.1) ? 0 : 1 + Math.floor(rand() * 3) }, (_, d) =>
      d === 0 ? `site-${i}.example.test` : `www${d}.site-${i}.example.test`,
    ),
    origins: Array.from({ length: chance(0.1) ? 0 : 1 + Math.floor(rand() * 3) }, () =>
      randomUUID(),
    ),
  }));
  const health: Fixture["health"] = [];
  const seen = new Set<string>();
  const report = (row: Fixture["health"][number]) => {
    const key = `${row.nodeId}|${row.originId}|${row.source}`;
    if (seen.has(key)) return;
    seen.add(key);
    health.push(row);
  };
  for (const site of sites) {
    const members = nodes.filter((n) => n.clusterId === site.clusterId);
    // Every origin of the site down and freshly reported on one node.
    if (members.length && site.origins.length && chance(0.3)) {
      const node = pick(members);
      for (const originId of site.origins)
        report({
          nodeId: node.id,
          originId,
          siteId: site.id,
          healthy: false,
          reportedAt: ago(chance(0.8) ? 60_000 : 900_000),
          source: pick(["passive", "active"]),
        });
    }
    for (const originId of site.origins)
      for (const node of members)
        if (chance(0.4))
          report({
            nodeId: node.id,
            originId,
            siteId: site.id,
            healthy: chance(0.6),
            reportedAt: ago(chance(0.7) ? 80_000 : 900_000),
            source: pick(["passive", "active"]),
          });
    // A report from a node of another cluster.
    const other = nodes.find((n) => n.clusterId !== site.clusterId);
    if (other && site.origins[0] && chance(0.2))
      report({
        nodeId: other.id,
        originId: site.origins[0],
        siteId: site.id,
        healthy: false,
        reportedAt: ago(30_000),
        source: "passive",
      });
  }
  const traffic: Fixture["traffic"] = [];
  for (const site of sites) {
    if (!chance(0.6)) continue;
    const members = nodes.filter((n) => n.clusterId === site.clusterId);
    const used = new Set<string>();
    for (let k = 0; k < 6; k++) {
      const minute = Math.floor(ago(20 * 60_000) / 60_000) * 60_000;
      const nodeId = members.length ? pick(members).id : randomUUID();
      if (used.has(`${minute}|${nodeId}`)) continue;
      used.add(`${minute}|${nodeId}`);
      const requests = Math.floor(rand() * 200);
      const errors = Math.floor(requests * rand() * (chance(0.4) ? 0.8 : 0.2));
      traffic.push({
        minute,
        nodeId,
        siteId: site.id,
        requests,
        statusCodes: {
          "200": requests - errors,
          "502": Math.floor(errors / 2),
          "503": errors - Math.floor(errors / 2),
        },
      });
    }
  }
  for (const node of nodes)
    for (const site of sites.filter((s) => s.clusterId === node.clusterId))
      if (chance(0.08))
        node.security.push({ siteId: site.id, level: pick(LEVELS), escalatedPaths: 0 });
  const events: Fixture["events"] = [];
  for (const site of sites)
    if (chance(0.15))
      events.push({
        siteId: site.id,
        kind: pick(["site_level", "site_level", "ip_banned"]),
        level: pick(LEVELS),
        receivedAt: ago(300_000),
      });
  return { nodes, certificates, sites, health, traffic, events };
}

interface Condition {
  siteId: string | null;
  kind: string;
  resourceId: string;
  siteName: string;
  domain: string;
}

/** The alert conditions of the policy, evaluated directly on the fixture. */
function expected(f: Fixture, policy: AlertPolicy, now: number) {
  const active = new Map<string, Condition>();
  const offline = now - policy.nodeOfflineSeconds * 1000;
  const watched = f.nodes.filter(
    (n) => n.status === "active" && n.enrolledAt !== null && n.enrolledAt <= offline,
  );
  for (const node of watched)
    if (node.lastSeenAt === null || node.lastSeenAt < offline || node.dataPlaneHealthy === false)
      active.set(`node_offline/platform/${node.id}`, {
        siteId: null,
        kind: "node_offline",
        resourceId: node.id,
        siteName: node.name,
        domain: "",
      });
  const elevated = new Set<string>();
  for (const node of f.nodes)
    if (node.status === "active" && node.lastSeenAt !== null && now - node.lastSeenAt <= 45_000)
      for (const entry of node.security) if (entry.level !== "normal") elevated.add(entry.siteId);
  for (const event of f.events)
    if (event.kind === "site_level" && event.level !== "normal" && event.receivedAt > now - 120_000)
      elevated.add(event.siteId);
  const windowStart = now - policy.windowMinutes * 60_000;
  for (const site of f.sites) {
    if (!site.enabled || site.domains.length === 0) continue;
    const add = (kind: string, resourceId: string) =>
      active.set(`${kind}/${site.id}/${resourceId}`, {
        siteId: site.id,
        kind,
        resourceId,
        siteName: site.name,
        domain: site.domains[0] ?? "",
      });
    const cert = f.certificates.find((c) => c.id === site.certificateId);
    if (cert && cert.notAfter !== null && cert.notAfter <= now + policy.certificateHours * 3600_000)
      add("certificate_expiring", cert.id);
    const down = (nodeId: string, originId: string) =>
      f.health.some(
        (h) =>
          h.nodeId === nodeId && h.originId === originId && !h.healthy && h.reportedAt > offline,
      );
    if (
      site.origins.length &&
      watched.some(
        (n) => n.clusterId === site.clusterId && site.origins.every((o) => down(n.id, o)),
      )
    )
      add("origin_unavailable", site.id);
    const rows = f.traffic.filter(
      (t) => t.siteId === site.id && t.minute >= windowStart && t.minute <= now,
    );
    if (rows.length) {
      const requests = rows.reduce((sum, t) => sum + t.requests, 0);
      const errors = rows.reduce(
        (sum, t) =>
          sum +
          Object.entries(t.statusCodes)
            .filter(([code]) => code.startsWith("5"))
            .reduce((s, [, n]) => s + n, 0),
        0,
      );
      if (requests >= policy.minimumRequests && errors / requests >= policy.errorRatio)
        add("high_5xx", site.id);
    }
    if (elevated.has(site.id)) add("cc_mitigation", site.id);
  }
  return active;
}

describe("alert conditions", async () => {
  const { ctx, client } = await createTestContext();
  afterAll(() => client.close());

  it("match a direct evaluation of the policy on a generated fixture", async () => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    const clusterIds = [randomUUID(), randomUUID(), randomUUID()];
    await ctx.db
      .insert(schema.cluster)
      .values(clusterIds.map((id, i) => ({ id, name: `conditions-${i}` })));
    const f = generate(20261002, clusterIds, now);
    const date = (ms: number | null) => (ms === null ? null : new Date(ms));
    await ctx.db.insert(schema.node).values(
      f.nodes.map((n) => ({
        id: n.id,
        clusterId: n.clusterId,
        name: n.name,
        status: n.status,
        enrolledAt: date(n.enrolledAt),
        lastSeenAt: date(n.lastSeenAt),
        securityState: n.security,
      })),
    );
    await ctx.db
      .insert(schema.nodeConfigStatus)
      .values(
        f.nodes.flatMap((n) =>
          n.dataPlaneHealthy === undefined
            ? []
            : [{ nodeId: n.id, state: "applied", dataPlaneHealthy: n.dataPlaneHealthy }],
        ),
      );
    await ctx.db.insert(schema.certificate).values(
      f.certificates.map((c) => ({
        id: c.id,
        name: c.id,
        source: "upload",
        notAfter: date(c.notAfter),
      })),
    );
    await ctx.db.insert(schema.site).values(
      f.sites.map((s) => ({
        id: s.id,
        clusterId: s.clusterId,
        name: s.name,
        enabled: s.enabled,
        certificateId: s.certificateId,
      })),
    );
    await ctx.db
      .insert(schema.siteDomain)
      .values(f.sites.flatMap((s) => s.domains.map((name) => ({ siteId: s.id, name }))));
    for (const site of f.sites) {
      const [pool] = await ctx.db
        .insert(schema.originPool)
        .values({ siteId: site.id })
        .returning({ id: schema.originPool.id });
      if (!pool) throw new Error("pool missing");
      if (site.origins.length)
        await ctx.db
          .insert(schema.origin)
          .values(
            site.origins.map((id) => ({ id, poolId: pool.id, address: "origin.test", port: 80 })),
          );
    }
    await ctx.db
      .insert(schema.originHealth)
      .values(f.health.map((h) => ({ ...h, reportedAt: new Date(h.reportedAt) })));
    await ctx.db
      .insert(schema.nodeMinuteStats)
      .values(f.traffic.map((t) => ({ ...t, minute: new Date(t.minute) })));
    await ctx.db.insert(schema.securityEvent).values(
      f.events.map((e, i) => ({
        nodeEventId: `event-${i}`,
        siteId: e.siteId,
        kind: e.kind,
        level: e.level,
        previousLevel: "normal",
        occurredAt: new Date(e.receivedAt),
        receivedAt: new Date(e.receivedAt),
      })),
    );

    const policies: AlertPolicy[] = [
      {
        nodeOfflineSeconds: 90,
        certificateHours: 72,
        errorRatio: 0.2,
        minimumRequests: 100,
        windowMinutes: 5,
      },
      {
        nodeOfflineSeconds: 300,
        certificateHours: 720,
        errorRatio: 0.5,
        minimumRequests: 10,
        windowMinutes: 15,
      },
    ];
    const sorted = (map: Map<string, Condition>) =>
      [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const policy of policies) {
      const want = expected(f, policy, now);
      const { active } = await alertConditions(ctx, policy, now);
      expect(sorted(active)).toEqual(sorted(want));
      // The fixture exercises every kind the sweep evaluates.
      expect(new Set([...want.values()].map((c) => c.kind))).toEqual(
        new Set([
          "node_offline",
          "certificate_expiring",
          "origin_unavailable",
          "high_5xx",
          "cc_mitigation",
        ]),
      );
    }
  });
});
