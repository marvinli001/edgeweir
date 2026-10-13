import type { Node } from "@edgeweir/contract";
import { describe, expect, it } from "vitest";
import { upgradeBlocker } from "../../src/web/lib/node-upgrades";
import { overwriteGetLocale } from "../../src/web/paraglide/runtime.js";

const ready: Node = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "edge-1",
  clusterId: "00000000-0000-4000-8000-000000000002",
  clusterName: "default",
  nodeGroupId: null,
  nodeGroupName: null,
  regionName: null,
  hostname: "edge-1",
  status: "active",
  online: true,
  lastSeenAt: null,
  enrolledAt: null,
  agentVersion: "0.2.1",
  supportedFeatures: ["self-upgrade-v1"],
  upgradeRequired: false,
  engine: "openresty",
  engineVersion: "1.31.1.1",
  os: "linux",
  arch: "arm64",
  ipAddresses: [],
  certFingerprint: null,
  certNotAfter: null,
  appliedRevision: 11,
  appliedContentHash: "h11",
  targetRevision: 11,
  applyState: "applied",
  applyMessage: "",
  dataPlaneHealthy: true,
  banStatus: null,
  probeEnabled: false,
  metrics: null,
  schedulingAddresses: [],
  schedulingLevel: 0,
  remoteAddress: null,
  dnsIssue: null,
  authError: null,
  cache: { maxSizeGb: null, usage: null },
  certificateFailures: [],
};

describe("nodes that stop an upgrade from starting", () => {
  overwriteGetLocale(() => "en");
  const none = new Set<string>();

  it("lets in-sync nodes and nodes behind only for missing capabilities take part", () => {
    expect(upgradeBlocker(ready, none)).toBeNull();
    // 「需要升级」: the target needs a capability the node lacks; it runs revision 11.
    expect(
      upgradeBlocker({ ...ready, upgradeRequired: true, targetRevision: 12 }, none),
    ).toBeNull();
  });

  it("keeps every other check", () => {
    expect(upgradeBlocker(ready, new Set([ready.id]))).toBe("Upgrade in progress");
    expect(upgradeBlocker({ ...ready, targetRevision: 12 }, none)).toBe("Behind");
    const lagging = { ...ready, upgradeRequired: true, targetRevision: 12 };
    expect(upgradeBlocker({ ...lagging, online: false }, none)).toBe("Offline");
    expect(upgradeBlocker({ ...lagging, dataPlaneHealthy: false }, none)).toBe(
      "Data plane unhealthy",
    );
    expect(upgradeBlocker({ ...lagging, applyState: "failed" }, none)).toBe(
      "Configuration not applied",
    );
    expect(upgradeBlocker({ ...lagging, supportedFeatures: [] }, none)).toBe("No signed upgrades");
    expect(upgradeBlocker({ ...lagging, arch: "riscv64" }, none)).toBe("Unsupported architecture");
    // Never applied a revision, or ahead of the target (a canary candidate): not a capability gap.
    expect(upgradeBlocker({ ...lagging, appliedRevision: 0, appliedContentHash: "" }, none)).toBe(
      "Behind",
    );
    expect(upgradeBlocker({ ...lagging, appliedRevision: 13 }, none)).toBe("Behind");
  });
});
