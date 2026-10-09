import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clone, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { NodeConfigSchema } from "@edgeweir/proto";
import { describe, expect, it } from "vitest";
import {
  ACCESS_CONTROL_FEATURE,
  type AccessControlModel,
  type CompileInput,
  canonicalize,
  compileNodeConfig,
  contentHash,
  nodeRequirements,
} from "../src/index";
import { site, tls } from "./v0230-models";
import { v0280Access, v0280Models } from "./v0280-models";

// Same vector as edgeweir-node/internal/configir/testdata/content_hash_vector_v0280.json.
type Vector = { config: JsonValue; canonical_hex: string; content_hash: string };
const vector = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures", "content_hash_vector_v0280.json"), "utf8"),
) as Vector;

const input = (accessControl?: AccessControlModel | null): CompileInput => ({
  clusterId: "c1",
  sites: [site("a", { tls: tls(), ...(accessControl !== undefined ? { accessControl } : {}) })],
});
const only = (part: Partial<AccessControlModel>): AccessControlModel => ({
  blockListIds: [],
  allowListIds: [],
  ...part,
});

describe("access control (access-control-v1)", () => {
  it("keeps configurations without access control encoded as before", () => {
    const before = compileNodeConfig(input(), 1n);
    expect(compileNodeConfig(input(null), 1n).contentHash).toBe(before.contentHash);
    expect(before.sites[0]?.accessControl).toBeUndefined();
    expect(before.requiredFeatures).not.toContain(ACCESS_CONTROL_FEATURE);
  });

  it("requires access-control-v1 and the GeoIP data geo access reads", () => {
    const security = only({ securityHeaders: v0280Access().securityHeaders });
    expect(compileNodeConfig(input(security), 1n).requiredFeatures).toEqual([
      ACCESS_CONTROL_FEATURE,
      "tls-v1",
    ]);
    const geo = (g: Partial<NonNullable<AccessControlModel["geo"]>>) =>
      compileNodeConfig(
        input(
          only({
            geo: {
              allowOnly: false,
              countries: [],
              subdivisions: [],
              asns: [],
              pathPrefixes: [],
              exceptPathPrefixes: [],
              ...g,
            },
          }),
        ),
        1n,
      );
    expect(geo({ countries: ["CN"] }).requiredFeatures).toContain("geoip-city-v1");
    expect(geo({ countries: ["CN"] }).requiredFeatures).not.toContain("geoip-asn-v1");
    expect(geo({ asns: [1] }).requiredFeatures).toContain("geoip-asn-v1");
    expect(geo({ asns: [1] }).requiredFeatures).not.toContain("geoip-city-v1");
    // Subdivisions need country data in the configuration and are checked by the console.
    const subdivision = geo({ subdivisions: ["US-CA"] });
    expect(subdivision.requiredFeatures).toContain("geoip-city-v1");
    expect(subdivision.requiredFeatures).not.toContain("geoip-subdivision-v1");
    expect(nodeRequirements(subdivision)).toContain("geoip-subdivision-v1");
    expect(nodeRequirements(geo({ countries: ["CN"] }))).not.toContain("geoip-subdivision-v1");
  });

  it("sorts the lists, keeping user agent rules and CORS methods in order", () => {
    const access = compileNodeConfig(v0280Models(), 1n).sites.find(
      (s) => s.id === "a",
    )?.accessControl;
    expect(access?.blockListIds).toEqual(["list-block-1", "list-block-2"]);
    expect(access?.hotlink?.denied).toEqual([".bad.test", "evil.test"]);
    expect(access?.hotlink?.extensions).toEqual(["jpg", "mp4", "png"]);
    expect(access?.userAgents?.rules.map((r) => r.pattern)).toEqual(["*", "*Googlebot*", ""]);
    expect(access?.cors?.allowedMethods).toEqual(["GET", "POST", "OPTIONS"]);
    expect(access?.geo?.asns).toEqual([64512, 64513]);
    expect(access?.websocket?.origins).toEqual(["https://app.test", "https://chat.app.test"]);
  });
});

describe("content hash matches the Go agent (v0.28.0)", () => {
  it("encodes the v0.28.0 vector to the same canonical bytes and hash", () => {
    const raw = fromJson(NodeConfigSchema, vector.config);
    expect(raw.sites.map((s) => s.id)).toEqual(["b", "a"]);
    const config = canonicalize(raw);
    const access = config.sites[0]?.accessControl;
    expect(access?.hotlink?.allowed).toEqual(["*.friend.test", "friend.test"]);
    expect(access?.userAgents?.rules.map((r) => r.allow)).toEqual([false, true, false]);
    const bare = clone(NodeConfigSchema, config);
    bare.revision = 0n;
    bare.contentHash = "";
    expect(Buffer.from(toBinary(NodeConfigSchema, bare)).toString("hex")).toBe(
      vector.canonical_hex,
    );
    expect(contentHash(config)).toBe(vector.content_hash);
  });

  it("compiles the v0.28.0 models into the vector's hash", () => {
    const config = compileNodeConfig(v0280Models(), 12n);
    expect(config.requiredFeatures).toEqual([
      ACCESS_CONTROL_FEATURE,
      "geoip-asn-v1",
      "geoip-city-v1",
      "tls-v1",
    ]);
    expect(config.contentHash).toBe(vector.content_hash);
  });
});
