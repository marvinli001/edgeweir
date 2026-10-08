import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { clone, fromJson, type JsonValue, toBinary } from "@bufbuild/protobuf";
import { ClientCertificateMode, NodeConfigSchema } from "@edgeweir/proto";
import { parseExpression } from "@edgeweir/rule-engine";
import { describe, expect, it } from "vitest";
import {
  applyNodeConfigDiff,
  CLIENT_CERT_FEATURE,
  type CompileInput,
  canonicalize,
  compileNodeConfig,
  contentHash,
  diffNodeConfig,
  MULTI_CERTIFICATE_FEATURE,
  refreshDerived,
} from "../src/index";
import { certificate, site, tls } from "./v0230-models";
import { VECTOR_CLIENT_CA, v0260Models } from "./v0260-models";

// Same vector as edgeweir-node/internal/configir/testdata/content_hash_vector_v0260.json.
type Vector = { config: JsonValue; canonical_hex: string; content_hash: string };
const vectorV0260 = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "fixtures", "content_hash_vector_v0260.json"), "utf8"),
) as Vector;

const refs = (...ids: string[]) =>
  ids.map((id) => ({ ...certificate, id, sha256Fingerprint: id.padEnd(64, "0") })) as never;

const keys = [
  { id: "k2", role: "current" },
  { id: "k1", role: "previous" },
  { id: "k3", role: "next" },
];

describe("several certificates per site (multi-certificate-v1)", () => {
  it("keeps a site with one certificate encoded as before", () => {
    const base: CompileInput = {
      clusterId: "c1",
      certificates: refs("cert"),
      sites: [site("a", { certificateId: "cert", tls: tls() })],
    };
    const before = compileNodeConfig(base, 1n);
    const after = compileNodeConfig(
      {
        ...base,
        sites: [
          site("a", {
            certificateId: "cert",
            additionalCertificateIds: [],
            clientCertificate: null,
            tls: tls(),
          }),
        ],
      },
      1n,
    );
    expect(toBinary(NodeConfigSchema, after)).toEqual(toBinary(NodeConfigSchema, before));
    expect(after.requiredFeatures).not.toContain(MULTI_CERTIFICATE_FEATURE);
  });

  it("compiles the additional certificates in the site's order and requires the feature", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c1",
        certificates: refs("c-first", "z-second", "a-third"),
        sites: [
          site("a", {
            certificateId: "c-first",
            additionalCertificateIds: ["z-second", "a-third"],
            tls: tls(),
          }),
        ],
      },
      1n,
    );
    expect(config.sites[0]?.certificateId).toBe("c-first");
    expect(config.sites[0]?.additionalCertificateIds).toEqual(["z-second", "a-third"]);
    expect(config.requiredFeatures).toContain(MULTI_CERTIFICATE_FEATURE);
  });

  it("drops additional certificates of a site without a first one", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c1",
        certificates: refs("x"),
        sites: [site("a", { additionalCertificateIds: ["x"] })],
      },
      1n,
    );
    expect(config.sites[0]?.additionalCertificateIds).toEqual([]);
    expect(config.requiredFeatures).not.toContain(MULTI_CERTIFICATE_FEATURE);
  });

  it("keeps the references of additional certificates when derived parts are refreshed", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c1",
        certificates: refs("first", "second", "unused"),
        sites: [
          site("a", { certificateId: "first", additionalCertificateIds: ["second"], tls: tls() }),
        ],
      },
      1n,
    );
    const refreshed = refreshDerived(config);
    expect(refreshed.certificates.map((c) => c.id)).toEqual(["first", "second"]);
  });
});

describe("client certificates (client-cert-v1)", () => {
  it("compiles the mode, CA, depth and header forwarding", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c1",
        certificates: refs("cert"),
        sites: [
          site("a", {
            certificateId: "cert",
            clientCertificate: {
              mode: "optional",
              caPem: VECTOR_CLIENT_CA,
              depth: 3,
              forwardHeaders: false,
            },
            tls: tls(),
          }),
        ],
      },
      1n,
    );
    const client = config.sites[0]?.clientCertificate;
    expect(client?.mode).toBe(ClientCertificateMode.OPTIONAL);
    expect(client?.caPem).toBe(VECTOR_CLIENT_CA);
    expect(client?.depth).toBe(3);
    expect(client?.forwardHeaders).toBe(false);
    expect(config.requiredFeatures).toContain(CLIENT_CERT_FEATURE);
  });

  it("leaves client certificates out without a certificate", () => {
    const config = compileNodeConfig(
      {
        clusterId: "c1",
        sites: [
          site("a", {
            clientCertificate: {
              mode: "required",
              caPem: VECTOR_CLIENT_CA,
              depth: 2,
              forwardHeaders: true,
            },
          }),
        ],
      },
      1n,
    );
    expect(config.sites[0]?.clientCertificate).toBeUndefined();
    expect(config.requiredFeatures).not.toContain(CLIENT_CERT_FEATURE);
  });

  it("requires the feature for rules that read tls.client fields", () => {
    for (const source of [
      "tls.client.verified eq true",
      'tls.client.cert_sha256 ne ""',
      'tls.client.subject contains "OU=Ops"',
    ]) {
      const config = compileNodeConfig(
        {
          clusterId: "c1",
          sites: [
            site("a", {
              rules: [
                {
                  id: "r",
                  phase: "waf-custom",
                  expression: parseExpression(source, "waf-custom"),
                  action: { kind: "block", statusCode: 403 },
                },
              ],
            }),
          ],
        },
        1n,
      );
      expect(config.requiredFeatures, source).toContain(CLIENT_CERT_FEATURE);
    }
  });
});

