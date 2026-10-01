import "reflect-metadata";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { isIP } from "node:net";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0]);

const subtle = webcrypto.subtle;
type CryptoKey = webcrypto.CryptoKey;
type CryptoKeyPair = webcrypto.CryptoKeyPair;
const EC_ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
const SIGNING_ALG = { name: "ECDSA", hash: "SHA-256" } as const;

export const NODE_CERT_LIFETIME_DAYS = 30;
/** Subject organization of node client certificates. */
export const NODE_ORGANIZATION = "Edgeweir Node";
/** Subject organization of probe client certificates (same lifetime as nodes'). */
export const PROBE_ORGANIZATION = "Edgeweir Probe";
/** Node channel server certificate; the listener reissues it in-process before expiry. */
export const SERVER_CERT_LIFETIME_DAYS = 90;
const DAY = 24 * 3600 * 1000;
/** Certificates are valid from this long before issue, for peers whose clocks run behind. */
export const CLOCK_SKEW_MS = 3600 * 1000;

export interface IssuedCertificate {
  certificatePem: string;
  serialNumber: string;
  fingerprintSha256: string;
  notAfter: Date;
}

export interface IssuedServerCertificate {
  certificatePem: string;
  privateKeyPem: string;
  serialNumber: string;
  notAfter: Date;
}

export interface CaMaterial {
  certificatePem: string;
  privateKeyPkcs8Der: Uint8Array;
}

function randomSerial(): string {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0] ?? 0) & 0x7f; // positive INTEGER
  return bytes.toString("hex");
}

export function sha256Fingerprint(cert: x509.X509Certificate): string {
  return createHash("sha256").update(Buffer.from(cert.rawData)).digest("hex");
}

export function pemFromDer(label: string, der: ArrayBuffer | Uint8Array): string {
  const b64 = Buffer.from(der instanceof Uint8Array ? der : new Uint8Array(der)).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** Generates a fresh internal CA (ECDSA P-256, 10 years, path length 0). */
export async function generateCa(commonName: string): Promise<CaMaterial> {
  const keys = (await subtle.generateKey(EC_ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const now = new Date();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerial(),
    name: `CN=${commonName}, O=Edgeweir`,
    notBefore: new Date(now.getTime() - CLOCK_SKEW_MS),
    notAfter: new Date(now.getTime() + 3650 * DAY),
    keys,
    signingAlgorithm: SIGNING_ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(
        x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign,
        true,
      ),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", keys.privateKey));
  return { certificatePem: `${cert.toString("pem").trim()}\n`, privateKeyPkcs8Der: pkcs8 };
}

/** An internal certificate authority loaded into memory. */
export class CertificateAuthority {
  private constructor(
    readonly certificate: x509.X509Certificate,
    private readonly privateKey: CryptoKey,
  ) {}

  static async load(material: CaMaterial): Promise<CertificateAuthority> {
    const cert = new x509.X509Certificate(material.certificatePem);
    const key = await subtle.importKey("pkcs8", material.privateKeyPkcs8Der, EC_ALG, false, [
      "sign",
    ]);
    return new CertificateAuthority(cert, key);
  }

  get certificatePem(): string {
    return `${this.certificate.toString("pem").trim()}\n`;
  }

  /** SHA-256 of the CA certificate DER; nodes pin this during enrollment. */
  get fingerprintSha256(): string {
    return sha256Fingerprint(this.certificate);
  }

  /**
   * Signs a node CSR. The CSR signature is verified; the subject is replaced
   * by CN=<nodeId> and the certificate is limited to TLS client auth.
   */
  signNodeCsr(csrPem: string, nodeId: string): Promise<IssuedCertificate> {
    return this.signClientCsr(csrPem, nodeId, NODE_ORGANIZATION);
  }

  /**
   * Signs a probe CSR: CN=<probeId>, O=Edgeweir Probe, TLS client auth only.
   * The node channel tells probes from nodes by the organization.
   */
  signProbeCsr(csrPem: string, probeId: string): Promise<IssuedCertificate> {
    return this.signClientCsr(csrPem, probeId, PROBE_ORGANIZATION);
  }

  private async signClientCsr(
    csrPem: string,
    commonName: string,
    organization: string,
  ): Promise<IssuedCertificate> {
    let csr: x509.Pkcs10CertificateRequest;
    try {
      csr = new x509.Pkcs10CertificateRequest(csrPem);
    } catch {
      throw new CsrError("malformed CSR");
    }
    if (!(await csr.verify())) throw new CsrError("CSR signature verification failed");
    const algorithm = csr.publicKey.algorithm as { name: string; namedCurve?: string };
    const ok =
      (algorithm.name === "ECDSA" && ["P-256", "P-384"].includes(algorithm.namedCurve ?? "")) ||
      algorithm.name === "Ed25519" ||
      algorithm.name === "RSASSA-PKCS1-v1_5";
    if (!ok) throw new CsrError(`unsupported key algorithm ${algorithm.name}`);

    const now = Date.now();
    const notAfter = new Date(now + NODE_CERT_LIFETIME_DAYS * DAY);
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerial(),
      subject: `CN=${commonName}, O=${organization}`,
      issuer: this.certificate.subject,
      notBefore: new Date(now - CLOCK_SKEW_MS),
      notAfter,
      signingAlgorithm: SIGNING_ALG,
      publicKey: csr.publicKey,
      signingKey: this.privateKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], false),
        await x509.AuthorityKeyIdentifierExtension.create(this.certificate, false),
        await x509.SubjectKeyIdentifierExtension.create(csr.publicKey),
      ],
    });
    return {
      certificatePem: `${cert.toString("pem").trim()}\n`,
      serialNumber: cert.serialNumber,
      fingerprintSha256: sha256Fingerprint(cert),
      notAfter,
    };
  }

  /** Issues a short-lived server certificate for the node channel listener. */
  async issueServerCertificate(
    names: string[],
    issuedAt = new Date(),
  ): Promise<IssuedServerCertificate> {
    const keys = (await subtle.generateKey(EC_ALG, true, ["sign", "verify"])) as CryptoKeyPair;
    const now = issuedAt.getTime();
    const sans: x509.JsonGeneralName[] = [];
    for (const name of new Set(names)) {
      sans.push(isIP(name) ? { type: "ip", value: name } : { type: "dns", value: name });
    }
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerial(),
      subject: "CN=edgeweir-node-api, O=Edgeweir",
      issuer: this.certificate.subject,
      notBefore: new Date(now - CLOCK_SKEW_MS),
      notAfter: new Date(now + SERVER_CERT_LIFETIME_DAYS * DAY),
      signingAlgorithm: SIGNING_ALG,
      publicKey: keys.publicKey,
      signingKey: this.privateKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
        new x509.SubjectAlternativeNameExtension(sans, false),
        await x509.AuthorityKeyIdentifierExtension.create(this.certificate, false),
      ],
    });
    const pkcs8 = await subtle.exportKey("pkcs8", keys.privateKey);
    return {
      certificatePem: `${cert.toString("pem").trim()}\n`,
      privateKeyPem: pemFromDer("PRIVATE KEY", pkcs8),
      serialNumber: cert.serialNumber,
      notAfter: cert.notAfter,
    };
  }
}

export class CsrError extends Error {}
