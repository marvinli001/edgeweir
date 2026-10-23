import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clone, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { ActiveHealthCheckType, NodeConfigSchema } from "@edgeweir/proto";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_HEALTH_FEATURE,
  ACTIVE_HEALTH_GRPC_FEATURE,
  canonicalize,
  compileNodeConfig,
  contentHash,
  ORIGIN_PROXY_PROTOCOL_FEATURE,
} from "../src/index";
import { v160Models } from "./v160-models";
import { site } from "./v0230-models";

// Same vector as edgeweir-node/internal/configir/testdata/content_hash_vector_v160.json.
type Vector = { config: JsonValue; canonical_hex: string; content_hash: string };
const vector = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures", "content_hash_vector_v160.json"), "utf8"),
) as Vector;

describe("PROXY protocol to origins and gRPC health checks (proto v1.6.0)", () => {
  it("keeps origins without PROXY protocol and HTTP checks encoded as before", () => {
    const model = site("a");
    const before = compileNodeConfig({ clusterId: "c", sites: [model] }, 1n);
    const explicit = compileNodeConfig(
      {
        clusterId: "c",
        sites: [
          {
            ...model,
            originPool: {
              ...model.originPool,
              origins: model.originPool.origins.map((o) => ({ ...o, proxyProtocolVersion: 0 })),
            },
          },
        ],
      },
      1n,
    );
    expect(toBinary(NodeConfigSchema, explicit)).toEqual(toBinary(NodeConfigSchema, before));
    const config = compileNodeConfig(v160Models(), 1n);
    const c = config.sites.find((s) => s.id === "c")?.originPool?.activeHealthCheck;
    expect(c?.type).toBe(ActiveHealthCheckType.UNSPECIFIED);
    expect(c?.grpcService).toBe("");
  });

  it("requires origin-proxy-protocol-v1 and active-health-grpc-v1 only when used", () => {
    const config = compileNodeConfig(v160Models(), 1n);
    expect(config.requiredFeatures).toEqual(
      [ACTIVE_HEALTH_FEATURE, ACTIVE_HEALTH_GRPC_FEATURE, ORIGIN_PROXY_PROTOCOL_FEATURE].sort(),
    );
    const models = v160Models();
    const [, , plain] = models.sites;
    const bare = compileNodeConfig({ clusterId: "c1", sites: plain ? [plain] : [] }, 1n);
    expect(bare.requiredFeatures).toEqual([ACTIVE_HEALTH_FEATURE]);
  });

  it("canonicalizes the vector's configuration to its bytes and hash", () => {
    const raw = fromJson(NodeConfigSchema, vector.config);
    expect(raw.sites.map((s) => s.id)).toEqual(["c", "b", "a"]);
    const config = canonicalize(raw);
    const bare = clone(NodeConfigSchema, config);
    bare.revision = 0n;
    bare.contentHash = "";
    expect(Buffer.from(toBinary(NodeConfigSchema, bare)).toString("hex")).toBe(
      vector.canonical_hex,
    );
    expect(contentHash(config)).toBe(vector.content_hash);
  });

  it("compiles the v1.6.0 models into the vector's hash", () => {
    expect(compileNodeConfig(v160Models(), 16n).contentHash).toBe(vector.content_hash);
  });
});
