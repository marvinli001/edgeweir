import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { tlsSettings } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { nodeCertificates } from "../../src/server/services/certificates";
import { latestRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
  PASSWORD,
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
  let tenant: ApiClient;
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
    const org = await api.organizations.create({ name: "Other", defaultClusterId: clusterId });
    await api.users.create({
      name: "Other",
      email: "other@secure.test",
      password: PASSWORD,
      organizationId: org.id,
    });
    tenant = rpcClient(app, origin, await signIn(app, origin, "other@secure.test"));
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
    ).toBe("CERTIFICATE_INVALID");
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
    expect(await tenant.certificates.list()).toEqual([]);
    expect((await rpcError(tenant.certificates.delete({ id: certificateId }))).code).toBe(
      "CERTIFICATE_NOT_FOUND",
    );
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
    expect((await rpcError(tenant.https.get({ id: siteId }))).code).toBe("SITE_NOT_FOUND");
    expect((await rpcError(api.certificates.delete({ id: certificateId }))).code).toBe(
      "CERTIFICATE_IN_USE",
    );
  });
  it("rejects a certificate for an unrelated hostname and unsupported protocol modules", async () => {
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
    expect(tlsSettings.safeParse({ brotli: true }).success).toBe(false);
    expect(tlsSettings.safeParse({ forceHttps: true }).success).toBe(false);
  });
  it("keeps DNS credentials write-only and bound to their organization", async () => {
    const credential = await api.dnsCredentials.create({
      name: "DNS",
      provider: "cloudflare",
      zone: "secure.test",
      credentials: { api_token: "unit-test-token" },
    });
    expect(JSON.stringify(await api.dnsCredentials.list())).not.toContain("unit-test-token");
    const [row] = await ctx.db
      .select()
      .from(schema.dnsCredential)
      .where(eq(schema.dnsCredential.id, credential.id));
    expect(row?.credentialEnvelope).not.toContain("unit-test-token");
    expect((await rpcError(tenant.dnsCredentials.delete({ id: credential.id }))).code).toBe(
      "DNS_CREDENTIAL_NOT_FOUND",
    );
  });
  it("refuses changing a bound site to a domain its certificate does not cover", async () => {
    const before = await latestRevision(ctx.db, clusterId);
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
