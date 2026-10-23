import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clone, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { NodeConfigSchema } from "@edgeweir/proto";
import { describe, expect, it } from "vitest";
import {
  applyNodeConfigDiff,
  canonicalize,
  compileNodeConfig,
  contentHash,
  decodeNodeConfig,
  diffNodeConfig,
  encodeNodeConfig,
} from "../src/index";
import { encodedPathModels } from "./encoded-paths-models";
import { site, tls } from "./v0230-models";

// Same vector as edgeweir-node/internal/configir/testdata/content_hash_vector_encoded_paths.json.
type Vector = { config: JsonValue; canonical_hex: string; content_hash: string };
const vector = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "fixtures", "content_hash_vector_encoded_paths.json"),
    "utf8",
  ),
) as Vector;

const plain = () => compileNodeConfig({ clusterId: "c1", sites: [site("a", { tls: tls() })] }, 1n);

describe("encoded path exemptions", () => {
  it("keeps sites without exemptions encoded as before", () => {
    const empty = compileNodeConfig(
      { clusterId: "c1", sites: [site("a", { tls: tls(), encodedPathExemptions: [] })] },
      1n,
    );
    expect(empty.contentHash).toBe(plain().contentHash);
  });

  it("sends them sorted by prefix, without requiring a feature", () => {
    const config = compileNodeConfig(encodedPathModels(), 1n);
    const a = config.sites.find((s) => s.id === "a");
    expect(a?.encodedPathExemptions.map((e) => [e.prefix, e.encodedSlash, e.semicolon])).toEqual([
      ["/api/", false, true],
      ["/data/", true, true],
      ["/files/", true, false],
    ]);
    expect(config.requiredFeatures).toEqual(["tls-v1"]);
  });

  it("sends them in diffs and round-trips them", () => {
    const target = compileNodeConfig(encodedPathModels(), 2n);
    const forward = applyNodeConfigDiff(plain(), diffNodeConfig(plain(), target));
    expect(forward.contentHash).toBe(target.contentHash);
    const decoded = decodeNodeConfig(encodeNodeConfig(target));
    expect(decoded.sites.find((s) => s.id === "a")?.encodedPathExemptions).toHaveLength(3);
    expect(contentHash(decoded)).toBe(target.contentHash);
  });
});

describe("content hash vector (encoded path exemptions)", () => {
  it("canonicalizes the vector's configuration to its bytes and hash", () => {
    const raw = fromJson(NodeConfigSchema, vector.config);
    expect(raw.sites.map((s) => s.id)).toEqual(["b", "a"]);
    const config = canonicalize(raw);
    expect(config.sites[0]?.encodedPathExemptions.map((e) => e.prefix)).toEqual([
      "/api/",
      "/data/",
      "/files/",
    ]);
    const bare = clone(NodeConfigSchema, config);
    bare.revision = 0n;
    bare.contentHash = "";
    expect(Buffer.from(toBinary(NodeConfigSchema, bare)).toString("hex")).toBe(
      vector.canonical_hex,
    );
    expect(contentHash(config)).toBe(vector.content_hash);
  });

  it("compiles the models into the vector's hash", () => {
    expect(compileNodeConfig(encodedPathModels(), 14n).contentHash).toBe(vector.content_hash);
  });
});
