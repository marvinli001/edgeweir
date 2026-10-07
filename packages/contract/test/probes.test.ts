import { describe, expect, it } from "vitest";
import {
  DNS_LINES,
  dnsBindingInput,
  dnsLine,
  dnsRevisionReasonDefs,
  METRICS_FEATURE,
  nodeAddressesInput,
  PROBE_HEALTH_FEATURE,
  PROBE_SETTINGS_DEFAULTS,
  probeSettings,
  schedulingCondition,
  schedulingRuleInput,
  withLineDefaults,
} from "../src/index";

const id = "8f2f9c3a-2c61-4f6b-9f68-2f43b8a3a0d1";
const other = "2b1d7c64-5a0e-4c35-9d51-6c7a1b2e3f40";

describe("probe settings", () => {
  it("defaults to 10 s rounds of 3 attempts of 3 s, down after 30 s at 50 % loss, up after 60 s", () => {
    expect(probeSettings.parse(PROBE_SETTINGS_DEFAULTS)).toEqual({
      intervalSeconds: 10,
      timeoutMs: 3000,
      attempts: 3,
      lossPercent: 50,
      ipDownSeconds: 30,
      ipUpSeconds: 60,
    });
  });

  it("accepts the shortest settings and refuses attempts longer than a round", () => {
    const shortest = {
      intervalSeconds: 5,
      timeoutMs: 500,
      attempts: 1,
      lossPercent: 1,
      ipDownSeconds: 5,
      ipUpSeconds: 5,
    };
    expect(probeSettings.safeParse(shortest).success).toBe(true);
    expect(probeSettings.safeParse({ ...shortest, timeoutMs: 5001 }).success).toBe(false);
    expect(
      probeSettings.safeParse({ ...shortest, intervalSeconds: 60, timeoutMs: 10000 }).success,
    ).toBe(true);
  });
});

describe("scheduling rules", () => {
  it("fills condition and rule defaults", () => {
    expect(
      schedulingRuleInput.parse({
        clusterId: id,
        name: " hot ",
        conditions: [{ metric: "cpu_percent", comparator: "gt", threshold: 90 }],
        action: "remove_node",
      }),
    ).toEqual({
      clusterId: id,
      lineName: null,
      name: "hot",
      enabled: true,
      match: "all",
      conditions: [
        {
          metric: "cpu_percent",
          aggregate: "avg",
          comparator: "gt",
          threshold: 90,
          durationSeconds: 0,
          regionId: null,
        },
      ],
      action: "remove_node",
      holdSeconds: 300,
      recoverSeconds: 300,
    });
  });

  it("narrows only probe metrics to a region", () => {
    for (const metric of ["probe_loss_percent", "probe_latency_ms"])
      expect(
        schedulingCondition.safeParse({ metric, comparator: "ge", threshold: 1, regionId: id })
          .success,
      ).toBe(true);
    for (const metric of ["cpu_percent", "load1", "memory_percent", "egress_mbps", "connections"])
      expect(
        schedulingCondition.safeParse({ metric, comparator: "ge", threshold: 1, regionId: id })
          .success,
      ).toBe(false);
  });
});

describe("node scheduling addresses", () => {
  it("needs a primary address when there are any, at most 8, levels 0-2", () => {
    expect(nodeAddressesInput.safeParse({ id, addresses: [] }).success).toBe(true);
    expect(
      nodeAddressesInput.safeParse({ id, addresses: [{ address: "192.0.2.1", level: 1 }] }).success,
    ).toBe(false);
    expect(
      nodeAddressesInput.safeParse({
        id,
        addresses: Array.from({ length: 9 }, (_, i) => ({ address: `192.0.2.${i}`, level: 0 })),
      }).success,
    ).toBe(false);
    expect(
      nodeAddressesInput.safeParse({ id, addresses: [{ address: "192.0.2.1", level: 3 }] }).success,
    ).toBe(false);
  });
});

describe("DNS binding lines", () => {
  it("default to the default resolution line, no backup group and one healthy address", () => {
    expect(dnsLine.parse({ name: "east", nodeGroupId: id })).toEqual({
      name: "east",
      nodeGroupId: id,
      overrides: [],
      resolutionLine: "default",
      backupNodeGroupIds: [],
      minHealthyIps: 1,
    });
    expect(withLineDefaults({ name: "east", nodeGroupId: id, overrides: [] })).toEqual(
      dnsLine.parse({ name: "east", nodeGroupId: id }),
    );
  });

  it("takes canonical lines only, up to 4 distinct backups other than the group, 1-64 addresses", () => {
    for (const line of DNS_LINES)
      expect(dnsLine.safeParse({ name: "x", nodeGroupId: id, resolutionLine: line }).success).toBe(
        true,
      );
    for (const bad of [
      { resolutionLine: "oversea" },
      { resolutionLine: "" },
      { backupNodeGroupIds: [id] },
      { backupNodeGroupIds: [other, other] },
      { minHealthyIps: 0 },
      { minHealthyIps: 65 },
    ])
      expect(dnsLine.safeParse({ name: "x", nodeGroupId: id, ...bad }).success).toBe(false);
    expect(
      dnsBindingInput.safeParse({
        mode: "manual",
        domain: "edge.example.com",
        lines: [{ name: "x", nodeGroupId: id, backupNodeGroupIds: [other], minHealthyIps: 2 }],
      }).success,
    ).toBe(true);
  });

  it("names the DNS revision reasons and their message parameters", () => {
    expect(Object.keys(dnsRevisionReasonDefs).sort()).toEqual([
      "cname",
      "cname_expired",
      "force",
      "health",
      "manual",
      "rollback",
      "scheduling",
    ]);
    expect(dnsRevisionReasonDefs.scheduling.params).toEqual(["rule", "node"]);
    // G10: a changed CNAME prefix names its site or application; expiry has no parameters.
    expect(dnsRevisionReasonDefs.cname.params).toEqual(["name"]);
    expect(dnsRevisionReasonDefs.cname_expired.params).toEqual([]);
  });
});

describe("probe node features", () => {
  it("names the health endpoint and the metrics features", () => {
    expect(PROBE_HEALTH_FEATURE).toBe("probe-health-v1");
    expect(METRICS_FEATURE).toBe("metrics-v1");
  });
});
