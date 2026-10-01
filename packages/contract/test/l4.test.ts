import { describe, expect, it } from "vitest";
import {
  errorDefs,
  L4_APP_DEFAULTS,
  L4_FEATURE,
  l4AppCreateInput,
  l4AppUpdateInput,
  l4StatsInput,
  portPoolsInput,
  reasonText,
} from "../src/index";

const id = "8f2f9c3a-2c61-4f6b-9f68-2f43b8a3a0d1";
const list = "2b1d7c64-5a0e-4c35-9d51-6c7a1b2e3f40";

describe("layer-4 applications", () => {
  it("fills the defaults of a new application, the idle timeout by protocol later", () => {
    expect(
      l4AppCreateInput.parse({
        clusterId: id,
        name: " game ",
        protocol: "tcp",
        port: 25565,
        origins: [{ address: "game.example.com", port: 25565 }],
      }),
    ).toEqual({
      clusterId: id,
      name: "game",
      protocol: "tcp",
      port: 25565,
      enabled: true,
      acceptProxyProtocol: false,
      proxyProtocolVersion: 0,
      origins: [{ address: "game.example.com", port: 25565, weight: 1, backup: false }],
      maxFails: 3,
      failTimeoutSeconds: 30,
      connectTimeoutMs: 5000,
      allowListIds: [],
      blockListIds: [],
      maxConnections: 0,
      newConnectionsPerSecond: 0,
    });
    expect(L4_APP_DEFAULTS.idleTimeoutSeconds).toEqual({ tcp: 600, udp: 30 });
    expect(L4_FEATURE).toBe("l4-v1");
  });

  it("checks ports, origins, PROXY versions, limits and list ids", () => {
    const base = {
      clusterId: id,
      name: "x",
      protocol: "udp",
      port: 1024,
      origins: [{ address: "203.0.113.1", port: 53 }],
    };
    expect(l4AppCreateInput.safeParse(base).success).toBe(true);
    expect(l4AppCreateInput.safeParse({ ...base, port: 65535 }).success).toBe(true);
    for (const bad of [
      { port: 1023 },
      { port: 65536 },
      { proxyProtocolVersion: 3 },
      { origins: [] },
      { origins: [{ address: "203.0.113.1", port: 53, backup: true }] },
      { origins: Array.from({ length: 33 }, () => ({ address: "203.0.113.1", port: 53 })) },
      { maxFails: 101 },
      { connectTimeoutMs: 60_001 },
      { newConnectionsPerSecond: 1_000_001 },
      { allowListIds: Array.from({ length: 17 }, () => list) },
    ])
      expect(l4AppCreateInput.safeParse({ ...base, ...bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
    // List ids are a set.
    expect(
      l4AppUpdateInput.parse({ id, allowListIds: [list, list.toUpperCase()] }).allowListIds,
    ).toEqual([list]);
    expect(l4AppUpdateInput.parse({ id })).toEqual({ id });
  });

  it("accepts port pools of 1024-65535 with the first port not above the last", () => {
    const pools = (protocol: string, from: number, to: number) =>
      portPoolsInput.safeParse({ clusterId: id, pools: [{ protocol, from, to }] }).success;
    expect(pools("both", 1024, 65535)).toBe(true);
    expect(pools("tcp", 2000, 2000)).toBe(true);
    expect(pools("tcp", 2001, 2000)).toBe(false);
    expect(pools("udp", 1000, 2000)).toBe(false);
    expect(pools("sctp", 2000, 2000)).toBe(false);
  });

  it("takes statistics ranges of up to 7 days", () => {
    const range = (from: string, to: string) => l4StatsInput.safeParse({ id, from, to }).success;
    expect(range("2026-10-01T00:00:00Z", "2026-10-08T00:00:00Z")).toBe(true);
    expect(range("2026-10-01T00:00:00Z", "2026-10-08T00:00:01Z")).toBe(false);
    expect(range("2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z")).toBe(false);
  });

  it("names the error codes and revision reasons", () => {
    expect(errorDefs.L4_PORT_OUTSIDE_POOL).toEqual({ status: 400, params: ["port"] });
    expect(errorDefs.L4_PORT_IN_USE).toEqual({ status: 409, params: ["apps"] });
    expect(reasonText("l4_app_created", { app: "game" })).toBe("L4 application game created");
  });
});
