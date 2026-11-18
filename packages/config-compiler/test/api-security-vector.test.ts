import { readFileSync } from "node:fs";
import { clone, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { NodeConfigSchema } from "@edgeweir/proto";
import { expect, it } from "vitest";
import { canonicalize, contentHash } from "../src/index";

it("shares API policy bytes and content hash with Go", () => {
  const vector = JSON.parse(
    readFileSync(
      new URL("./fixtures/content_hash_vector_api_security.json", import.meta.url),
      "utf8",
    ),
  ) as { config: JsonValue; canonical_hex: string; content_hash: string };
  const config = fromJson(NodeConfigSchema, vector.config);
  expect(config.requiredFeatures).toContain("api-security-v1");
  expect(config.sites.some((site) => site.apiSecurityJson)).toBe(true);
  expect(contentHash(canonicalize(config))).toBe(vector.content_hash);
  const canonical = canonicalize(clone(NodeConfigSchema, config));
  canonical.contentHash = "";
  canonical.revision = 0n;
  expect(Buffer.from(toBinary(NodeConfigSchema, canonical)).toString("hex")).toBe(
    vector.canonical_hex,
  );
  const site = config.sites.find((candidate) => candidate.apiSecurityJson);
  if (!site) throw new Error("missing policy");
  const settings = JSON.parse(site.apiSecurityJson);
  settings.discovery.sampleRate = 10000;
  site.apiSecurityJson = JSON.stringify(settings);
  expect(contentHash(config)).not.toBe(vector.content_hash);
});
