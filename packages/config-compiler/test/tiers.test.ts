import { describe, expect, it } from "vitest";
import {
  applyNodeConfigDiff,
  chooseTiers,
  compileNodeConfig,
  diffNodeConfig,
  type TierCandidate,
  type TierHopModel,
  tierTargetId,
} from "../src/index";
import { site } from "./v0230-models";

// Two regions: eu (e1, e2, e3) and us (u1, u2); x1 has no region.
const node = (id: string, regionId: string | null, upper = true, groupIds: string[] = []) =>
  ({ id, regionId, upper, groupIds }) satisfies TierCandidate;
const cluster = [
  node("e1", "eu"),
  node("e2", "eu"),
  node("e3", "eu", false),
  node("u1", "us"),
  node("u2", "us"),
];
const rtts = (map: Record<string, number>) => (id: string) => map[id] ?? null;
const uppersOf = (hops: TierHopModel[]) =>
  Object.fromEntries(hops.map((h) => [h.nodeId, h.uppers.map((u) => `${u.nodeId}:${u.reason}`)]));

describe("chooseTiers", () => {
  it("smart: the fastest node is the upper tier, the fastest of another region the fallback", () => {
    const choice = chooseTiers({
      topology: "smart",
      candidates: cluster,
      rtt: rtts({ e1: 30, e2: 12, u1: 80, u2: 60 }),
    });
    expect(choice.idleReason).toBeNull();
    expect(uppersOf(choice.hops)).toEqual({
      e1: ["e2:lowest_latency", "u2:fallback_region"],
      e3: ["e2:lowest_latency", "u2:fallback_region"],
      u1: ["e2:lowest_latency", "u2:fallback_region"],
      u2: ["e2:lowest_latency"],
    });
    expect(choice.hops[0]?.uppers[0]?.rttMs).toBe(12);
  });

  it("smart follows the latency but keeps the upper tier while it is not clearly slower", () => {
    const first = chooseTiers({
      topology: "smart",
      candidates: cluster,
      rtt: rtts({ e1: 20, u1: 50 }),
    });
    expect(first.hops[0]?.uppers[0]?.nodeId).toBe("e1");
    // u1 is now faster, but within 20 % + 5 ms: e1 stays.
    const noisy = chooseTiers({
      topology: "smart",
      candidates: cluster,
      rtt: rtts({ e1: 20, u1: 15 }),
      previous: first.hops,
    });
    expect(noisy.hops.find((h) => h.nodeId === "e2")?.uppers[0]?.nodeId).toBe("e1");
    // Clearly faster: the upper tier moves.
    const moved = chooseTiers({
      topology: "smart",
      candidates: cluster,
      rtt: rtts({ e1: 90, u1: 15 }),
      previous: first.hops,
    });
    expect(uppersOf(moved.hops).e2).toEqual(["u1:lowest_latency", "e1:fallback_region"]);
    // A previous upper tier without a measurement gives way.
    const gone = chooseTiers({
      topology: "smart",
      candidates: cluster,
      rtt: rtts({ u1: 15 }),
      previous: first.hops,
    });
    expect(gone.hops[0]?.uppers[0]?.nodeId).toBe("u1");
  });

  it("generic: each region's fastest capable node, by id without measurements", () => {
    const choice = chooseTiers({
      topology: "generic",
      candidates: [...cluster, node("a1", "ap", false)],
      rtt: rtts({ u2: 40, u1: 70 }),
    });
    expect(uppersOf(choice.hops)).toEqual({
      a1: ["u2:region_upper"], // no capable node in ap: the fastest region's
      e2: ["e1:region_upper"],
      e3: ["e1:region_upper"],
      u1: ["u2:region_upper"],
    });
  });

  it("regional: regional tiers in front of the upper tier, two hops at most", () => {
    const choice = chooseTiers({
      topology: "regional",
      candidates: [...cluster, node("x1", null)],
      rtt: rtts({ e1: 10, e2: 30, u1: 70, u2: 90 }),
    });
    expect(uppersOf(choice.hops)).toEqual({
      e2: ["e1:lowest_latency", "u1:fallback_region"],
      e3: ["e1:lowest_latency", "u1:fallback_region"],
      u1: ["e1:global_upper"],
      u2: ["u1:regional_tier", "e1:global_upper"],
      x1: ["e1:lowest_latency", "u1:fallback_region"],
    });
  });

  it("custom: named nodes and groups, the node's region first", () => {
    const candidates = [...cluster.slice(0, 3), node("u1", "us", true, ["g"]), node("u2", "us")];
    const choice = chooseTiers({
      topology: "custom",
      candidates,
      rtt: rtts({ u1: 5 }),
      upperNodeIds: ["e1"],
      upperNodeGroupIds: ["g"],
    });
    expect(uppersOf(choice.hops)).toEqual({
      e2: ["e1:custom", "u1:custom"],
      e3: ["e1:custom", "u1:custom"],
      u2: ["u1:custom", "e1:custom"],
    });
    expect(
      chooseTiers({ topology: "custom", candidates, rtt: rtts({}), upperNodeIds: ["e3"] })
        .idleReason,
    ).toBe("no_upper");
    expect(chooseTiers({ topology: "custom", candidates, rtt: rtts({}) }).idleReason).toBe(
      "no_custom",
    );
  });

  it("says why a site has no upper tiers", () => {
    expect(
      chooseTiers({ topology: "smart", candidates: [node("e1", "eu")], rtt: rtts({}) }).idleReason,
    ).toBe("single_node");
    expect(
      chooseTiers({
        topology: "generic",
        candidates: [node("e1", "eu", false), node("e2", "eu", false)],
        rtt: rtts({}),
      }).idleReason,
    ).toBe("no_upper");
    expect(
      chooseTiers({ topology: "regional", candidates: cluster, rtt: rtts({}) }).idleReason,
    ).toBe("no_latency");
  });
});

