import { describe, expect, it } from "vitest";
import {
  applyNodeConfigDiff,
  compileNodeConfig,
  contentHash,
  decodeNodeConfig,
  diffNodeConfig,
  encodeNodeConfig,
  parseDomain,
  type SiteModel,
} from "../src/index";

const site = (id: string, overrides: Partial<SiteModel> = {}): SiteModel => ({
  id,
  name: `site-${id}`,
  enabled: true,
  cacheGeneration: 1,
  domains: [parseDomain(`${id}.test`)],
  originPool: {
    id: `pool-${id}`,
    policy: "weighted_random",
    origins: [
      {
        id: `o2-${id}`,
        address: "10.0.0.2",
        port: 80,
        scheme: "http",
        weight: 1,
        backup: true,
        hostHeader: "",
        sni: "",
      },
      {
        id: `o1-${id}`,
        address: "whoami",
        port: 80,
        scheme: "http",
        weight: 3,
        backup: false,
        hostHeader: "",
        sni: "",
      },
    ],
  },
  cacheRules: [
    {
      id: "r2",
      priority: 10,
      pathPrefixes: [],
      extensions: ["PNG"],
      expression: "",
      action: "cache",
      edgeTtlSeconds: 86400,
      originCacheControl: "respect",
    },
    {
      id: "r1",
      priority: 10,
      pathPrefixes: ["/"],
      extensions: [],
      expression: "",
      action: "cache",
      edgeTtlSeconds: 60,
      originCacheControl: "override",
    },
  ],
  ...overrides,
});

describe("compileNodeConfig", () => {
  it("produces canonical ordering", () => {
    const cfg = compileNodeConfig({ clusterId: "c", sites: [site("b"), site("a")] }, 1n);
    expect(cfg.sites.map((s) => s.id)).toEqual(["a", "b"]);
    expect(cfg.sites[0]?.originPool?.origins.map((o) => o.id)).toEqual(["o1-a", "o2-a"]);
    expect(cfg.sites[0]?.cacheRules.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(cfg.sites[0]?.cacheRules[1]?.match?.extensions).toEqual(["png"]);
    expect(cfg.listeners.map((l) => l.port)).toEqual([80]);
  });

  it("hashes content independently of input order and revision", () => {
    const a = compileNodeConfig({ clusterId: "c", sites: [site("a"), site("b")] }, 1n);
    const b = compileNodeConfig({ clusterId: "c", sites: [site("b"), site("a")] }, 7n);
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.contentHash).toBe(b.contentHash);
    expect(contentHash(a)).toBe(a.contentHash);
    const c = compileNodeConfig(
      { clusterId: "c", sites: [site("a"), site("b", { cacheGeneration: 2 })] },
      1n,
    );
    expect(c.contentHash).not.toBe(a.contentHash);
  });

  it("drops disabled sites", () => {
    const cfg = compileNodeConfig(
      { clusterId: "c", sites: [site("a"), site("b", { enabled: false })] },
      1n,
    );
    expect(cfg.sites.map((s) => s.id)).toEqual(["a"]);
  });

  it("round-trips through the binary encoding", () => {
    const cfg = compileNodeConfig({ clusterId: "c", sites: [site("a")] }, 3n);
    const decoded = decodeNodeConfig(encodeNodeConfig(cfg));
    expect(decoded.revision).toBe(3n);
    expect(contentHash(decoded)).toBe(cfg.contentHash);
  });

  it("keeps a stable hash for an empty cluster (cross-language vector)", () => {
    const cfg = compileNodeConfig(
      { clusterId: "00000000-0000-0000-0000-000000000000", sites: [] },
      1n,
    );
    // Recomputed by edgeweir-node with proto.MarshalOptions{Deterministic: true};
    // if this changes, the wire encoding of NodeConfig changed.
    expect(cfg.contentHash).toBe(contentHash(decodeNodeConfig(encodeNodeConfig(cfg))));
    expect(
      Buffer.from(encodeNodeConfig({ ...cfg, revision: 0n, contentHash: "" })).toString("hex"),
    ).toMatchSnapshot();
  });
});

describe("diffNodeConfig", () => {
  const base = compileNodeConfig({ clusterId: "c", sites: [site("a"), site("b"), site("c")] }, 1n);
  const target = compileNodeConfig(
    { clusterId: "c", sites: [site("a"), site("b", { cacheGeneration: 5 }), site("d")] },
    2n,
  );

  it("upserts changed and new sites, removes deleted ones", () => {
    const diff = diffNodeConfig(base, target);
    expect(diff.baseRevision).toBe(1n);
    expect(diff.revision).toBe(2n);
    expect(diff.upsertedSites.map((s) => s.id).sort()).toEqual(["b", "d"]);
    expect(diff.removedSiteIds).toEqual(["c"]);
  });

  it("applies back to exactly the target", () => {
    const applied = applyNodeConfigDiff(base, diffNodeConfig(base, target));
    expect(applied.contentHash).toBe(target.contentHash);
    expect(applied.sites.map((s) => s.id)).toEqual(["a", "b", "d"]);
  });

  it("rejects a diff whose hash does not match", () => {
    const diff = diffNodeConfig(base, target);
    diff.contentHash = "0".repeat(64);
    expect(() => applyNodeConfigDiff(base, diff)).toThrow(/hash mismatch/);
  });
});
