import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clone, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { NodeConfigSchema } from "@edgeweir/proto";
import { describe, expect, it } from "vitest";
import {
  applyNodeConfigDiff,
  canonicalize,
  compileNodeConfig,
  contentHash,
  DEVELOPMENT_MODE_FEATURE,
  decodeNodeConfig,
  diffNodeConfig,
  encodeNodeConfig,
} from "../src/index";
import { DEVELOPMENT_MODE_UNTIL, developmentModeModels } from "./development-mode-models";
import { site, tls } from "./v0230-models";

// Same vector as edgeweir-node/internal/configir/testdata/content_hash_vector_development_mode.json.
type Vector = { config: JsonValue; canonical_hex: string; content_hash: string };
const vector = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "fixtures", "content_hash_vector_development_mode.json"),
    "utf8",
  ),
) as Vector;

const plain = () => compileNodeConfig({ clusterId: "c1", sites: [site("a", { tls: tls() })] }, 1n);

describe("development mode", () => {
  it("keeps sites without it encoded as before", () => {
    const off = compileNodeConfig(
      { clusterId: "c1", sites: [site("a", { tls: tls(), developmentModeUntil: null })] },
      1n,
    );
    expect(off.contentHash).toBe(plain().contentHash);
    expect(off.requiredFeatures).not.toContain(DEVELOPMENT_MODE_FEATURE);
  });

  it("sends the deadline in whole seconds and requires development-mode-v1", () => {
    const config = compileNodeConfig(developmentModeModels(), 1n);
    const a = config.sites.find((s) => s.id === "a");
    const end = a?.developmentMode?.expiresAt;
    expect(end?.nanos).toBe(0);
    expect(end && timestampMs(end)).toBe(Date.parse("2026-11-01T03:00:00Z"));
    expect(end && timestampMs(end)).toBeLessThan(DEVELOPMENT_MODE_UNTIL.getTime());
    expect(config.sites.find((s) => s.id === "b")?.developmentMode).toBeUndefined();
    expect(config.requiredFeatures).toEqual([DEVELOPMENT_MODE_FEATURE, "tls-v1"]);
  });

  it("compiles a deadline that passed as it is (nodes treat it as off)", () => {
    const past = new Date("2020-01-01T00:00:00Z");
    const config = compileNodeConfig(
      { clusterId: "c1", sites: [site("a", { tls: tls(), developmentModeUntil: past })] },
      1n,
    );
    const end = config.sites[0]?.developmentMode?.expiresAt;
    expect(end && timestampMs(end)).toBe(past.getTime());
  });

  it("sends it in diffs, turns it off in diffs and round-trips it", () => {
    const target = compileNodeConfig(developmentModeModels(), 2n);
    const forward = applyNodeConfigDiff(plain(), diffNodeConfig(plain(), target));
    expect(forward.contentHash).toBe(target.contentHash);
    const back = applyNodeConfigDiff(target, diffNodeConfig(target, plain()));
    expect(back.sites.find((s) => s.id === "a")?.developmentMode).toBeUndefined();
    const decoded = decodeNodeConfig(encodeNodeConfig(target));
    expect(decoded.sites.find((s) => s.id === "a")?.developmentMode?.expiresAt).toBeDefined();
    expect(contentHash(decoded)).toBe(target.contentHash);
  });
});

describe("content hash vector (development mode)", () => {
  it("canonicalizes the vector's configuration to its bytes and hash", () => {
    const raw = fromJson(NodeConfigSchema, vector.config);
    expect(raw.sites.map((s) => s.id)).toEqual(["b", "a"]);
    const config = canonicalize(raw);
    const bare = clone(NodeConfigSchema, config);
    bare.revision = 0n;
    bare.contentHash = "";
    expect(Buffer.from(toBinary(NodeConfigSchema, bare)).toString("hex")).toBe(
      vector.canonical_hex,
    );
    expect(contentHash(config)).toBe(vector.content_hash);
  });

  it("compiles the models into the vector's hash", () => {
    expect(compileNodeConfig(developmentModeModels(), 15n).contentHash).toBe(vector.content_hash);
  });
});
