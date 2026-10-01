import type { schema } from "@edgeweir/db";
import { describe, expect, it } from "vitest";
import {
  effectiveAddresses,
  type SchedulingAddress,
  schedulingAddressesOf,
} from "../../src/server/services/node-addresses";

type Row = typeof schema.nodeIp.$inferSelect;
const row = (address: string, source = "reported", level = 0): Row => ({
  id: address,
  nodeId: "n",
  address,
  kind: source,
  source,
  level,
  createdAt: new Date(0),
});
const at = (address: string, level: number): SchedulingAddress => ({
  address,
  level,
  source: "configured",
});

describe("node scheduling addresses", () => {
  it("use the configured addresses, else the public reported ones at level 0", () => {
    expect(
      schedulingAddressesOf([
        row("8.8.8.8"),
        row("10.0.0.1"),
        row("192.0.2.1"),
        row("2001:4860::8"),
      ]),
    ).toEqual([
      { address: "2001:4860::8", level: 0, source: "reported" },
      { address: "8.8.8.8", level: 0, source: "reported" },
    ]);
    expect(
      schedulingAddressesOf([
        row("8.8.8.8"),
        row("172.28.0.2", "configured", 1),
        row("172.28.0.1", "configured", 0),
      ]),
    ).toEqual([
      { address: "172.28.0.1", level: 0, source: "configured" },
      { address: "172.28.0.2", level: 1, source: "configured" },
    ]);
    expect(schedulingAddressesOf([])).toEqual([]);
  });

  it("answer with the lowest reachable level, a reachable forced level, or nothing when all are down", () => {
    const levels = [at("1.1.1.1", 0), at("1.1.1.2", 0), at("2.2.2.2", 1), at("3.3.3.3", 2)];
    expect(effectiveAddresses(levels, new Set())).toEqual({
      level: 0,
      addresses: ["1.1.1.1", "1.1.1.2"],
    });
    // A down address of a level that still has a reachable one is left out.
    expect(effectiveAddresses(levels, new Set(["1.1.1.1"]))).toEqual({
      level: 0,
      addresses: ["1.1.1.2"],
    });
    expect(effectiveAddresses(levels, new Set(["1.1.1.1", "1.1.1.2"]))).toEqual({
      level: 1,
      addresses: ["2.2.2.2"],
    });
    expect(effectiveAddresses(levels, new Set(["1.1.1.1", "1.1.1.2", "2.2.2.2"]))).toEqual({
      level: 2,
      addresses: ["3.3.3.3"],
    });
    // Every level down: no address (the line falls back to its backups).
    expect(
      effectiveAddresses(levels, new Set(["1.1.1.1", "1.1.1.2", "2.2.2.2", "3.3.3.3"])),
    ).toEqual({ level: 0, addresses: [] });
    // backup_ip: at least level 1; past a down level 1 to level 2.
    expect(effectiveAddresses(levels, new Set(), 1)).toEqual({ level: 1, addresses: ["2.2.2.2"] });
    expect(effectiveAddresses(levels, new Set(["2.2.2.2"]), 1)).toEqual({
      level: 2,
      addresses: ["3.3.3.3"],
    });
    // A forced level that cannot be reached (or does not exist) is not forced.
    const two = [at("1.1.1.1", 0), at("2.2.2.2", 1)];
    expect(effectiveAddresses(two, new Set(["2.2.2.2"]), 1)).toEqual({
      level: 0,
      addresses: ["1.1.1.1"],
    });
    expect(effectiveAddresses([at("1.1.1.1", 0)], new Set(), 1)).toEqual({
      level: 0,
      addresses: ["1.1.1.1"],
    });
    expect(effectiveAddresses([], new Set())).toEqual({ level: 0, addresses: [] });
  });
});
