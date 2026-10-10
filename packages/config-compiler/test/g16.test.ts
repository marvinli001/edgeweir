import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clone, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { NodeConfigSchema, SiteSchema } from "@edgeweir/proto";
import { describe, expect, it } from "vitest";
import {
  ACCESS_LOGS_V2_FEATURE,
  type CompileInput,
  canonicalize,
  compileNodeConfig,
  contentHash,
  type SiteModel,
} from "../src/index";
import { site, tls } from "./v0230-models";
import { v0300Models } from "./v0300-models";

// Same vector as edgeweir-node/internal/configir/testdata/content_hash_vector_v0300.json.
type Vector = { config: JsonValue; canonical_hex: string; content_hash: string };
const vector = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures", "content_hash_vector_v0300.json"), "utf8"),
) as Vector;

const input = (extra: Partial<SiteModel> = {}): CompileInput => ({
  clusterId: "c1",
  sites: [site("a", { tls: tls(), logSampleRate: 100, ...extra })],
});

describe("access log options (access-logs-v2)", () => {
  it("compiles the options and requires access-logs-v2 for any of them", () => {
    for (const extra of [
      { logBlocked: true },
      { logQuery: true },
      { logHeaders: ["x-trace-id"] },
      { logPeer: true },
    ]) {
      const config = compileNodeConfig(input(extra), 1n);
      expect(config.requiredFeatures).toContain(ACCESS_LOGS_V2_FEATURE);
    }
    const config = compileNodeConfig(
      input({ logBlocked: true, logHeaders: ["x-b", "x-a", "x-b"], logPeer: true }),
      1n,
    );
    const a = config.sites[0];
    expect(a?.logBlocked).toBe(true);
    expect(a?.logQuery).toBe(false);
    expect(a?.logHeaders).toEqual(["x-a", "x-b"]);
    expect(a?.logPeer).toBe(true);
  });

  it("encodes a site without options exactly as before", () => {
    const before = compileNodeConfig(input(), 1n);
    const off = compileNodeConfig(
      input({ logBlocked: false, logQuery: false, logHeaders: [], logPeer: false }),
      1n,
    );
    expect(before.requiredFeatures).not.toContain(ACCESS_LOGS_V2_FEATURE);
    expect(off.requiredFeatures).toEqual(before.requiredFeatures);
    const [b] = before.sites;
    const [o] = off.sites;
    if (!b || !o) throw new Error("missing site");
    expect(toBinary(SiteSchema, o)).toEqual(toBinary(SiteSchema, b));
    expect(off.contentHash).toBe(before.contentHash);
  });
});

describe("content hash matches the Go agent (v0.30.0)", () => {
  it("encodes the v0.30.0 vector to the same canonical bytes and hash", () => {
    const raw = fromJson(NodeConfigSchema, vector.config);
    expect(raw.sites.map((s) => s.id)).toEqual(["b", "a"]);
    expect(raw.sites[1]?.logHeaders).toEqual(["x-trace-id", "accept-language"]);
    const config = canonicalize(raw);
    const a = config.sites[0];
    expect(a?.logHeaders).toEqual(["accept-language", "x-trace-id"]);
    expect([a?.logBlocked, a?.logQuery, a?.logPeer]).toEqual([true, true, true]);
    expect(config.requiredFeatures).toContain(ACCESS_LOGS_V2_FEATURE);
    const bare = clone(NodeConfigSchema, config);
    bare.revision = 0n;
    bare.contentHash = "";
    expect(Buffer.from(toBinary(NodeConfigSchema, bare)).toString("hex")).toBe(
      vector.canonical_hex,
    );
    expect(contentHash(config)).toBe(vector.content_hash);
  });

  it("compiles the v0.30.0 models into the vector's hash", () => {
    const config = compileNodeConfig(v0300Models(), 12n);
    expect(config.requiredFeatures).toEqual(["access-logs-v1", ACCESS_LOGS_V2_FEATURE, "tls-v1"]);
    expect(config.contentHash).toBe(vector.content_hash);
  });
});
