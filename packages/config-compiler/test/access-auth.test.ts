import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clone, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { AuthKind, NodeConfigSchema } from "@edgeweir/proto";
import { describe, expect, it } from "vitest";
import {
  ACCESS_AUTH_FEATURE,
  type AuthRuleModel,
  applyNodeConfigDiff,
  type CompileInput,
  canonicalize,
  compileNodeConfig,
  contentHash,
  diffNodeConfig,
} from "../src/index";
import { site, tls } from "./v0230-models";
import { v0270Models } from "./v0270-models";

// Same vector as edgeweir-node/internal/configir/testdata/content_hash_vector_v0270.json.
type Vector = { config: JsonValue; canonical_hex: string; content_hash: string };
const vector = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures", "content_hash_vector_v0270.json"), "utf8"),
) as Vector;

const url = (id: string, extra: Partial<AuthRuleModel> = {}): AuthRuleModel => ({
  id,
  kind: "url_b",
  scope: { domains: [], pathPrefixes: [], extensions: [], excludePathPrefixes: [] },
  credential: { id, version: 1 },
  url: { validitySeconds: 1800, skewSeconds: 300, signParam: "sign", timeParam: "t" },
  ...extra,
});

const input = (authRules?: AuthRuleModel[]): CompileInput => ({
  clusterId: "c1",
  sites: [site("a", { tls: tls(), ...(authRules ? { authRules } : {}) })],
});

describe("access authentication (access-auth-v1)", () => {
  it("keeps configurations without rules encoded as before", () => {
    const before = compileNodeConfig(input(), 1n);
    const empty = compileNodeConfig(input([]), 1n);
    expect(empty.contentHash).toBe(before.contentHash);
    expect(before.requiredFeatures).not.toContain(ACCESS_AUTH_FEATURE);
  });

  it("requires access-auth-v1 for a site with a rule", () => {
    const config = compileNodeConfig(input([url("r1")]), 1n);
    expect(config.requiredFeatures).toContain(ACCESS_AUTH_FEATURE);
    const rule = config.sites[0]?.authRules[0];
    expect(rule?.kind).toBe(AuthKind.URL_B);
    expect(rule?.credentialId).toBe("r1");
    expect(rule?.credentialVersion).toBe(1n);
  });

  it("keeps the rules' order and sorts their lists", () => {
    const config = compileNodeConfig(
      input([
        url("z", {
          scope: {
            domains: ["b.test", "a.test"],
            pathPrefixes: ["/b", "/a", "/a"],
            extensions: ["mp4", "jpg"],
            excludePathPrefixes: ["/y", "/x"],
          },
        }),
        url("a"),
      ]),
      1n,
    );
    const rules = config.sites[0]?.authRules ?? [];
    expect(rules.map((r) => r.id)).toEqual(["z", "a"]);
    expect(rules[0]?.domains).toEqual(["a.test", "b.test"]);
    expect(rules[0]?.pathPrefixes).toEqual(["/a", "/b"]);
    expect(rules[0]?.extensions).toEqual(["jpg", "mp4"]);
    expect(rules[0]?.excludePathPrefixes).toEqual(["/x", "/y"]);
  });

  it("puts only the secret's reference into the configuration", () => {
    const config = compileNodeConfig(v0270Models(), 1n);
    const json = JSON.stringify(
      config.sites.flatMap((s) => s.authRules),
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
    );
    expect(json).not.toMatch(/pbkdf2|hash|password|key"/i);
  });

  it("changes the site (and the hash) when a secret's version changes", () => {
    const base = compileNodeConfig(input([url("r1")]), 1n);
    const next = compileNodeConfig(
      input([url("r1", { credential: { id: "r1", version: 2 } })]),
      2n,
    );
    expect(next.contentHash).not.toBe(base.contentHash);
    const diff = diffNodeConfig(base, next);
    expect(diff.upsertedSites.map((s) => s.id)).toEqual(["a"]);
    expect(applyNodeConfigDiff(base, diff).contentHash).toBe(next.contentHash);
  });
});

describe("content hash matches the Go agent (v0.27.0)", () => {
  it("encodes the v0.27.0 vector to the same canonical bytes and hash", () => {
    const raw = fromJson(NodeConfigSchema, vector.config);
    expect(raw.sites.map((s) => s.id)).toEqual(["b", "a"]);
    const config = canonicalize(raw);
    // The site's order of its rules is kept; their lists are sorted.
    const rules = config.sites[0]?.authRules ?? [];
    expect(rules.map((r) => r.id)).toEqual(["r-basic", "r-forward", "r-url-a", "r-url-c"]);
    expect(rules[1]?.forward?.requestHeaders).toEqual(["authorization", "cookie", "x-token"]);
    const bare = clone(NodeConfigSchema, config);
    bare.revision = 0n;
    bare.contentHash = "";
    expect(Buffer.from(toBinary(NodeConfigSchema, bare)).toString("hex")).toBe(
      vector.canonical_hex,
    );
    expect(contentHash(config)).toBe(vector.content_hash);
  });

  it("compiles the v0.27.0 models into the vector's hash", () => {
    const config = compileNodeConfig(v0270Models(), 12n);
    expect(config.requiredFeatures).toEqual([ACCESS_AUTH_FEATURE, "tls-v1"]);
    expect(config.contentHash).toBe(vector.content_hash);
  });
});
