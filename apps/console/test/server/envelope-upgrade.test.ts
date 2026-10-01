import "reflect-metadata";
import { createCipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Envelope, MasterKey } from "../../src/server/lib/envelope";
import { CertificateAuthority, generateCa } from "../../src/server/pki/ca";
import { caKeyBinding, loadOrCreateNodeCa, NODE_CA_ID } from "../../src/server/pki/store";
import { upgradeLegacyEnvelopes } from "../../src/server/services/envelope-upgrade";
import { SETUP_TOKEN_BINDING, SETUP_TOKEN_KEY } from "../../src/server/services/setup";
import { s3SecretBinding } from "../../src/server/services/sites";
import { LEGACY_V1_FIXTURE } from "./fixtures";
import { createTestContext, seedOperator, TEST_MASTER_KEY } from "./helpers";

/** The version 1 sealing code as it shipped (purpose-only AAD), to create legacy rows. */
function sealV1(masterKey: string, plaintext: Uint8Array | string, purpose: string): Envelope {
  const raw = Buffer.from(masterKey, "base64");
  const kid = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const kek = Buffer.from(hkdfSync("sha256", raw, "edgeweir/kek/v1", "envelope", 32));
  const dek = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dek, iv);
  cipher.setAAD(Buffer.from(purpose));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const wrapIv = randomBytes(12);
  const wrap = createCipheriv("aes-256-gcm", kek, wrapIv);
  wrap.setAAD(Buffer.from(`${purpose}\u0000${kid}`));
  const wrappedKey = Buffer.concat([wrap.update(dek), wrap.final()]);
  return {
    v: 1,
    alg: "A256GCM",
    kid,
    purpose,
    wrappedKey: wrappedKey.toString("base64"),
    wrapIv: wrapIv.toString("base64"),
    wrapTag: wrap.getAuthTag().toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

describe("legacy envelope upgrade", async () => {
  const { ctx, client } = await createTestContext();
  const OTHER_KEY = Buffer.alloc(32, 9).toString("base64");
  const credentialIds = {
    a: "00000000-0000-4000-8000-00000000000a",
    b: "00000000-0000-4000-8000-00000000000b",
    current: "00000000-0000-4000-8000-00000000000c",
    foreign: "00000000-0000-4000-8000-00000000000f",
  };
  let caFingerprint = "";

  const credential = async (id: string) =>
    (
      await ctx.db.select().from(schema.originCredential).where(eq(schema.originCredential.id, id))
    )[0];
  const envelopeOf = async (id: string) =>
    JSON.parse((await credential(id))?.secretEnvelope ?? "{}") as Envelope;

  beforeAll(async () => {
    await seedOperator(ctx.db);
    const [cluster] = await ctx.db.insert(schema.cluster).values({ name: "default" }).returning();
    const [site] = await ctx.db
      .insert(schema.site)
      .values({ clusterId: cluster?.id ?? "", name: "assets" })
      .returning();
    const siteId = site?.id ?? "";
    const legacy = (secret: string) =>
      JSON.stringify(sealV1(TEST_MASTER_KEY, secret, "origin-credential/s3-secret"));
    await ctx.db.insert(schema.originCredential).values([
      { id: credentialIds.a, siteId, accessKeyId: "AKIDA", secretEnvelope: legacy("secret-a") },
      { id: credentialIds.b, siteId, accessKeyId: "AKIDB", secretEnvelope: legacy("secret-b") },
      {
        id: credentialIds.current,
        siteId,
        accessKeyId: "AKIDC",
        secretEnvelope: JSON.stringify(
          ctx.masterKey.seal("secret-c", s3SecretBinding(credentialIds.current)),
        ),
      },
      {
        // Sealed under another master key: cannot be upgraded, must not break the rest.
        id: credentialIds.foreign,
        siteId,
        accessKeyId: "AKIDF",
        secretEnvelope: JSON.stringify(
          sealV1(OTHER_KEY, "secret-f", "origin-credential/s3-secret"),
        ),
      },
    ]);

    const material = await generateCa("Legacy CA");
    const ca = await CertificateAuthority.load(material);
    caFingerprint = ca.fingerprintSha256;
    await ctx.db.insert(schema.pkiAuthority).values({
      id: NODE_CA_ID,
      certificatePem: material.certificatePem,
      fingerprintSha256: caFingerprint,
      privateKeyEnvelope: JSON.stringify(
        sealV1(
          TEST_MASTER_KEY,
          material.privateKeyPkcs8Der,
          "pki_authority.private_key:node-channel",
        ),
      ),
      notAfter: ca.certificate.notAfter,
    });

    await ctx.db.insert(schema.systemSetting).values({
      key: "setup_token",
      value: {
        envelope: sealV1(TEST_MASTER_KEY, "ews_legacy-token", "system/setup-token"),
        hash: createHash("sha256").update("ews_legacy-token").digest("hex"),
        createdAt: new Date().toISOString(),
      },
    });
  });
  afterAll(() => client.close());

  it("uses the same format as the shipped v1 code", () => {
    const mk = new MasterKey(TEST_MASTER_KEY);
    const { plaintext, purpose } = LEGACY_V1_FIXTURE;
    expect(mk.openLegacy(sealV1(TEST_MASTER_KEY, plaintext, purpose), purpose).toString()).toBe(
      plaintext,
    );
  });

  it("refuses to read legacy envelopes before the upgrade", async () => {
    expect(() =>
      ctx.masterKey.open({ ...LEGACY_V1_FIXTURE.envelope, v: 1 }, s3SecretBinding(credentialIds.a)),
    ).toThrow(/legacy/);
    await expect(loadOrCreateNodeCa(ctx.db, ctx.masterKey)).rejects.toThrow(/legacy/);
  });

  it("re-seals every legacy envelope bound to its record id, once", async () => {
    const result = await upgradeLegacyEnvelopes(ctx.db, ctx.masterKey, ctx.log);
    expect(result).toEqual({ upgraded: 4, failed: 1 });

    for (const [id, secret] of [
      [credentialIds.a, "secret-a"],
      [credentialIds.b, "secret-b"],
      [credentialIds.current, "secret-c"],
    ] as const) {
      const envelope = await envelopeOf(id);
      expect(envelope.v).toBe(2);
      expect(ctx.masterKey.open(envelope, s3SecretBinding(id)).toString()).toBe(secret);
    }
    // The unreadable one is left as it was.
    expect((await envelopeOf(credentialIds.foreign)).v).toBe(1);

    const [authority] = await ctx.db.select().from(schema.pkiAuthority);
    expect(JSON.parse(authority?.privateKeyEnvelope ?? "{}").v).toBe(2);
    const ca = await loadOrCreateNodeCa(ctx.db, ctx.masterKey);
    expect(ca.fingerprintSha256).toBe(caFingerprint);
    expect(
      ctx.masterKey.open(
        JSON.parse(authority?.privateKeyEnvelope ?? "{}"),
        caKeyBinding(NODE_CA_ID),
      ).length,
    ).toBeGreaterThan(0);

    // The setup token survives the upgrade unchanged.
    const [setting] = await ctx.db
      .select()
      .from(schema.systemSetting)
      .where(eq(schema.systemSetting.key, SETUP_TOKEN_KEY));
    const token = (setting?.value as { envelope: Envelope } | undefined)?.envelope;
    if (!token) throw new Error("setup token missing");
    expect(token.v).toBe(2);
    expect(ctx.masterKey.open(token, SETUP_TOKEN_BINDING).toString()).toBe("ews_legacy-token");

    // Idempotent: nothing left to do except the unreadable row.
    expect(await upgradeLegacyEnvelopes(ctx.db, ctx.masterKey, ctx.log)).toEqual({
      upgraded: 0,
      failed: 1,
    });
  });

  it("refuses a ciphertext swapped between rows after the upgrade", async () => {
    const stolen = await envelopeOf(credentialIds.a);
    await ctx.db
      .update(schema.originCredential)
      .set({ secretEnvelope: JSON.stringify(stolen) })
      .where(eq(schema.originCredential.id, credentialIds.b));
    expect(() => ctx.masterKey.open(stolen, s3SecretBinding(credentialIds.b))).toThrow();
    // Nor can a legacy copy of it be replayed: the read path refuses v1.
    const replay = sealV1(TEST_MASTER_KEY, "secret-a", "origin-credential/s3-secret");
    expect(() => ctx.masterKey.open(replay, s3SecretBinding(credentialIds.b))).toThrow(/legacy/);
  });
});
