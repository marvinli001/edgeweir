import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clone, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { NodeConfigSchema, OriginTlsTrust } from "@edgeweir/proto";
import { describe, expect, it } from "vitest";
import {
  applyNodeConfigDiff,
  type CompileInput,
  canonicalize,
  compileNodeConfig,
  contentHash,
  decodeNodeConfig,
  diffNodeConfig,
  encodeNodeConfig,
  ORIGIN_CA_FEATURE,
  ORIGIN_MTLS_FEATURE,
  OriginAuthorityMissingError,
  refreshDerived,
} from "../src/index";
import { protectedSite, VECTOR_ORIGIN_CA, VECTOR_ORIGIN_CRL, v130Models } from "./v130-models";
import { site, tls } from "./v0230-models";

// Same vector as edgeweir-node/internal/configir/testdata/content_hash_vector_v130.json.
type Vector = { config: JsonValue; canonical_hex: string; content_hash: string };
const vector = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures", "content_hash_vector_v130.json"), "utf8"),
) as Vector;

const clientCertificate = { id: "occ", names: [], sha256Fingerprint: "b".repeat(64) } as never;
const originCa = { certificatePem: VECTOR_ORIGIN_CA, crlPem: VECTOR_ORIGIN_CRL };

describe("origin protection (origin-mtls-v1, origin-ca-v1)", () => {
  it("keeps pools that trust the node's store and present nothing encoded as before", () => {
    const bare = compileNodeConfig({ clusterId: "c", sites: [protectedSite("a", {})] }, 1n);
    const explicit = compileNodeConfig(
      {
        clusterId: "c",
        sites: [protectedSite("a", { tlsTrust: "system" })],
        // Nothing presents or trusts them: neither is compiled.
        originClientCertificates: [clientCertificate],
        originCa,
      },
      1n,
    );
    expect(toBinary(NodeConfigSchema, explicit)).toEqual(toBinary(NodeConfigSchema, bare));
    expect(explicit.originClientCertificates).toEqual([]);
    expect(explicit.originCa).toBeUndefined();
    expect(explicit.requiredFeatures).not.toContain(ORIGIN_MTLS_FEATURE);
    expect(explicit.requiredFeatures).not.toContain(ORIGIN_CA_FEATURE);
  });

  it("compiles the client certificate a site presents and requires origin-mtls-v1", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c",
        sites: [protectedSite("a", { clientCertificateId: "occ" }), protectedSite("b", {})],
        originClientCertificates: [
          clientCertificate,
          { id: "unused", names: [], sha256Fingerprint: "c".repeat(64) } as never,
        ],
      },
      1n,
    );
    expect(config.sites[0]?.originPool?.clientCertificateId).toBe("occ");
    expect(config.sites[1]?.originPool?.clientCertificateId).toBe("");
    expect(config.originClientCertificates.map((c) => c.id)).toEqual(["occ"]);
    expect(config.requiredFeatures).toContain(ORIGIN_MTLS_FEATURE);
    expect(config.requiredFeatures).not.toContain(ORIGIN_CA_FEATURE);
    // A disabled site is not shipped: no certificate, no feature.
    const disabled = compileNodeConfig(
      {
        clusterId: "c",
        sites: [{ ...protectedSite("a", { clientCertificateId: "occ" }), enabled: false }],
        originClientCertificates: [clientCertificate],
      },
      1n,
    );
    expect(disabled.originClientCertificates).toEqual([]);
    expect(disabled.requiredFeatures).not.toContain(ORIGIN_MTLS_FEATURE);
  });

  it("refuses a client certificate the input does not carry", () => {
    expect(() =>
      compileNodeConfig(
        { clusterId: "c", sites: [protectedSite("a", { clientCertificateId: "occ" })] },
        1n,
      ),
    ).toThrow(OriginAuthorityMissingError);
  });

  it("compiles the Origin CA as the only trust with its CRL and requires origin-ca-v1", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c",
        sites: [protectedSite("a", { tlsTrust: "originCa" }), protectedSite("b", {})],
        originCa,
      },
      1n,
    );
    expect(config.sites[0]?.originPool?.tlsTrust).toBe(OriginTlsTrust.ORIGIN_CA);
    expect(config.sites[1]?.originPool?.tlsTrust).toBe(OriginTlsTrust.UNSPECIFIED);
    expect(config.originCa).toMatchObject({
      certificatePem: VECTOR_ORIGIN_CA,
      crlPem: VECTOR_ORIGIN_CRL,
    });
    expect(config.requiredFeatures).toContain(ORIGIN_CA_FEATURE);
    // Without verification there is no trust to compile.
    const unverified = compileNodeConfig(
      {
        clusterId: "c",
        sites: [protectedSite("a", { tlsTrust: "originCa", tlsVerify: false })],
        originCa,
      },
      1n,
    );
    expect(unverified.sites[0]?.originPool).toMatchObject({
      skipTlsVerify: true,
      tlsTrust: OriginTlsTrust.UNSPECIFIED,
    });
    expect(unverified.originCa).toBeUndefined();
    expect(unverified.requiredFeatures).not.toContain(ORIGIN_CA_FEATURE);
  });

  it("never falls back to the node's trust store when the Origin CA is missing", () => {
    expect(() =>
      compileNodeConfig(
        { clusterId: "c", sites: [protectedSite("a", { tlsTrust: "originCa" })] },
        1n,
      ),
    ).toThrow(OriginAuthorityMissingError);
  });

  it("drops what no site uses any more when deriving fields again", () => {
    const config = compileNodeConfig(v130Models(), 1n);
    expect(config.originClientCertificates.map((c) => c.id)).toEqual(["occ-2"]);
    const pruned = clone(NodeConfigSchema, config);
    for (const s of pruned.sites)
      if (s.originPool) {
        s.originPool.clientCertificateId = "";
        s.originPool.tlsTrust = OriginTlsTrust.UNSPECIFIED;
      }
    const refreshed = refreshDerived(pruned);
    expect(refreshed.originClientCertificates).toEqual([]);
    expect(refreshed.originCa).toBeUndefined();
    expect(refreshed.requiredFeatures).not.toContain(ORIGIN_MTLS_FEATURE);
    expect(refreshed.requiredFeatures).not.toContain(ORIGIN_CA_FEATURE);
    expect(refreshDerived(config).contentHash).toBe(config.contentHash);
  });

  it("sends both in full in diffs, and clears them", () => {
    const plain = compileNodeConfig({ clusterId: "c1", sites: [site("a", { tls: tls() })] }, 1n);
    const target = compileNodeConfig(v130Models(), 2n);
    const forward = applyNodeConfigDiff(plain, diffNodeConfig(plain, target));
    expect(forward.contentHash).toBe(target.contentHash);
    expect(forward.originCa?.crlPem).toBe(VECTOR_ORIGIN_CRL);
    expect(forward.originClientCertificates.map((c) => c.id)).toEqual(["occ-2"]);
    const back = applyNodeConfigDiff(target, diffNodeConfig(target, { ...plain, revision: 3n }));
    expect(back.originCa).toBeUndefined();
    expect(back.originClientCertificates).toEqual([]);
    expect(back.contentHash).toBe(plain.contentHash);
  });

  it("round-trips through the binary encoding", () => {
    const config = compileNodeConfig(v130Models(), 1n);
    const decoded = decodeNodeConfig(encodeNodeConfig(config));
    expect(decoded.originCa?.certificatePem).toBe(VECTOR_ORIGIN_CA);
    expect(decoded.sites.find((s) => s.id === "c")?.originPool).toMatchObject({
      clientCertificateId: "occ-2",
      tlsTrust: OriginTlsTrust.ORIGIN_CA,
    });
    expect(contentHash(decoded)).toBe(config.contentHash);
  });
});

describe("content hash vector v1.3.0", () => {
  it("canonicalizes the vector's configuration to its bytes and hash", () => {
    const raw = fromJson(NodeConfigSchema, vector.config);
    expect(raw.sites.map((s) => s.id)).toEqual(["d", "c", "b", "a"]);
    const config = canonicalize(raw);
    expect(config.originClientCertificates.map((c) => c.id)).toEqual(["occ-2"]);
    const bare = clone(NodeConfigSchema, config);
    bare.revision = 0n;
    bare.contentHash = "";
    expect(Buffer.from(toBinary(NodeConfigSchema, bare)).toString("hex")).toBe(
      vector.canonical_hex,
    );
    expect(contentHash(config)).toBe(vector.content_hash);
  });

  it("compiles the v1.3.0 models into the vector's hash", () => {
    const config = compileNodeConfig(v130Models() satisfies CompileInput, 13n);
    expect(config.requiredFeatures).toEqual([ORIGIN_CA_FEATURE, ORIGIN_MTLS_FEATURE, "tls-v1"]);
    expect(config.contentHash).toBe(vector.content_hash);
  });
});
