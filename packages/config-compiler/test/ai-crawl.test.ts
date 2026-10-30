import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { clone, fromJson, type JsonValue, toBinary, toJson } from "@bufbuild/protobuf";
import { NodeConfigSchema } from "@edgeweir/proto";
import { describe, expect, it } from "vitest";
import {
  AI_CRAWLERS_FEATURE,
  canonicalize,
  compileNodeConfig,
  contentHash,
  usesChallenges,
} from "../src/index";
import { site } from "./v0230-models";
import { aiCrawlModels, crawlers, policy } from "./vnext-ai-crawl-models";

// Same vector as edgeweir-node/internal/configir/testdata/content_hash_vector_ai_crawl.json.
type Vector = { config: JsonValue; canonical_hex: string; content_hash: string };
const vectorPath = resolve(import.meta.dirname, "fixtures", "content_hash_vector_ai_crawl.json");

/** Writes the vector once (WRITE_VECTORS=1), from the models in canonical-reversed order. */
function writeVector() {
  const config = compileNodeConfig(aiCrawlModels(), 1n);
  const bare = clone(NodeConfigSchema, config);
  bare.revision = 0n;
  bare.contentHash = "";
  const raw = clone(NodeConfigSchema, bare);
  raw.sites.reverse();
  for (const c of raw.aiCrawlers?.crawlers ?? []) c.cidrs.reverse();
  raw.aiCrawlers?.crawlers.reverse();
  const vector: Vector = {
    config: toJson(NodeConfigSchema, raw),
    canonical_hex: Buffer.from(toBinary(NodeConfigSchema, bare)).toString("hex"),
    content_hash: config.contentHash,
  };
  writeFileSync(vectorPath, `${JSON.stringify(vector, null, 2)}\n`);
}
if (process.env.WRITE_VECTORS === "1" || !existsSync(vectorPath)) writeVector();
const vector = JSON.parse(readFileSync(vectorPath, "utf8")) as Vector;

describe("AI crawl control (proto vNEXT, ADR-0070)", () => {
  it("sends no catalogue without detection or a site policy", () => {
    const before = compileNodeConfig({ clusterId: "c", sites: [site("a")] }, 1n);
    const off = compileNodeConfig(
      { clusterId: "c", sites: [site("a")], aiCrawlers: { detection: false, crawlers } },
      1n,
    );
    expect(toBinary(NodeConfigSchema, off)).toEqual(toBinary(NodeConfigSchema, before));
  });

  it("sends the catalogue alone without a required feature", () => {
    const config = compileNodeConfig(
      { clusterId: "c", sites: [site("a")], aiCrawlers: { detection: true, crawlers } },
      1n,
    );
    expect(config.aiCrawlers?.crawlers.map((c) => c.id)).toEqual([
      "claudebot",
      "googlebot",
      "gptbot",
    ]);
    expect(config.requiredFeatures).not.toContain(AI_CRAWLERS_FEATURE);
    expect(config.sites[0]?.aiCrawl).toBeUndefined();
  });

  it("drops crawlers without tokens (robots.txt only)", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c",
        sites: [site("a")],
        aiCrawlers: {
          detection: true,
          crawlers: [
            ...crawlers,
            { id: "google-extended", operator: "google", tokens: [], cidrs: [], domains: [] },
          ],
        },
      },
      1n,
    );
    expect(config.aiCrawlers?.crawlers.map((c) => c.id)).not.toContain("google-extended");
  });

  it("compiles an inactive policy as none", () => {
    const config = compileNodeConfig(
      { clusterId: "c", sites: [site("a", { aiCrawl: policy() })] },
      1n,
    );
    expect(config.sites[0]?.aiCrawl).toBeUndefined();
    expect(config.requiredFeatures).not.toContain(AI_CRAWLERS_FEATURE);
  });

  it("requires ai-crawlers-v1 with a policy and sends the challenge only when one challenges", () => {
    const config = compileNodeConfig(aiCrawlModels(), 1n);
    expect(config.requiredFeatures).toContain(AI_CRAWLERS_FEATURE);
    const a = config.sites.find((s) => s.id === "a")?.aiCrawl;
    expect(a?.actions.map((x) => [x.crawler, x.action])).toEqual([
      ["claudebot", "charge"],
      ["googlebot", "allow"],
      ["gptbot", "block"],
    ]);
    expect(a?.challenge).toBe("");
    expect(a?.priceMicros).toBe(10000n);
    expect(a?.dynamicPricing).toBe(true);
    const challenging = { ...aiCrawlModels() };
    expect(usesChallenges(challenging)).toBe(false);
    expect(
      usesChallenges({
        clusterId: "c",
        sites: [site("a", { aiCrawl: policy({ actions: { gptbot: "challenge" } }) })],
      }),
    ).toBe(true);
    expect(
      usesChallenges({
        clusterId: "c",
        sites: [site("a", { aiCrawl: policy({ impersonators: "challenge" }) })],
      }),
    ).toBe(true);
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

  it("compiles the models into the vector's hash", () => {
    expect(compileNodeConfig(aiCrawlModels(), 16n).contentHash).toBe(vector.content_hash);
  });
});
