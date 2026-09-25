import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clone, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { NodeConfigSchema } from "@edgeweir/proto";
import { describe, expect, it } from "vitest";
import { canonicalize, compileNodeConfig, contentHash } from "../src/index";

// Same vector as edgeweir-node/internal/configir/testdata/content_hash_vector.json,
// which the Go agent checks with proto.MarshalOptions{Deterministic: true}.
const vector = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures/content_hash_vector.json"), "utf8"),
) as { config: JsonValue; canonical_hex: string; content_hash: string };

describe("content hash matches the Go agent", () => {
  it("encodes the vector to the same canonical bytes and hash", () => {
    const config = canonicalize(fromJson(NodeConfigSchema, vector.config));
    const bare = clone(NodeConfigSchema, config);
    bare.revision = 0n;
    bare.contentHash = "";
    expect(Buffer.from(toBinary(NodeConfigSchema, bare)).toString("hex")).toBe(
      vector.canonical_hex,
    );
    expect(contentHash(config)).toBe(vector.content_hash);
  });

  it("compiles console models into the same hash", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c1",
        listeners: [{ port: 80, protocol: "http" }],
        cacheZones: [{ name: "default", maxSizeMb: 1024, keysZoneMb: 10, inactiveSeconds: 600 }],
        sites: [
          {
            id: "s1",
            name: "demo",
            enabled: true,
            cacheGeneration: 1,
            domains: [{ name: "demo.test", wildcard: false }],
            originPool: {
              id: "p1",
              policy: "weighted_random",
              origins: [
                {
                  id: "o1",
                  address: "whoami",
                  port: 80,
                  scheme: "http",
                  weight: 1,
                  backup: false,
                  hostHeader: "",
                  sni: "",
                },
              ],
            },
            cacheRules: [
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
          },
        ],
      },
      7n,
    );
    expect(config.contentHash).toBe(vector.content_hash);
  });
});
