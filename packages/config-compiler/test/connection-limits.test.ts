import { L4Protocol } from "@edgeweir/proto";
import { describe, expect, it } from "vitest";
import {
  applyNodeConfigDiff,
  clusterTcpPorts,
  compileNodeConfig,
  diffNodeConfig,
  mergePortRanges,
  usesChallengeKeys,
} from "../src/index";
import { v0230Models } from "./v0230-models";

const plain = (r: { start: number; end: number }) => ({ start: r.start, end: r.end });

describe("kernel connection limits (conn-limit-v1)", () => {
  it("merges touching and overlapping ranges and caps their number", () => {
    expect(
      mergePortRanges([
        { start: 443, end: 443 },
        { start: 80, end: 80 },
        { start: 81, end: 85 },
        { start: 8000, end: 9000 },
        { start: 8500, end: 8600 },
      ]),
    ).toEqual([
      { start: 80, end: 85 },
      { start: 443, end: 443 },
      { start: 8000, end: 9000 },
    ]);
    // Over the cap, the ranges with the smallest gaps between them join.
    expect(
      mergePortRanges(
        [
          { start: 10, end: 10 },
          { start: 12, end: 12 },
          { start: 100, end: 100 },
          { start: 1000, end: 1000 },
        ],
        3,
      ),
    ).toEqual([
      { start: 10, end: 12 },
      { start: 100, end: 100 },
      { start: 1000, end: 1000 },
    ]);
  });

  it("limits the listeners and TCP layer-4 ports, not UDP ones", () => {
    expect(
      clusterTcpPorts(
        [{ port: 80 }, { port: 443 }],
        [
          { protocol: L4Protocol.TCP, port: 2000, portEnd: 2010 },
          { protocol: L4Protocol.UDP, port: 3000, portEnd: 0 },
          { protocol: L4Protocol.TCP, port: 444, portEnd: 0 },
        ],
      ),
    ).toEqual([
      { start: 80, end: 80 },
      { start: 443, end: 444 },
      { start: 2000, end: 2010 },
    ]);
  });

  it("compiles the cluster's limits and leaves them out without one", () => {
    const off = compileNodeConfig(v0230Models(), 1n);
    expect(off.connectionLimits).toBeUndefined();

    const input = v0230Models();
    const edge = { httpPorts: [], httpsPorts: [], clientIp: null, ...input.edge };
    input.edge = {
      ...edge,
      connectionLimits: { perIp: 64, newPerSecond: 10, burst: 0, ports: null },
    };
    const on = compileNodeConfig(input, 2n);
    expect(on.connectionLimits?.perIpConnections).toBe(64);
    expect(on.connectionLimits?.newPerSecond).toBe(10);
    // A burst below the rate is the rate.
    expect(on.connectionLimits?.burst).toBe(10);
    expect(on.connectionLimits?.ports.map(plain)).toEqual(clusterTcpPorts(on.listeners, on.l4Apps));
    expect(on.requiredFeatures).not.toContain("conn-limit-v1");

    input.edge = {
      ...edge,
      connectionLimits: {
        perIp: 0,
        newPerSecond: 5,
        burst: 50,
        ports: [
          { start: 9000, end: 9001 },
          { start: 22, end: 22 },
        ],
      },
    };
    const named = compileNodeConfig(input, 3n);
    expect(named.connectionLimits?.perIpConnections).toBe(0);
    expect(named.connectionLimits?.burst).toBe(50);
    expect(named.connectionLimits?.ports.map(plain)).toEqual([
      { start: 22, end: 22 },
      { start: 9000, end: 9001 },
    ]);

    const diff = diffNodeConfig(off, named);
    expect(diff.connectionLimits?.newPerSecond).toBe(5);
    const applied = applyNodeConfigDiff(off, diff);
    expect(applied.connectionLimits?.ports.map(plain)).toEqual([
      { start: 22, end: 22 },
      { start: 9000, end: 9001 },
    ]);
    expect(applyNodeConfigDiff(named, diffNodeConfig(named, off)).connectionLimits).toBeUndefined();
  });

  it("brings challenge keys along with greylist challenges", () => {
    const input = v0230Models();
    expect(usesChallengeKeys({ ...input, greylistChallenges: true })).toBe(true);
    const challengeKeys = [{ id: "k1", role: "current" }];
    expect(compileNodeConfig({ ...input, challengeKeys }, 1n).challengeKeys).toEqual([]);
    const config = compileNodeConfig({ ...input, challengeKeys, greylistChallenges: true }, 1n);
    expect(config.challengeKeys.map((k) => k.id)).toEqual(["k1"]);
    expect(config.requiredFeatures).toContain("challenge-v1");
  });
});