describe("compileTieredCache", () => {
  const hops = (upper: string): TierHopModel[] => [
    { nodeId: "n2", uppers: [{ nodeId: upper, reason: "lowest_latency", rttMs: 3 }] },
    { nodeId: "n3", uppers: [{ nodeId: upper, reason: "lowest_latency", rttMs: 3 }] },
  ];
  const compile = (extra = {}) =>
    compileNodeConfig(
      {
        clusterId: "c1",
        sites: [site("s1"), site("s2"), site("s3"), site("s4", { enabled: false })],
        tieredCache: {
          port: 8444,
          addresses: { n1: "192.0.2.1", n2: "192.0.2.2", n3: "192.0.2.3" },
          sites: [
            { siteId: "s1", hops: hops("n1") },
            { siteId: "s2", hops: hops("n1").reverse() },
            { siteId: "s3", hops: [] },
            { siteId: "s4", hops: hops("n1") },
          ],
          latencyTargets: [
            { id: tierTargetId("origin.example", 443), host: "origin.example", port: 443 },
            { id: tierTargetId("ORIGIN.example", 443), host: "origin.example", port: 443 },
          ],
          ...extra,
        },
      },
      1n,
    );

  it("shares a plan between sites with the same hops and names only upper tiers' addresses", () => {
    const config = compile();
    const tc = config.tieredCache;
    expect(tc?.port).toBe(8444);
    expect(tc?.plans).toHaveLength(1);
    const planId = tc?.plans[0]?.id ?? "";
    expect(planId).toMatch(/^p[A-Za-z0-9_-]{22}$/);
    expect(config.sites.map((s) => [s.id, s.tierPlanId])).toEqual([
      ["s1", planId],
      ["s2", planId],
      ["s3", ""],
    ]);
    expect(tc?.plans[0]?.hops.map((h) => [h.nodeId, h.upperNodeIds])).toEqual([
      ["n2", ["n1"]],
      ["n3", ["n1"]],
    ]);
    expect(tc?.nodes.map((n) => [n.id, n.address])).toEqual([
      ["n1", "192.0.2.1"],
      ["n2", ""],
      ["n3", ""],
    ]);
    expect(tc?.latencyTargets.map((t) => t.host)).toEqual(["origin.example"]);
  });

  it("changes the configuration when the upper tier moves and carries it in diffs", () => {
    const before = compile();
    const after = compileNodeConfig(
      {
        clusterId: "c1",
        sites: [site("s1"), site("s2"), site("s3"), site("s4", { enabled: false })],
        tieredCache: {
          port: 8444,
          addresses: { n1: "192.0.2.1", n2: "192.0.2.2" },
          sites: [
            {
              siteId: "s1",
              hops: [{ nodeId: "n1", uppers: [{ nodeId: "n2", reason: "custom", rttMs: null }] }],
            },
          ],
          latencyTargets: [],
        },
      },
      2n,
    );
    expect(after.contentHash).not.toBe(before.contentHash);
    const applied = applyNodeConfigDiff(before, diffNodeConfig(before, after));
    expect(applied.tieredCache?.nodes.map((n) => n.address)).toEqual(["", "192.0.2.2"]);
    expect(applied.sites.map((s) => s.tierPlanId)).toEqual(after.sites.map((s) => s.tierPlanId));
  });

  it("is left out when a listener or a TCP application took the port", () => {
    const config = compile({ port: 80 });
    expect(config.tieredCache).toBeUndefined();
    expect(config.sites.every((s) => s.tierPlanId === "")).toBe(true);
  });

  it("is left out when no site has upper tiers and nothing is measured", () => {
    expect(compile({ sites: [], latencyTargets: [] }).tieredCache).toBeUndefined();
  });
});
