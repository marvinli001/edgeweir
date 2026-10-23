import "reflect-metadata";
import { createPublicKey, webcrypto, X509Certificate } from "node:crypto";
import {
  decodeNodeConfig,
  ORIGIN_CA_FEATURE,
  ORIGIN_MTLS_FEATURE,
} from "@edgeweir/config-compiler";
import { ORIGIN_CLIENT_CERTIFICATE_DAYS } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { OriginTlsTrust } from "@edgeweir/proto";
import * as x509 from "@peculiar/x509";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import type { Envelope } from "../../src/server/lib/envelope";
import {
  nodeOriginClientCertificates,
  originClientKeyBinding,
  rotateOriginClientCertificates,
} from "../../src/server/services/origin-pki";
import { latestRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const DAY = 86_400_000;
const YEAR = 365 * DAY;

/** ECDSA with its curve, or Ed25519. */
type KeyAlgorithm = { name: string; namedCurve?: string };
type SignAlgorithm = Parameters<
  typeof x509.Pkcs10CertificateRequestGenerator.create
>[0]["signingAlgorithm"];

async function csr(algorithm: KeyAlgorithm, sign: SignAlgorithm) {
  const keys = (await webcrypto.subtle.generateKey(algorithm as never, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const request = await x509.Pkcs10CertificateRequestGenerator.create({
    name: "CN=ignored.example",
    keys: keys as never,
    signingAlgorithm: sign,
  });
  return request.toString("pem");
}

/** The CSR with the last byte of its signature changed. */
function tampered(pem: string) {
  const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
  der[der.length - 1] = (der[der.length - 1] ?? 0) ^ 0x01;
  return `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString("base64")}\n-----END CERTIFICATE REQUEST-----\n`;
}

describe("origin protection: client CA, Origin CA and the sites using them", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let siteId: string;
  let nodeId: string;
  const config = async () =>
    decodeNodeConfig((await latestRevision(ctx.db, clusterId))?.ir ?? new Uint8Array());
  const audits = (action: string) =>
    ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, action as never));

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = (
      await admin.sites.create({
        name: "protected",
        domains: ["protected.example.test"],
        origins: [{ address: "origin.internal.test", scheme: "https", port: 443 }],
      })
    ).site.id;
    const [node] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-protect",
        supportedFeatures: ["tls-v1", "rules-v1", "access-logs-v1"],
        enrolledAt: new Date(Date.now() - DAY),
        lastSeenAt: new Date(),
      })
      .returning();
    nodeId = node?.id ?? "";
  });
  afterAll(() => pglite.close());

  it("has neither authority until the operator creates it, once", async () => {
    expect((await admin.originCa.get()).authority).toBeNull();
    expect(await admin.originClientCa.get()).toEqual({
      authority: null,
      next: null,
      previous: null,
      trustBundlePem: "",
      certificates: [],
      pendingClusters: [],
    });
    const created = await admin.originCa.create();
    const again = await admin.originCa.create();
    expect(again.authority?.fingerprint).toBe(created.authority?.fingerprint);
    expect(await audits("origin_ca.create")).toHaveLength(1);
    const ca = new X509Certificate(created.authority?.certificatePem ?? "");
    expect(ca.ca).toBe(true);
    expect(ca.subject).toContain("CN=Edgeweir Origin CA");
    expect(ca.publicKey.asymmetricKeyDetails?.namedCurve).toBe("prime256v1");
    const lifetime = Date.parse(ca.validTo) - Date.parse(ca.validFrom);
    expect(Math.round(lifetime / YEAR)).toBe(20);

    const client = await admin.originClientCa.create();
    await admin.originClientCa.create();
    expect(await audits("origin_client_ca.create")).toHaveLength(1);
    const clientCa = new X509Certificate(client.authority?.certificatePem ?? "");
    expect(clientCa.subject).toContain("CN=Edgeweir Origin Client CA");
    expect(clientCa.fingerprint256).not.toBe(ca.fingerprint256);
    expect(Math.round((Date.parse(clientCa.validTo) - Date.parse(clientCa.validFrom)) / YEAR)).toBe(
      10,
    );
    // Neither is the node channel's CA.
    expect(clientCa.fingerprint256.replaceAll(":", "").toLowerCase()).not.toBe(
      ctx.nodeCa.fingerprintSha256,
    );
  });

  it("issues origin certificates with a key shown once or from a CSR", async () => {
    const ca = new X509Certificate((await admin.originCa.get()).authority?.certificatePem ?? "");
    const issued = await admin.originCertificates.issue({
      hostnames: ["origin.example.com", "*.origin.example.com", "192.0.2.10", "origin.example.com"],
    });
    const cert = new X509Certificate(issued.certificatePem);
    expect(issued.hostnames).toEqual(["origin.example.com", "*.origin.example.com", "192.0.2.10"]);
    expect(cert.subjectAltName).toBe(
      "DNS:origin.example.com, DNS:*.origin.example.com, IP Address:192.0.2.10",
    );
    expect(cert.ca).toBe(false);
    expect(cert.keyUsage).toEqual(["1.3.6.1.5.5.7.3.1"]);
    expect(cert.verify(ca.publicKey)).toBe(true);
    expect(cert.checkIssued(ca)).toBe(true);
    expect(Math.round((Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / YEAR)).toBe(15);
    expect(issued).toMatchObject({ keyType: "ec256", source: "generated", revokedAt: null });
    expect(issued.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    expect(createPublicKey(issued.privateKeyPem).export({ type: "spki", format: "der" })).toEqual(
      cert.publicKey.export({ type: "spki", format: "der" }),
    );
    // The private key is neither stored nor audited.
    const [row] = await ctx.db
      .select()
      .from(schema.originCertificate)
      .where(eq(schema.originCertificate.id, issued.id));
    expect(JSON.stringify(row)).not.toContain("PRIVATE KEY");
    const [audit] = await audits("origin_certificate.issue");
    expect(JSON.stringify(audit)).not.toContain("PRIVATE KEY");
    expect(audit?.metadata).toMatchObject({ serial: issued.serial, source: "generated" });

    const rsa = await admin.originCertificates.issue({
      hostnames: ["rsa.example.com"],
      keyType: "rsa2048",
      validityYears: 1,
    });
    const rsaCert = new X509Certificate(rsa.certificatePem);
    expect(rsaCert.publicKey.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(Math.round((Date.parse(rsaCert.validTo) - Date.parse(rsaCert.validFrom)) / DAY)).toBe(
      365,
    );

    const fromCsr = await admin.originCertificates.issue({
      hostnames: ["csr.example.com"],
      keyType: "rsa2048",
      csrPem: await csr({ name: "ECDSA", namedCurve: "P-384" }, {
        name: "ECDSA",
        hash: "SHA-384",
      } as SignAlgorithm),
    });
    expect(fromCsr).toMatchObject({ keyType: "ec384", source: "csr", privateKeyPem: "" });
    // The CSR supplies the key only: names come from the request.
    expect(new X509Certificate(fromCsr.certificatePem).subjectAltName).toBe("DNS:csr.example.com");

    for (const bad of [
      "not a CSR",
      await csr({ name: "Ed25519" } as never, { name: "Ed25519" }),
      // A CSR whose signature does not match its key.
      tampered(
        await csr({ name: "ECDSA", namedCurve: "P-256" }, {
          name: "ECDSA",
          hash: "SHA-256",
        } as SignAlgorithm),
      ),
    ])
      expect(
        (
          await rpcError(
            admin.originCertificates.issue({ hostnames: ["bad.example.com"], csrPem: bad }),
          )
        ).code,
      ).toBe("ORIGIN_CERTIFICATE_CSR_INVALID");
    expect((await rpcError(admin.originCertificates.issue({ hostnames: ["no host"] }))).code).toBe(
      "BAD_REQUEST",
    );
    expect((await admin.originCertificates.list()).map((c) => c.id)).toContain(issued.id);
  });

  it("never serves an Origin CA certificate to visitors", async () => {
    const issued = await admin.originCertificates.issue({ hostnames: ["edge.example.com"] });
    const error = await rpcError(
      admin.certificates.upload({
        name: "origin",
        chainPem: issued.certificatePem,
        privateKeyPem: issued.privateKeyPem,
      }),
    );
    expect(error.code).toBe("CERTIFICATE_ORIGIN_CA");
  });

  it("checks the trust and client certificate of a pool", async () => {
    const site = await admin.sites.get({ id: siteId });
    const update = (settings: Partial<typeof site.originSettings>) =>
      admin.sites.update({ id: siteId, originSettings: { ...site.originSettings, ...settings } });
    expect(site.originSettings).toMatchObject({ tlsTrust: "system", clientCertificate: false });
    expect((await rpcError(update({ tlsTrust: "originCa", tlsVerify: false }))).code).toBe(
      "ORIGIN_TLS_TRUST_REQUIRES_VERIFY",
    );
    const s3 = await admin.sites.create({
      name: "bucket",
      domains: ["bucket.example.test"],
      origins: [
        {
          address: "s3.example.com",
          scheme: "https",
          s3: {
            region: "us-east-1",
            bucket: "media",
            accessKeyId: "AKEXAMPLE",
            secretAccessKey: "x",
          },
        },
      ],
    });
    expect(
      (
        await rpcError(
          admin.sites.update({
            id: s3.site.id,
            originSettings: { ...s3.site.originSettings, tlsTrust: "originCa" },
          }),
        )
      ).code,
    ).toBe("ORIGIN_CA_S3");
    await admin.sites.delete({ id: s3.site.id });
  });

  it("compiles the Origin CA as the site's only trust, kept when omitted", async () => {
    const site = await admin.sites.get({ id: siteId });
    await admin.sites.update({
      id: siteId,
      originSettings: { ...site.originSettings, tlsTrust: "originCa" },
    });
    const ca = (await admin.originCa.get()).authority;
    let compiled = await config();
    expect(compiled.sites.find((s) => s.id === siteId)?.originPool?.tlsTrust).toBe(
      OriginTlsTrust.ORIGIN_CA,
    );
    expect(compiled.originCa?.certificatePem).toBe(ca?.certificatePem);
    // The label OpenSSL reads (nginx's proxy_ssl_crl).
    expect(compiled.originCa?.crlPem).toMatch(/^-----BEGIN X509 CRL-----\n/);
    expect(compiled.requiredFeatures).toContain(ORIGIN_CA_FEATURE);
    // An update that omits it keeps it.
    const { tlsTrust: _trust, clientCertificate: _client, ...rest } = site.originSettings;
    await admin.sites.update({ id: siteId, originSettings: { ...rest, maxFails: 4 } });
    compiled = await config();
    expect(compiled.sites.find((s) => s.id === siteId)?.originPool?.tlsTrust).toBe(
      OriginTlsTrust.ORIGIN_CA,
    );
  });

  it("revokes into the CRL every trusting cluster gets, and never again", async () => {
    const issued = await admin.originCertificates.issue({ hostnames: ["revoke.example.com"] });
    const before = await latestRevision(ctx.db, clusterId);
    const revoked = await admin.originCertificates.revoke({ id: issued.id });
    expect(revoked.revokedAt).not.toBeNull();
    const after = await latestRevision(ctx.db, clusterId);
    expect(after?.revision).toBe((before?.revision ?? 0) + 1);
    expect(after?.reasonCode).toBe("origin_certificate_revoked");
    const crl = new x509.X509Crl((await config()).originCa?.crlPem ?? "");
    const ca = new x509.X509Certificate(
      (await admin.originCa.get()).authority?.certificatePem ?? "",
    );
    expect(await crl.verify({ publicKey: ca.publicKey })).toBe(true);
    expect(crl.issuer).toBe(ca.subject);
    expect(crl.entries.map((e) => e.serialNumber.toLowerCase())).toContain(issued.serial);
    expect(crl.nextUpdate?.getTime()).toBe(ca.notAfter.getTime());
    expect((await rpcError(admin.originCertificates.revoke({ id: issued.id }))).code).toBe(
      "ORIGIN_CERTIFICATE_REVOKED",
    );
    expect(
      (
        await rpcError(
          admin.originCertificates.revoke({ id: "00000000-0000-4000-8000-000000000000" }),
        )
      ).code,
    ).toBe("ORIGIN_CERTIFICATE_NOT_FOUND");
  });

  it("keeps revocations when rolling back", async () => {
    const issued = await admin.originCertificates.issue({ hostnames: ["rollback.example.com"] });
    const target = (await latestRevision(ctx.db, clusterId))?.revision ?? 0;
    await admin.originCertificates.revoke({ id: issued.id });
    await admin.clusters.rollback({ id: clusterId, revision: target });
    const crl = new x509.X509Crl((await config()).originCa?.crlPem ?? "");
    expect(crl.entries.map((e) => e.serialNumber.toLowerCase())).toContain(issued.serial);
  });

  it("presents the cluster's client certificate, issued on first use", async () => {
    const site = await admin.sites.get({ id: siteId });
    await admin.sites.update({
      id: siteId,
      originSettings: { ...site.originSettings, clientCertificate: true },
    });
    const [cert] = await ctx.db
      .select()
      .from(schema.originClientCertificate)
      .where(eq(schema.originClientCertificate.clusterId, clusterId));
    expect(cert).toBeDefined();
    const compiled = await config();
    expect(compiled.sites.find((s) => s.id === siteId)?.originPool?.clientCertificateId).toBe(
      cert?.id,
    );
    expect(compiled.originClientCertificates).toMatchObject([
      { id: cert?.id, sha256Fingerprint: cert?.fingerprint },
    ]);
    expect(compiled.requiredFeatures).toContain(ORIGIN_MTLS_FEATURE);
    const leaf = new X509Certificate(cert?.chainPem ?? "");
    const clientCa = new X509Certificate(
      (await admin.originClientCa.get()).authority?.certificatePem ?? "",
    );
    expect(leaf.checkIssued(clientCa)).toBe(true);
    expect(leaf.subject).toContain(`CN=${clusterId}`);
    expect(leaf.keyUsage).toEqual(["1.3.6.1.5.5.7.3.2"]);
    expect(Math.round((Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)) / DAY)).toBe(
      ORIGIN_CLIENT_CERTIFICATE_DAYS,
    );
    // The key is sealed to its row.
    const key = ctx.masterKey
      .open(
        JSON.parse(cert?.privateKeyEnvelope ?? "") as Envelope,
        originClientKeyBinding(cert?.id ?? ""),
      )
      .toString("utf8");
    expect(createPublicKey(key).export({ type: "spki", format: "der" })).toEqual(
      leaf.publicKey.export({ type: "spki", format: "der" }),
    );
    expect((await admin.originClientCa.get()).certificates).toMatchObject([
      { id: cert?.id, clusterId },
    ]);
  });

  it("hands the key only to nodes of a cluster whose revisions reference it", async () => {
    const [cert] = await ctx.db
      .select()
      .from(schema.originClientCertificate)
      .where(eq(schema.originClientCertificate.clusterId, clusterId));
    const ids = [cert?.id ?? ""];
    const [material] = await nodeOriginClientCertificates(ctx, clusterId, ids);
    expect(material).toMatchObject({ id: cert?.id, sha256Fingerprint: cert?.fingerprint });
    expect(material?.privateKeyPem).toContain("BEGIN PRIVATE KEY");
    const other = await admin.clusters.create({ name: "elsewhere" });
    expect(await nodeOriginClientCertificates(ctx, other.id, ids)).toEqual([]);
  });

  it("replaces the certificate 30 days before it expires and deletes expired ones", async () => {
    const [current] = await ctx.db
      .select()
      .from(schema.originClientCertificate)
      .where(eq(schema.originClientCertificate.clusterId, clusterId));
    const early = new Date((current?.notAfter.getTime() ?? 0) - 31 * DAY);
    expect(await rotateOriginClientCertificates(ctx, early)).toEqual([]);
    const due = new Date((current?.notAfter.getTime() ?? 0) - 29 * DAY);
    expect(await rotateOriginClientCertificates(ctx, due)).toEqual([clusterId]);
    const latest = await latestRevision(ctx.db, clusterId);
    expect(latest?.reasonCode).toBe("origin_client_certificate_rotated");
    const rows = await ctx.db
      .select()
      .from(schema.originClientCertificate)
      .where(eq(schema.originClientCertificate.clusterId, clusterId));
    expect(rows).toHaveLength(2);
    const compiled = await config();
    const replacement = rows.find((r) => r.id !== current?.id);
    expect(compiled.originClientCertificates.map((c) => c.id)).toEqual([replacement?.id]);
    // The earlier one stays for nodes still on earlier revisions until a week after it expired.
    const later = new Date((current?.notAfter.getTime() ?? 0) + 8 * DAY);
    await rotateOriginClientCertificates(ctx, later);
    const kept = await ctx.db
      .select({ id: schema.originClientCertificate.id })
      .from(schema.originClientCertificate)
      .where(
        and(
          eq(schema.originClientCertificate.clusterId, clusterId),
          eq(schema.originClientCertificate.id, current?.id ?? ""),
        ),
      );
    expect(kept).toEqual([]);
  });

  it("locks the settings while the cluster's nodes lack the features", async () => {
    // A site that has them on can still turn them off; the node lacks both.
    const features = await admin.sites.features({ id: siteId });
    expect(features.originMtls).toEqual({ available: false, reason: "nodes" });
    expect(features.originCa).toEqual({ available: false, reason: "nodes" });
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: ["tls-v1", ORIGIN_MTLS_FEATURE, ORIGIN_CA_FEATURE] })
      .where(eq(schema.node.id, nodeId));
    const now = await admin.sites.features({ id: siteId });
    expect(now.originMtls.available).toBe(true);
    expect(now.originCa.available).toBe(true);
  });
});
