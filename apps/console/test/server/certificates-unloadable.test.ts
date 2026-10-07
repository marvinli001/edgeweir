import { createPrivateKey, X509Certificate } from "node:crypto";
import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { tlsSettings } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { systemActor } from "../../src/server/services/audit";
import {
  bindIssuedCertificate,
  certificateKeyBinding,
  markUnloadableCertificates,
} from "../../src/server/services/certificates";
import { latestRevision, publishRevision } from "../../src/server/services/revisions";
import { EXPLICIT_EC_FIXTURE } from "./fixtures";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

// Uploads stored before EC keys with explicit curve parameters were refused
// (inspectCertificate): nodes cannot load them, and a revision that carries
// one is applied on no node of its cluster.
describe("stored certificates nodes cannot load", async () => {
  const { ctx, client: db } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let api: ApiClient;
  let clusterId: string;
  let siteId: string;
  const { pkcs8Key, certificate, namedCertificate } = EXPLICIT_EC_FIXTURE;
  const namedKey = createPrivateKey({
    key: createPrivateKey(pkcs8Key).export({ format: "jwk" }),
    format: "jwk",
  })
    .export({ type: "pkcs8", format: "pem" })
    .toString();
  /** An upload as the console stored it before: re-encoded, the curves unchecked. */
  const stored = async (
    name: string,
    chainPem: string,
    privateKeyPem: string,
    values: Partial<typeof schema.certificate.$inferInsert> = {},
  ) => {
    const id = crypto.randomUUID();
    const leaf = new X509Certificate(chainPem);
    const key = createPrivateKey(privateKeyPem).export({ type: "pkcs8", format: "pem" });
    await ctx.db.insert(schema.certificate).values({
      id,
      name,
      names: ["explicit.test"],
      source: "upload",
      status: "ready",
      chainPem: leaf.toString(),
      privateKeyEnvelope: JSON.stringify(
        ctx.masterKey.seal(key.toString(), certificateKeyBinding(id)),
      ),
      fingerprint: leaf.fingerprint256.replaceAll(":", "").toLowerCase(),
      notBefore: new Date(leaf.validFrom),
      notAfter: new Date(leaf.validTo),
      ...values,
    });
    return id;
  };
  /** A binding made before the check, published as it was then. */
  const boundBefore = async (certificateId: string) => {
    await ctx.db.update(schema.site).set({ certificateId }).where(eq(schema.site.id, siteId));
    await ctx.db.transaction((tx) =>
      publishRevision(tx, {
        clusterId,
        reason: { code: "certificate_updated", params: { site: "explicit" } },
        actor: systemActor,
      }),
    );
    return (await latestRevision(ctx.db, clusterId))?.revision ?? 0;
  };
  const row = async (id: string) =>
    (await ctx.db.select().from(schema.certificate).where(eq(schema.certificate.id, id)))[0];
  let chainBad = "";
  let keyBad = "";
  let named = "";

  beforeAll(async () => {
    await setupPlatform(ctx);
    api = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await api.clusters.list())[0]?.id ?? "";
    siteId = (
      await api.sites.create({
        name: "explicit",
        domains: ["explicit.test"],
        origins: [{ address: "origin.example.com" }],
      })
    ).site.id;
    // The certificate and the key spell out the curve; or only the key does.
    chainBad = await stored("explicit chain", certificate, pkcs8Key);
    keyBad = await stored("explicit key", namedCertificate, pkcs8Key);
    named = await stored("named", namedCertificate, namedKey);
  });
  afterAll(() => db.close());

  it("refuses binding them, also to a site that has one already", async () => {
    const update = (certificateId: string) =>
      api.https.update({
        id: siteId,
        settings: tlsSettings.parse({ certificateId, forceHttps: true }),
      });
    const before = await latestRevision(ctx.db, clusterId);
    // The stored material itself is checked, before any mark.
    expect((await row(chainBad))?.status).toBe("ready");
    expect((await rpcError(update(chainBad))).code).toBe("CERTIFICATE_CHAIN_EXPLICIT_CURVE");
    expect((await rpcError(update(keyBad))).code).toBe("CERTIFICATE_KEY_EXPLICIT_CURVE");
    expect((await latestRevision(ctx.db, clusterId))?.revision).toBe(before?.revision);

    const stuck = await boundBefore(keyBad);
    expect(
      decodeNodeConfig((await latestRevision(ctx.db, clusterId))?.ir ?? new Uint8Array()),
    ).toMatchObject({ certificates: [{ id: keyBad }] });
    // Saving its other settings would publish another revision nodes cannot apply.
    expect((await rpcError(update(keyBad))).code).toBe("CERTIFICATE_KEY_EXPLICIT_CURVE");
    expect((await latestRevision(ctx.db, clusterId))?.revision).toBe(stuck);

    await update(named);
    const config = decodeNodeConfig(
      (await latestRevision(ctx.db, clusterId))?.ir ?? new Uint8Array(),
    );
    expect(config.certificates.map((c) => c.id)).toEqual([named]);
    expect(config.sites.find((s) => s.id === siteId)?.certificateId).toBe(named);
  });

  it("marks them at worker start, audited with the sites bound to them, once", async () => {
    const bound = await boundBefore(chainBad);
    // An envelope that cannot be opened is skipped, not fatal.
    const sealedElsewhere = await stored("sealed elsewhere", namedCertificate, namedKey);
    await ctx.db
      .update(schema.certificate)
      .set({ privateKeyEnvelope: (await row(named))?.privateKeyEnvelope })
      .where(eq(schema.certificate.id, sealedElsewhere));
    // certd writes named curves only; an ACME certificate's status is its issuance's.
    const acme = await stored("acme", certificate, pkcs8Key, { source: "acme" });

    expect(await markUnloadableCertificates(ctx)).toEqual([chainBad, keyBad]);
    const list = await api.certificates.list();
    const status = (id: string) => {
      const cert = list.find((c) => c.id === id);
      return { status: cert?.status, lastError: cert?.lastError };
    };
    expect(status(chainBad)).toEqual({
      status: "error",
      lastError: "certificate_chain_explicit_curve",
    });
    expect(status(keyBad)).toEqual({
      status: "error",
      lastError: "certificate_key_explicit_curve",
    });
    for (const id of [named, sealedElsewhere, acme])
      expect(status(id)).toEqual({ status: "ready", lastError: "" });
    const audit = async () =>
      (await api.auditLogs.list({ action: "certificate.unloadable" })).items;
    expect(
      (await audit()).map(({ actorType, targetId, metadata }) => ({
        actorType,
        targetId,
        metadata,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          actorType: "system",
          targetId: chainBad,
          metadata: { code: "certificate_chain_explicit_curve", sites: ["explicit"] },
        },
        {
          actorType: "system",
          targetId: keyBad,
          metadata: { code: "certificate_key_explicit_curve", sites: [] },
        },
      ]),
    );

    // Nothing the site serves changes behind the operator's back.
    expect((await api.https.get({ id: siteId })).certificateId).toBe(chainBad);
    expect((await latestRevision(ctx.db, clusterId))?.revision).toBe(bound);
    // The next start finds nothing new.
    expect(await markUnloadableCertificates(ctx)).toEqual([]);
    expect(await audit()).toHaveLength(2);
    await ctx.db.delete(schema.certificate).where(eq(schema.certificate.id, sealedElsewhere));
    await ctx.db.delete(schema.certificate).where(eq(schema.certificate.id, acme));
  });

  it("lets an issued ACME certificate replace a marked one, and a rollback not restore it", async () => {
    const bad = await boundBefore(chainBad);
    await api.https.update({ id: siteId, settings: tlsSettings.parse({ certificateId: named }) });
    expect((await rpcError(api.clusters.rollback({ id: clusterId, revision: bad }))).code).toBe(
      "ROLLBACK_RESOURCE_UNAVAILABLE",
    );

    const issued = await stored("issued", namedCertificate, namedKey, { source: "acme" });
    const bind = () =>
      ctx.db.transaction((tx) => bindIssuedCertificate(tx, { id: issued, name: "issued", siteId }));
    // A usable certificate the site has meanwhile stays.
    expect(await bind()).toBeUndefined();
    expect((await api.https.get({ id: siteId })).certificateId).toBe(named);
    await ctx.db
      .update(schema.site)
      .set({ certificateId: chainBad })
      .where(eq(schema.site.id, siteId));
    expect(await bind()).toBe(clusterId);
    expect((await api.https.get({ id: siteId })).certificateId).toBe(issued);
  });
});
