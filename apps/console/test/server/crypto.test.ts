import "reflect-metadata";
import { webcrypto, X509Certificate } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import { LegacyEnvelopeError, MasterKey } from "../../src/server/lib/envelope";
import { CertificateAuthority, CsrError, generateCa } from "../../src/server/pki/ca";
import { LEGACY_V1_FIXTURE } from "./fixtures";
import { TEST_MASTER_KEY } from "./helpers";

async function makeCsr(cn = "host-1") {
  const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const keys = (await webcrypto.subtle.generateKey(alg, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: `CN=${cn}`,
    keys: keys as never,
    signingAlgorithm: alg,
  });
  return csr.toString("pem");
}

describe("MasterKey envelopes", () => {
  const row1 = { purpose: "dns_credential.secret", recordId: "row-1" };

  it("round-trips and binds the purpose", () => {
    const mk = new MasterKey(TEST_MASTER_KEY);
    const env = mk.seal("secret", row1);
    expect(env.v).toBe(2);
    expect(env.ciphertext).not.toContain("secret");
    expect(mk.open(env, row1).toString()).toBe("secret");
    expect(() => mk.open(env, { ...row1, purpose: "other.secret" })).toThrow(/purpose/);
    expect(() =>
      mk.open({ ...env, purpose: "other.secret" }, { ...row1, purpose: "other.secret" }),
    ).toThrow();
  });

  it("binds the record id: a ciphertext swapped into another row does not open", () => {
    const mk = new MasterKey(TEST_MASTER_KEY);
    const a = mk.seal("secret of row 1", row1);
    const b = mk.seal("secret of row 2", { ...row1, recordId: "row-2" });
    expect(mk.open(b, { ...row1, recordId: "row-2" }).toString()).toBe("secret of row 2");
    // Row 2 now holds row 1's envelope.
    expect(() => mk.open(a, { ...row1, recordId: "row-2" })).toThrow();
    // Only the data part swapped, with row 2's wrapped key kept.
    const mixed = { ...b, iv: a.iv, tag: a.tag, ciphertext: a.ciphertext };
    expect(() => mk.open(mixed, { ...row1, recordId: "row-2" })).toThrow();
    expect(() => mk.seal("x", { ...row1, recordId: "" })).toThrow(/binding/);
  });

  it("refuses a different master key and short keys", () => {
    const env = new MasterKey(TEST_MASTER_KEY).seal("secret", row1);
    const other = new MasterKey(Buffer.alloc(32, 9).toString("base64"));
    expect(() => other.open(env, row1)).toThrow(/different master key/);
    expect(() => new MasterKey(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });

  it("takes only canonical base64, so a damaged key never decodes to another key", () => {
    const raw = Buffer.alloc(33, 7);
    raw[0] = 0xf8;
    const key = raw.toString("base64");
    expect(key).toMatch(/^\+/);
    // A panel turning "+" into a space: Buffer.from skips the space and gets
    // 32 other bytes, a valid but wrong key.
    const spaced = key.replace("+", " ");
    expect(Buffer.from(spaced, "base64")).toHaveLength(32);
    for (const damaged of [
      spaced,
      `"${key}"`,
      `${key}\n`,
      key.slice(0, 20) + key.slice(21),
      `${TEST_MASTER_KEY}=`,
      TEST_MASTER_KEY.replace("=", "A="),
    ]) {
      expect(() => new MasterKey(damaged), damaged).toThrow(
        /^EDGEWEIR_MASTER_KEY is not valid base64/,
      );
    }
    // The same bytes in the URL-safe alphabet or without padding are the same key.
    const kid = new MasterKey(key).kid;
    expect(new MasterKey(raw.toString("base64url")).kid).toBe(kid);
    expect(new MasterKey(TEST_MASTER_KEY.replace(/=+$/, "")).kid).toBe(
      new MasterKey(TEST_MASTER_KEY).kid,
    );
  });

  it("detects tampering", () => {
    const mk = new MasterKey(TEST_MASTER_KEY);
    const env = mk.seal("secret", row1);
    const flipped = Buffer.from(env.ciphertext, "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => mk.open({ ...env, ciphertext: flipped.toString("base64") }, row1)).toThrow();
  });

  it("opens legacy (v1) envelopes only through the upgrade path", () => {
    const mk = new MasterKey(TEST_MASTER_KEY);
    const { envelope, purpose, plaintext } = LEGACY_V1_FIXTURE;
    expect(MasterKey.isLegacy(envelope)).toBe(true);
    expect(mk.openLegacy(envelope, purpose).toString()).toBe(plaintext);
    expect(() => mk.open(envelope, { purpose, recordId: "any" })).toThrow(LegacyEnvelopeError);
    expect(() => mk.openLegacy(mk.seal("x", row1), row1.purpose)).toThrow(/not a legacy/);
  });
});

describe("CertificateAuthority", () => {
  it("issues client certificates with CN=node id that chain to the CA", async () => {
    const ca = await CertificateAuthority.load(await generateCa("Test CA"));
    const issued = await ca.signNodeCsr(await makeCsr("ignored-hostname"), "node-123");
    const leaf = new X509Certificate(issued.certificatePem);
    const root = new X509Certificate(ca.certificatePem);
    expect(leaf.subject).toContain("CN=node-123");
    expect(leaf.verify(root.publicKey)).toBe(true);
    expect(leaf.checkIssued(root)).toBe(true);
    expect(root.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.keyUsage).toContain("1.3.6.1.5.5.7.3.2");
    expect(issued.fingerprintSha256).toBe(leaf.fingerprint256.replaceAll(":", "").toLowerCase());
    const days = (issued.notAfter.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30);
  });

  it("rejects malformed and tampered CSRs", async () => {
    const ca = await CertificateAuthority.load(await generateCa("Test CA"));
    await expect(ca.signNodeCsr("not a csr", "n")).rejects.toBeInstanceOf(CsrError);
    const pem = await makeCsr();
    const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
    der[der.length - 5] = (der[der.length - 5] ?? 0) ^ 0xff; // corrupt the signature
    const bad = `-----BEGIN CERTIFICATE REQUEST-----\n${der.toString("base64")}\n-----END CERTIFICATE REQUEST-----`;
    await expect(ca.signNodeCsr(bad, "n")).rejects.toBeInstanceOf(CsrError);
  });

  it("issues server certificates with the requested SANs", async () => {
    const ca = await CertificateAuthority.load(await generateCa("Test CA"));
    const { certificatePem } = await ca.issueServerCertificate(["console", "127.0.0.1"]);
    const cert = new X509Certificate(certificatePem);
    expect(cert.subjectAltName).toContain("DNS:console");
    expect(cert.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(cert.checkHost("console")).toBe("console");
  });
});
