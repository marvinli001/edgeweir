import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clone, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { DomainMatch, NodeConfigSchema } from "@edgeweir/proto";
import { describe, expect, it } from "vitest";
import {
  applyNodeConfigDiff,
  canonicalize,
  compileNodeConfig,
  compileUnknownHosts,
  contentHash,
  DOMAINS_V2_FEATURE,
  diffNodeConfig,
  edgeOf,
  refreshDerived,
  UNKNOWN_HOST_FEATURE,
  type UnknownHostsModel,
} from "../src/index";
import { certificate, site, tls } from "./v0230-models";
import { v0250Models } from "./v0250-models";

// Same vector as edgeweir-node/internal/configir/testdata/content_hash_vector_v0250.json.
type Vector = { config: JsonValue; canonical_hex: string; content_hash: string };
const vectorV0250 = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures", "content_hash_vector_v0250.json"), "utf8"),
) as Vector;

const handling = (extra: Partial<UnknownHostsModel> = {}): UnknownHostsModel => ({
  unknownHost: "page",
  ipAccess: "page",
  defaultSiteId: null,
  defaultCertificate: false,
  scanThreshold: 0,
  scanBanSeconds: 0,
  ...extra,
});

describe("domain forms (domains-v2) and unknown hosts (unknown-host-v1)", () => {
  it("keeps exact and wildcard domains and the default handling encoded as before", () => {
    const input = {
      clusterId: "c1",
      sites: [
        site("a", {
          domains: [
            { name: "a.test", wildcard: true },
            { name: "a.test", wildcard: false },
          ],
        }),
      ],
      edge: { httpPorts: [], httpsPorts: [], clientIp: null, unknownHosts: handling() },
    };
    const config = compileNodeConfig(input, 1n);
    const { edge: _, ...without } = input;
    expect(toBinary(NodeConfigSchema, config)).toEqual(
      toBinary(NodeConfigSchema, compileNodeConfig(without, 1n)),
    );
    expect(config.unknownHosts).toBeUndefined();
    expect(config.requiredFeatures).not.toContain(DOMAINS_V2_FEATURE);
    expect(config.requiredFeatures).not.toContain(UNKNOWN_HOST_FEATURE);
    expect(config.sites[0]?.domains.map((d) => [d.name, d.wildcard, d.match])).toEqual([
      ["a.test", false, DomainMatch.UNSPECIFIED],
      ["a.test", true, DomainMatch.UNSPECIFIED],
    ]);
  });

  it("compiles suffix and regex domains, offline hosts and the regex order", () => {
    const config = compileNodeConfig(v0250Models(), 1n);
    const a = config.sites.find((s) => s.id === "a");
    expect(a?.domains.map((d) => [d.name, d.wildcard, d.match, d.order])).toEqual([
      ["(www|m)\\.a\\.test", false, DomainMatch.REGEX, 1_791_417_600_000n * 16n],
      ["a.test", false, DomainMatch.UNSPECIFIED, 0n],
      ["a.test", true, DomainMatch.UNSPECIFIED, 0n],
      ["api\\d+\\.test", false, DomainMatch.REGEX, 1_791_417_600_000n * 16n + 1n],
      ["deep.test", false, DomainMatch.SUFFIX, 0n],
      ["z.test", false, DomainMatch.UNSPECIFIED, 0n],
    ]);
    expect(config.offlineHosts.map((h) => [h.name, h.match])).toEqual([
      ["off-[0-9]+\\.test", DomainMatch.REGEX],
      ["off.test", DomainMatch.UNSPECIFIED],
      ["off.test", DomainMatch.SUFFIX],
    ]);
    expect(config.requiredFeatures).toEqual(
      expect.arrayContaining([DOMAINS_V2_FEATURE, UNKNOWN_HOST_FEATURE]),
    );
  });

  it("requires domains-v2 for a suffix or pattern among the offline hosts alone", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c1",
        sites: [site("a")],
        offlineHosts: [{ name: "x.test", wildcard: false, match: "suffix", reason: "disabled" }],
      },
      1n,
    );
    expect(config.requiredFeatures).toContain(DOMAINS_V2_FEATURE);
  });

  it("never marks suffix or regex domains as wildcard or TLS-pending", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c1",
        certificates: [{ ...certificate } as never],
        sites: [
          site("a", {
            certificateId: "cert",
            tls: tls({ forceHttps: true, redirectExcludedDomains: ["a.test"] }),
            domains: [
              { name: "a.test", wildcard: true, match: "suffix", tlsPending: true },
              { name: "a.test", wildcard: false },
            ],
          }),
        ],
      },
      1n,
    );
    const domains = config.sites[0]?.domains ?? [];
    expect(domains.map((d) => [d.name, d.wildcard, d.tlsPending, d.match])).toEqual([
      ["a.test", false, false, DomainMatch.UNSPECIFIED],
      ["a.test", false, false, DomainMatch.SUFFIX],
    ]);
  });

  it("hands over to the default site only when it is compiled, with its certificate if any", () => {
    const sites = [
      { id: "a", certificateId: "cert" },
      { id: "b", certificateId: "" },
    ];
    expect(compileUnknownHosts(null, sites)).toBeUndefined();
    expect(compileUnknownHosts(handling(), sites)).toBeUndefined();
    // A missing (disabled or deleted) default site falls back to the page.
    expect(
      compileUnknownHosts(
        handling({ unknownHost: "site", ipAccess: "site", defaultSiteId: "gone" }),
        sites,
      ),
    ).toBeUndefined();
    const closed = compileUnknownHosts(
      handling({ unknownHost: "site", ipAccess: "close", defaultSiteId: "gone" }),
      sites,
    );
    expect([closed?.unknownHost, closed?.ipAccess, closed?.defaultSiteId]).toEqual([
      "page",
      "close",
      "",
    ]);
    const noCert = compileUnknownHosts(
      handling({ unknownHost: "site", defaultSiteId: "b", defaultCertificate: true }),
      sites,
    );
    expect([noCert?.unknownHost, noCert?.defaultSiteId, noCert?.defaultCertificate]).toEqual([
      "site",
      "b",
      false,
    ]);
    const ipOnly = compileUnknownHosts(
      handling({ ipAccess: "site", defaultSiteId: "a", defaultCertificate: true }),
      sites,
    );
    expect([ipOnly?.unknownHost, ipOnly?.ipAccess, ipOnly?.defaultCertificate]).toEqual([
      "page",
      "site",
      false,
    ]);
    const scan = compileUnknownHosts(
      handling({ scanThreshold: 100, scanBanSeconds: 3600, defaultSiteId: "a" }),
      sites,
    );
    expect([
      scan?.unknownHost,
      scan?.defaultSiteId,
      scan?.scanThreshold,
      scan?.scanBanSeconds,
    ]).toEqual(["page", "", 100, 3600]);
  });

  it("keeps the handling through diffs and takes the current one on refresh", () => {
    const config = compileNodeConfig(v0250Models(), 1n);
    const base = compileNodeConfig({ ...v0250Models(), edge: undefined }, 0n);
    expect(applyNodeConfigDiff(base, diffNodeConfig(base, config)).contentHash).toBe(
      config.contentHash,
    );
    expect(edgeOf(config).unknownHosts).toEqual({
      unknownHost: "site",
      ipAccess: "close",
      defaultSiteId: "a",
      defaultCertificate: true,
      scanThreshold: 100,
      scanBanSeconds: 3600,
    });
    expect(refreshDerived(config).contentHash).toBe(config.contentHash);
    const refreshed = refreshDerived(config, { ...edgeOf(config), unknownHosts: null });
    expect(refreshed.unknownHosts).toBeUndefined();
    expect(refreshed.requiredFeatures).not.toContain(UNKNOWN_HOST_FEATURE);
    // A rollback copy without the default site hands nothing over.
    const without = clone(NodeConfigSchema, config);
    without.sites = without.sites.filter((s) => s.id !== "a");
    expect(refreshDerived(without).unknownHosts?.unknownHost).toBe("page");
  });
});