describe("session ticket keys", () => {
  it("are compiled, sorted by id, only when a served site has a certificate", () => {
    const withTls = compileNodeConfig(
      {
        clusterId: "c1",
        certificates: refs("cert"),
        sites: [site("a", { certificateId: "cert", tls: tls() })],
        sessionTicketKeys: keys,
      },
      1n,
    );
    expect(withTls.sessionTicketKeys.map((k) => [k.id, k.role])).toEqual([
      ["k1", "previous"],
      ["k2", "current"],
      ["k3", "next"],
    ]);
    // No feature: older nodes ignore the keys and resume no sessions.
    expect(withTls.requiredFeatures).toEqual(["tls-v1"]);

    const plain: CompileInput = { clusterId: "c1", sites: [site("a")] };
    expect(
      toBinary(NodeConfigSchema, compileNodeConfig({ ...plain, sessionTicketKeys: keys }, 1n)),
    ).toEqual(toBinary(NodeConfigSchema, compileNodeConfig(plain, 1n)));

    const disabled = compileNodeConfig(
      {
        clusterId: "c1",
        certificates: refs("cert"),
        sites: [site("a", { enabled: false, certificateId: "cert", tls: tls() })],
        sessionTicketKeys: keys,
      },
      1n,
    );
    expect(disabled.sessionTicketKeys).toEqual([]);
  });

  it("are dropped when no site with a certificate remains and travel in diffs", () => {
    const base = compileNodeConfig(
      {
        clusterId: "c1",
        certificates: refs("cert"),
        sites: [site("a", { certificateId: "cert", tls: tls() })],
        sessionTicketKeys: keys,
      },
      1n,
    );
    const stripped = clone(NodeConfigSchema, base);
    stripped.sites = stripped.sites.map((s) => ({ ...s, certificateId: "", tls: undefined }));
    expect(refreshDerived(stripped).sessionTicketKeys).toEqual([]);

    const rotated = compileNodeConfig(
      {
        clusterId: "c1",
        certificates: refs("cert"),
        sites: [site("a", { certificateId: "cert", tls: tls() })],
        sessionTicketKeys: [
          { id: "k4", role: "next" },
          { id: "k3", role: "current" },
          { id: "k2", role: "previous" },
        ],
      },
      2n,
    );
    const diff = diffNodeConfig(base, rotated);
    expect(diff.sessionTicketKeys.map((k) => k.id)).toEqual(["k2", "k3", "k4"]);
    expect(diff.upsertedSites).toEqual([]);
    expect(applyNodeConfigDiff(base, diff).contentHash).toBe(rotated.contentHash);
  });
});

describe("content hash matches the Go agent (v0.26.0)", () => {
  it("encodes the v0.26.0 vector to the same canonical bytes and hash", () => {
    const raw = fromJson(NodeConfigSchema, vectorV0260.config);
    // Out of canonical order: sites and session ticket keys reversed.
    expect(raw.sites.map((s) => s.id)).toEqual(["b", "a"]);
    expect(raw.sessionTicketKeys.map((k) => k.id)).toEqual(["k3", "k2", "k1"]);
    const config = canonicalize(raw);
    // The site's order of its certificates is kept.
    expect(config.sites[0]?.additionalCertificateIds).toEqual(["cert-rsa", "cert-b"]);
    const bare = clone(NodeConfigSchema, config);
    bare.revision = 0n;
    bare.contentHash = "";
    expect(Buffer.from(toBinary(NodeConfigSchema, bare)).toString("hex")).toBe(
      vectorV0260.canonical_hex,
    );
    expect(contentHash(config)).toBe(vectorV0260.content_hash);
  });

  it("compiles the v0.26.0 models into the vector's hash", () => {
    const config = compileNodeConfig(v0260Models(), 12n);
    expect(config.requiredFeatures).toEqual([
      CLIENT_CERT_FEATURE,
      MULTI_CERTIFICATE_FEATURE,
      "rules-v1",
      "tls-v1",
    ]);
    expect(config.contentHash).toBe(vectorV0260.content_hash);
  });
});
