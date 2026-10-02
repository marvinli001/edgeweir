import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { tlsSettings } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { certificateKeyBinding, nodeCertificates } from "../../src/server/services/certificates";
import { latestRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("M3 certificate lifecycle and isolation", async () => {
  const { ctx, client: db } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let api: ApiClient;
  let siteId: string;
  let clusterId: string;
  let certificateId: string;
  const material = await ctx.nodeCa.issueServerCertificate(["secure.test", "*.secure.test"]);
  beforeAll(async () => {
    await setupPlatform(ctx);
    api = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    const cluster = (await api.clusters.list())[0];
    if (!cluster) throw new Error("no cluster");
    clusterId = cluster.id;
    siteId = (
      await api.sites.create({
        name: "secure",
        domains: ["secure.test"],
        origins: [{ address: "origin.example.com" }],
      })
    ).site.id;
  });
  afterAll(() => db.close());
  it("validates the private key and encrypts it before storage", async () => {
    const other = await ctx.nodeCa.issueServerCertificate(["other.test"]);
    expect(
      (
        await rpcError(
          api.certificates.upload({
            name: "bad",
            chainPem: material.certificatePem,
            privateKeyPem: other.privateKeyPem,
          }),
        )
      ).code,
    ).toBe("CERTIFICATE_KEY_MISMATCH");
    const cert = await api.certificates.upload({
      name: "secure",
      chainPem: material.certificatePem,
      privateKeyPem: material.privateKeyPem,
    });
    certificateId = cert.id;
    expect(cert.names).toContain("secure.test");
    expect(JSON.stringify(cert)).not.toContain("PRIVATE KEY");
    const [row] = await ctx.db
      .select()
      .from(schema.certificate)
      .where(eq(schema.certificate.id, certificateId));
    expect(row?.privateKeyEnvelope).not.toContain("PRIVATE KEY");
    expect(row?.privateKeyEnvelope).not.toContain(material.privateKeyPem);
    expect((await rpcError(api.certificates.delete({ id: crypto.randomUUID() }))).code).toBe(
      "CERTIFICATE_NOT_FOUND",
    );
  });
  it("names what is wrong with an upload", async () => {
    const upload = (chainPem: string, privateKeyPem = material.privateKeyPem) =>
      rpcError(api.certificates.upload({ name: "bad", chainPem, privateKeyPem }));
    const day = 86_400_000;
    const garbled = material.certificatePem.replace(/\n[A-Za-z0-9+/]{8}/, "\n!!!!!!!!");
    expect((await upload(garbled)).code).toBe("CERTIFICATE_CHAIN_UNREADABLE");
    expect((await upload(material.certificatePem.repeat(11))).code).toBe(
      "CERTIFICATE_CHAIN_UNREADABLE",
    );
    const encrypted = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "x" },
    }).privateKey;
    expect((await upload(material.certificatePem, encrypted)).code).toBe(
      "CERTIFICATE_KEY_UNREADABLE",
    );
    // The CA certificate first, or an unrelated certificate as the issuer.
    expect((await upload(`${ctx.nodeCa.certificatePem}${material.certificatePem}`)).code).toBe(
      "CERTIFICATE_CHAIN_ORDER",
    );
    const other = await ctx.nodeCa.issueServerCertificate(["other.test"]);
    expect((await upload(`${material.certificatePem}${other.certificatePem}`)).code).toBe(
      "CERTIFICATE_CHAIN_ORDER",
    );
    const expired = await ctx.nodeCa.issueServerCertificate(
      ["secure.test"],
      new Date(Date.now() - 100 * day),
    );
    const outdated = await upload(expired.certificatePem, expired.privateKeyPem);
    expect(outdated).toMatchObject({
      code: "CERTIFICATE_NOT_CURRENTLY_VALID",
      data: {
        notBefore: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/),
        notAfter: expect.stringMatching(/ UTC$/),
      },
    });
    const ipOnly = await ctx.nodeCa.issueServerCertificate(["127.0.0.1"]);
    expect((await upload(ipOnly.certificatePem, ipOnly.privateKeyPem)).code).toBe(
      "CERTIFICATE_NO_DNS_NAMES",
    );
  });
  it("stores only the certificates and the key of an upload, never a key pasted into the chain", async () => {
    // A combined fullchain-and-key file pasted as the chain (audit 2026-10-01 P1-24).
    expect(
      (
        await rpcError(
          api.certificates.upload({
            name: "combined",
            chainPem: `${material.certificatePem}${material.privateKeyPem}`,
            privateKeyPem: material.privateKeyPem,
          }),
        )
      ).code,
    ).toBe("CERTIFICATE_CHAIN_FOREIGN_BLOCK");
    // Text around the blocks, and a key field that also holds the certificate.
    const cert = await api.certificates.upload({
      name: "annotated",
      chainPem: `subject=CN=secure.test\n${material.certificatePem}\n\n`,
      privateKeyPem: `${material.certificatePem}${material.privateKeyPem}`,
    });
    const [row] = await ctx.db
      .select()
      .from(schema.certificate)
      .where(eq(schema.certificate.id, cert.id));
    expect(row?.chainPem).toBe(new X509Certificate(material.certificatePem).toString());
    const key = ctx.masterKey
      .open(JSON.parse(row?.privateKeyEnvelope ?? ""), certificateKeyBinding(cert.id))
      .toString("utf8");
    expect(key).toMatch(
      /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END PRIVATE KEY-----\n$/,
    );
    await api.certificates.delete({ id: cert.id });
  });
  it("publishes HTTPS references and required capabilities without embedding secrets", async () => {
    await api.https.update({
      id: siteId,
      settings: tlsSettings.parse({ certificateId, forceHttps: true, hstsMaxAge: 3600 }),
    });
    const row = await latestRevision(ctx.db, clusterId);
    if (!row) throw new Error("no revision");
    const config = decodeNodeConfig(row.ir);
    expect(config.requiredFeatures).toContain("tls-v1");
    expect(config.listeners.some((l) => l.port === 443)).toBe(true);
    expect(config.certificates[0]?.sha256Fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(
      JSON.stringify(config, (_key, value) => (typeof value === "bigint" ? String(value) : value)),
    ).not.toContain("PRIVATE KEY");
    expect((await nodeCertificates(ctx, clusterId, [certificateId]))[0]?.privateKeyPem).toBe(
      material.privateKeyPem,
    );
    const foreign = await api.clusters.create({ name: "other-cluster" });
    expect(await nodeCertificates(ctx, foreign.id, [certificateId])).toEqual([]);
    expect((await rpcError(api.https.get({ id: crypto.randomUUID() }))).code).toBe(
      "SITE_NOT_FOUND",
    );
    expect((await rpcError(api.certificates.delete({ id: certificateId }))).code).toBe(
      "CERTIFICATE_IN_USE",
    );
  });
  it("rejects a certificate for an unrelated hostname and compression settings out of range", async () => {
    const site = await api.sites.create({
      name: "different",
      domains: ["different.test"],
      origins: [{ address: "origin.example.com" }],
    });
    expect(
      (
        await rpcError(
          api.https.update({ id: site.site.id, settings: tlsSettings.parse({ certificateId }) }),
        )
      ).code,
    ).toBe("CERTIFICATE_DOMAIN_MISMATCH");
    // A certificate that is not issued yet.
    const [pending] = await ctx.db
      .insert(schema.certificate)
      .values({ name: "pending", names: ["different.test"], source: "acme" })
      .returning();
    expect(
      (
        await rpcError(
          api.https.update({
            id: site.site.id,
            settings: tlsSettings.parse({ certificateId: pending?.id }),
          }),
        )
      ).code,
    ).toBe("CERTIFICATE_UNAVAILABLE");
    // Brotli and Zstandard are switches now, gated by node capabilities (waf.test.ts).
    expect(tlsSettings.safeParse({ brotli: true, brotliLevel: 12 }).success).toBe(false);
    expect(tlsSettings.safeParse({ zstd: true, zstdLevel: 0 }).success).toBe(false);
    expect(tlsSettings.safeParse({ forceHttps: true }).success).toBe(false);
  });
  it("keeps DNS credentials write-only", async () => {
    const credential = await api.dnsCredentials.create({
      name: "DNS",
      provider: "cloudflare",
      zone: "secure.test",
      credentials: { api_token: "unit-test-token-0123456789" },
    });
    expect(JSON.stringify(await api.dnsCredentials.list())).not.toContain("unit-test-token");
    const [row] = await ctx.db
      .select()
      .from(schema.dnsCredential)
      .where(eq(schema.dnsCredential.id, credential.id));
    expect(row?.credentialEnvelope).not.toContain("unit-test-token");
    expect((await rpcError(api.dnsCredentials.delete({ id: crypto.randomUUID() }))).code).toBe(
      "DNS_CREDENTIAL_NOT_FOUND",
    );
  });
  it("refuses changing a bound site to a domain its certificate does not cover", async () => {
    const before = await latestRevision(ctx.db, clusterId);
    // An uploaded certificate is never extended; the error names what it misses.
    expect(
      await rpcError(api.sites.update({ id: siteId, domains: ["secure.test", "uncovered.test"] })),
    ).toMatchObject({ code: "CERTIFICATE_DOMAIN_MISMATCH", data: { domains: "uncovered.test" } });
    expect(
      (await rpcError(api.sites.update({ id: siteId, domains: ["uncovered.test"] }))).code,
    ).toBe("CERTIFICATE_DOMAIN_MISMATCH");
    expect((await api.sites.get({ id: siteId })).domains).toEqual(["secure.test"]);
    expect((await latestRevision(ctx.db, clusterId))?.revision).toBe(before?.revision);
  });
  it("rejects DNS regions that can alter the provider URL", async () => {
    for (const region_id of ["cn-north-4@127.0.0.1/#", "../metadata", "cn-north-4/path"]) {
      expect(
        (
          await rpcError(
            api.dnsCredentials.create({
              name: "invalid",
              provider: "huaweicloud",
              zone: "secure.test",
              credentials: { access_key_id: "test", secret_access_key: "test", region_id },
            }),
          )
        ).code,
      ).toBe("DNS_CREDENTIAL_INVALID");
    }
  });
});
