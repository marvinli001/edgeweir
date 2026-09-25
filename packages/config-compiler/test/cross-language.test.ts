import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clone, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { NodeConfigSchema } from "@edgeweir/proto";
import { describe, expect, it } from "vitest";
import { canonicalize, compileNodeConfig, contentHash } from "../src/index";

// Same vectors as edgeweir-node/internal/configir/testdata/content_hash_vector*.json,
// which the Go agent checks with proto.MarshalOptions{Deterministic: true}.
type Vector = { config: JsonValue; canonical_hex: string; content_hash: string };
const load = (name: string) =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, "fixtures", name), "utf8")) as Vector;
const vector = load("content_hash_vector.json");
const vectorM2 = load("content_hash_vector_m2.json");

describe("content hash matches the Go agent", () => {
  it.each([
    ["phase 0", vector],
    ["M2", vectorM2],
  ])("encodes the %s vector to the same canonical bytes and hash", (_, v) => {
    const config = canonicalize(fromJson(NodeConfigSchema, v.config));
    const bare = clone(NodeConfigSchema, config);
    bare.revision = 0n;
    bare.contentHash = "";
    expect(Buffer.from(toBinary(NodeConfigSchema, bare)).toString("hex")).toBe(v.canonical_hex);
    expect(contentHash(config)).toBe(v.content_hash);
  });

  it("compiles M2 console models (pools, S3, cache keys, rule conditions) into the same hash", () => {
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
              policy: "round_robin",
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
            cacheRules: [],
            cacheKey: {
              query: "ignore",
              queryParams: ["ignored-unless-include"],
              sortQuery: false,
              headers: [],
              cookies: [],
              deviceType: false,
              includeHost: true,
            },
          },
          {
            id: "s2",
            name: "bucket",
            enabled: true,
            cacheGeneration: 3,
            domains: [
              { name: "cdn.test", wildcard: true },
              { name: "bucket.test", wildcard: false },
            ],
            originPool: {
              id: "p2",
              policy: "consistent_hash",
              origins: [
                {
                  id: "o2",
                  address: "backup.example.com",
                  port: 443,
                  scheme: "https",
                  weight: 3,
                  backup: true,
                  hostHeader: "www.example.com",
                  sni: "origin.example.com",
                },
                {
                  id: "o3",
                  address: "minio",
                  port: 9000,
                  scheme: "http",
                  weight: 1,
                  backup: false,
                  hostHeader: "",
                  sni: "",
                  s3: {
                    region: "us-east-1",
                    bucket: "media",
                    credentialId: "cred-1",
                    credentialVersion: 2,
                  },
                },
              ],
              settings: {
                tlsVerify: false,
                maxFails: 2,
                recoverySeconds: 15,
                connectTimeoutMs: 1500,
                sendTimeoutMs: 60000,
                readTimeoutMs: 90000,
                keepalive: false,
                keepaliveIdleSeconds: 30,
                keepaliveMaxRequests: 500,
              },
            },
            cacheRules: [
              {
                id: "r3",
                priority: 20,
                pathPrefixes: [],
                extensions: ["PNG"],
                statusCodes: [404, 200, 404],
                minSizeBytes: 1,
                maxSizeBytes: 10485760,
                expression: "",
                action: "cache",
                edgeTtlSeconds: 3600,
                originCacheControl: "respect",
                staleWhileRevalidateSeconds: 30,
                staleIfErrorSeconds: 86400,
              },
              {
                id: "r2",
                priority: 10,
                pathPrefixes: ["/static/"],
                paths: ["/index.html"],
                extensions: [],
                expression: "",
                action: "bypass",
                edgeTtlSeconds: 0,
                originCacheControl: "override",
              },
            ],
            cacheKey: {
              query: "include",
              queryParams: ["v", "lang", "v"],
              sortQuery: true,
              headers: ["Accept-Language"],
              cookies: ["ab"],
              deviceType: true,
              includeHost: false,
            },
            rangeSlice: true,
            websocket: false,
          },
        ],
      },
      12n,
    );
    expect(config.contentHash).toBe(vectorM2.content_hash);
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