describe("content hash matches the Go agent (v0.25.0)", () => {
  it("encodes the v0.25.0 vector to the same canonical bytes and hash", () => {
    const raw = fromJson(NodeConfigSchema, vectorV0250.config);
    // Out of canonical order: sites, domains and offline hosts reversed.
    expect(raw.sites.map((site) => site.id)).toEqual(["b", "a"]);
    expect(raw.sites[0]?.domains.map((d) => d.match)).toEqual([
      DomainMatch.UNSPECIFIED,
      DomainMatch.REGEX,
    ]);
    const config = canonicalize(raw);
    const bare = clone(NodeConfigSchema, config);
    bare.revision = 0n;
    bare.contentHash = "";
    expect(Buffer.from(toBinary(NodeConfigSchema, bare)).toString("hex")).toBe(
      vectorV0250.canonical_hex,
    );
    expect(contentHash(config)).toBe(vectorV0250.content_hash);
  });

  it("compiles the v0.25.0 models into the vector's hash", () => {
    const config = compileNodeConfig(v0250Models(), 12n);
    expect(config.requiredFeatures).toEqual([DOMAINS_V2_FEATURE, "tls-v1", UNKNOWN_HOST_FEATURE]);
    expect(config.contentHash).toBe(vectorV0250.content_hash);
  });
});
