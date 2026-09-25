import "reflect-metadata";
import { webcrypto, X509Certificate } from "node:crypto";
import * as x509 from "@peculiar/x509";
import { describe, expect, it } from "vitest";
import { MasterKey } from "../../src/server/lib/envelope";
import { CertificateAuthority, CsrError, generateCa } from "../../src/server/pki/ca";
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
  it("round-trips and binds the purpose", () => {
    const mk = new MasterKey(TEST_MASTER_KEY);
    const env = mk.seal("secret", "dns:1");
    expect(env.ciphertext).not.toContain("secret");
    expect(mk.open(env, "dns:1").toString()).toBe("secret");
    expect(() => mk.open(env, "dns:2")).toThrow(/purpose/);
    expect(() => mk.open({ ...env, purpose: "dns:2" }, "dns:2")).toThrow();
  });

  it("refuses a different master key and short keys", () => {
    const env = new MasterKey(TEST_MASTER_KEY).seal("secret", "p");
    const other = new MasterKey(Buffer.alloc(32, 9).toString("base64"));
    expect(() => other.open(env, "p")).toThrow(/different master key/);
    expect(() => new MasterKey(Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });

  it("detects tampering", () => {
    const mk = new MasterKey(TEST_MASTER_KEY);
    const env = mk.seal("secret", "p");
    const flipped = Buffer.from(env.ciphertext, "base64");
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(() => mk.open({ ...env, ciphertext: flipped.toString("base64") }, "p")).toThrow();
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
