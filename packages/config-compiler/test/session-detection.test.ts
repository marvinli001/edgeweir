import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clone, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { NodeConfigSchema } from "@edgeweir/proto";
import { parseExpression } from "@edgeweir/rule-engine";
import { describe, expect, it } from "vitest";
import {
  applyNodeConfigDiff,
  canonicalize,
  compileNodeConfig,
  contentHash,
  decodeNodeConfig,
  diffNodeConfig,
  encodeNodeConfig,
  SESSION_DETECTION_FEATURE,
  usesChallengeKeys,
} from "../src/index";
import { sessionDetectionModels } from "./session-detection-models";
import { site, tls } from "./v0230-models";

// Same vector as edgeweir-node/internal/configir/testdata/content_hash_vector_session_detection.json.
type Vector = { config: JsonValue; canonical_hex: string; content_hash: string };
const vector = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "fixtures", "content_hash_vector_session_detection.json"),
    "utf8",
  ),
) as Vector;

const plain = () => compileNodeConfig({ clusterId: "c1", sites: [site("a", { tls: tls() })] }, 1n);

describe("session detection", () => {
  it("keeps sites without it encoded as before", () => {
    expect(plain().requiredFeatures).not.toContain(SESSION_DETECTION_FEATURE);
    expect(plain().sites[0]?.sessionDetection).toBeUndefined();
  });

  it("sends the mode and the interstitial rules in order and requires the feature", () => {
    const config = compileNodeConfig(sessionDetectionModels(), 1n);
    const a = config.sites.find((s) => s.id === "a");
    expect(a?.sessionDetection?.mode).toBe("enforce");
    expect(a?.sessionDetection?.interstitial).toBe(false);
    expect(
      a?.sessionDetection?.interstitialRules.map((r) => [r.host, r.pathPrefix, r.interstitial]),
    ).toEqual([
      ["www.a.test", "/checkout", true],
      ["api.a.test", "", false],
    ]);
    expect(config.sites.find((s) => s.id === "b")?.sessionDetection?.mode).toBe("monitor");
    expect(config.sites.find((s) => s.id === "c")?.sessionDetection).toBeUndefined();
    expect(config.requiredFeatures).toContain(SESSION_DETECTION_FEATURE);
    expect(config.requiredFeatures).toContain("challenge-v1");
  });

  it("needs the cluster's challenge keys to sign sessions", () => {
    const input = sessionDetectionModels();
    expect(usesChallengeKeys(input)).toBe(true);
    expect(usesChallengeKeys({ clusterId: "c1", sites: [site("a")] })).toBe(false);
    const disabled = { ...input, sites: input.sites.map((s) => ({ ...s, enabled: false })) };
    expect(usesChallengeKeys(disabled)).toBe(false);
  });

  it("requires the feature for rules that read the bot score", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c1",
        sites: [
          site("a", {
            rules: [
              {
                id: "r1",
                phase: "waf-custom",
                expression: parseExpression("http.request.bot.score lt 30", "waf-custom"),
                action: { kind: "block", statusCode: 403 },
              },
            ],
          }),
        ],
      },
      1n,
    );
    expect(config.requiredFeatures).toContain(SESSION_DETECTION_FEATURE);
  });

  it("sends it in diffs and round-trips it", () => {
    const target = compileNodeConfig(sessionDetectionModels(), 2n);
    const forward = applyNodeConfigDiff(plain(), diffNodeConfig(plain(), target));
    expect(forward.contentHash).toBe(target.contentHash);
    const decoded = decodeNodeConfig(encodeNodeConfig(target));
    expect(
      decoded.sites.find((s) => s.id === "a")?.sessionDetection?.interstitialRules,
    ).toHaveLength(2);
    expect(contentHash(decoded)).toBe(target.contentHash);
  });
});

describe("content hash vector (session detection)", () => {
  it("canonicalizes the vector's configuration to its bytes and hash", () => {
    const config = canonicalize(fromJson(NodeConfigSchema, vector.config));
    const bare = clone(NodeConfigSchema, config);
    bare.revision = 0n;
    bare.contentHash = "";
    expect(Buffer.from(toBinary(NodeConfigSchema, bare)).toString("hex")).toBe(
      vector.canonical_hex,
    );
    expect(contentHash(config)).toBe(vector.content_hash);
  });

  it("compiles the models into the vector's hash", () => {
    expect(compileNodeConfig(sessionDetectionModels(), 15n).contentHash).toBe(vector.content_hash);
  });
});
