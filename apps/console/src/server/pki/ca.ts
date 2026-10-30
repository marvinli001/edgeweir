import "reflect-metadata";
import { createHash, createPublicKey, randomBytes, webcrypto } from "node:crypto";
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
const CLOCK_SKEW_MS = 3600 * 1000;

export interface IssuedCertificate {
  certificatePem: string;
  serialNumber: string;
  fingerprintSha256: string;
  notAfter: Date;
  /** Hex SHA-256 of the certified SubjectPublicKeyInfo (the CSR's key). */
  keySha256: string;
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

async function verifiedCsr(csrPem: string): Promise<x509.Pkcs10CertificateRequest> {
  let csr: x509.Pkcs10CertificateRequest;
  try {
    csr = new x509.Pkcs10CertificateRequest(csrPem);
  } catch {
    throw new CsrError("malformed CSR");
  }
  if (!(await csr.verify())) throw new CsrError("CSR signature verification failed");
  return csr;
}

const keySha256 = (key: x509.PublicKey) =>
  createHash("sha256").update(Buffer.from(key.rawData)).digest("hex");

export function sha256Fingerprint(cert: x509.X509Certificate): string {
  return createHash("sha256").update(Buffer.from(cert.rawData)).digest("hex");
}

function pemFromDer(label: string, der: ArrayBuffer | Uint8Array): string {
  const b64 = Buffer.from(der instanceof Uint8Array ? der : new Uint8Array(der)).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** Generates a fresh internal CA (ECDSA P-256, 10 years unless given, path length 0). */
export async function generateCa(commonName: string, years = 10): Promise<CaMaterial> {
  const keys = (await subtle.generateKey(EC_ALG, true, ["sign", "verify"])) as CryptoKeyPair;
  const now = new Date();
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: randomSerial(),
    name: `CN=${commonName}, O=Edgeweir`,
    notBefore: new Date(now.getTime() - CLOCK_SKEW_MS),
    notAfter: new Date(now.getTime() + years * 365 * DAY),
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
   * by CN=<nodeId>. TLS client auth, and server auth for the name <nodeId>:
   * an upper tier of the tiered cache serves lower tiers with it (ADR-0073).
   */
  signNodeCsr(csrPem: string, nodeId: string): Promise<IssuedCertificate> {
    return this.signClientCsr(csrPem, nodeId, NODE_ORGANIZATION, true);
  }

  /**
   * Signs a probe CSR: CN=<probeId>, O=Edgeweir Probe, TLS client auth only.
   * The node channel tells probes from nodes by the organization.
   */
  signProbeCsr(csrPem: string, probeId: string): Promise<IssuedCertificate> {
    return this.signClientCsr(csrPem, probeId, PROBE_ORGANIZATION);
  }

  /**
   * The hex SHA-256 of a CSR's SubjectPublicKeyInfo, once its signature
   * proves the sender holds the key.
   */
  async csrKeySha256(csrPem: string): Promise<string> {
    return keySha256((await verifiedCsr(csrPem)).publicKey);
  }

  private async signClientCsr(
    csrPem: string,
    commonName: string,
    organization: string,
    server = false,
  ): Promise<IssuedCertificate> {
    const csr = await verifiedCsr(csrPem);
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
        new x509.ExtendedKeyUsageExtension(
          server
            ? [x509.ExtendedKeyUsage.clientAuth, x509.ExtendedKeyUsage.serverAuth]
            : [x509.ExtendedKeyUsage.clientAuth],
          false,
        ),
        ...(server
          ? [new x509.SubjectAlternativeNameExtension([{ type: "dns", value: commonName }], false)]
          : []),
        await x509.AuthorityKeyIdentifierExtension.create(this.certificate, false),
        await x509.SubjectKeyIdentifierExtension.create(csr.publicKey),
      ],
    });
    return {
      certificatePem: `${cert.toString("pem").trim()}\n`,
      serialNumber: cert.serialNumber,
      fingerprintSha256: sha256Fingerprint(cert),
      notAfter,
      keySha256: keySha256(csr.publicKey),
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

/** A certificate and the PKCS#8 key the console generated for it. */
export interface IssuedKeyPairCertificate {
  certificatePem: string;
  privateKeyPem: string;
  serialNumber: string;
  fingerprintSha256: string;
  notBefore: Date;
  notAfter: Date;
}

/** An origin server certificate; privateKeyPem is "" when a CSR supplied the key. */
export interface IssuedOriginCertificate extends IssuedKeyPairCertificate {
  keyType: string;
}

export type OriginKeyType = "ec256" | "rsa2048";

const RSA_ALG = {
  name: "RSASSA-PKCS1-v1_5",
  modulusLength: 2048,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: "SHA-256",
} as const;

/**
 * The key type of a SubjectPublicKeyInfo origin certificates accept: ECDSA
 * P-256 / P-384 or RSA 2048-4096 bits; null for anything else.
 */
function originKeyType(spki: ArrayBuffer | Uint8Array): string | null {
  const key = createPublicKey({
    key: Buffer.from(new Uint8Array(spki)),
    format: "der",
    type: "spki",
  });
  const details = key.asymmetricKeyDetails ?? {};
  if (key.asymmetricKeyType === "ec") {
    if (details.namedCurve === "prime256v1") return "ec256";
    if (details.namedCurve === "secp384r1") return "ec384";
    return null;
  }
  if (key.asymmetricKeyType === "rsa") {
    const bits = details.modulusLength ?? 0;
    return [2048, 3072, 4096].includes(bits) ? `rsa${bits}` : null;
  }
  return null;
}

/** Extra issuing operations of the origin client CA and the Origin CA. */
export class OriginAuthority {
  private constructor(
    readonly certificate: x509.X509Certificate,
    private readonly privateKey: CryptoKey,
  ) {}

  static async load(material: CaMaterial): Promise<OriginAuthority> {
    const cert = new x509.X509Certificate(material.certificatePem);
    const key = await subtle.importKey("pkcs8", material.privateKeyPkcs8Der, EC_ALG, false, [
      "sign",
    ]);
    return new OriginAuthority(cert, key);
  }

  /**
   * Issues a TLS client certificate with a generated ECDSA P-256 key:
   * CN=<commonName>, O=<organization>, client auth only.
   */
  async issueClientCertificate(
    commonName: string,
    organization: string,
    days: number,
    issuedAt = new Date(),
  ): Promise<IssuedKeyPairCertificate> {
    const keys = (await subtle.generateKey(EC_ALG, true, ["sign", "verify"])) as CryptoKeyPair;
    const now = issuedAt.getTime();
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerial(),
      subject: `CN=${commonName}, O=${organization}`,
      issuer: this.certificate.subject,
      notBefore: new Date(now - CLOCK_SKEW_MS),
      notAfter: this.capped(new Date(now + days * DAY)),
      signingAlgorithm: SIGNING_ALG,
      publicKey: keys.publicKey,
      signingKey: this.privateKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.clientAuth], false),
        await x509.AuthorityKeyIdentifierExtension.create(this.certificate, false),
        await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
      ],
    });
    return this.issued(
      cert,
      pemFromDer("PRIVATE KEY", await subtle.exportKey("pkcs8", keys.privateKey)),
    );
  }

  /**
   * Issues an origin server certificate for host names and IP literals:
   * server auth only, valid for `years` or until the authority expires.
   * With a CSR its signature is checked and only its public key is used
   * (CsrError); otherwise a `keyType` key is generated and returned.
   */
  async issueOriginCertificate(input: {
    hostnames: string[];
    years: number;
    keyType: OriginKeyType;
    csrPem?: string;
    issuedAt?: Date;
  }): Promise<IssuedOriginCertificate> {
    let publicKey: CryptoKey | x509.PublicKey;
    let privateKeyPem = "";
    let keyType: string;
    if (input.csrPem) {
      let csr: x509.Pkcs10CertificateRequest;
      try {
        csr = new x509.Pkcs10CertificateRequest(input.csrPem);
      } catch {
        throw new CsrError("malformed CSR");
      }
      let type: string | null;
      try {
        type = originKeyType(csr.publicKey.rawData);
      } catch {
        type = null;
      }
      if (!type) throw new CsrError("unsupported key");
      let valid = false;
      try {
        valid = await csr.verify();
      } catch {
        valid = false;
      }
      if (!valid) throw new CsrError("CSR signature verification failed");
      publicKey = csr.publicKey;
      keyType = type;
    } else {
      const alg = input.keyType === "rsa2048" ? RSA_ALG : EC_ALG;
      const keys = (await subtle.generateKey(alg, true, ["sign", "verify"])) as CryptoKeyPair;
      publicKey = keys.publicKey;
      privateKeyPem = pemFromDer("PRIVATE KEY", await subtle.exportKey("pkcs8", keys.privateKey));
      keyType = input.keyType;
    }
    const now = (input.issuedAt ?? new Date()).getTime();
    const sans: x509.JsonGeneralName[] = input.hostnames.map((name) =>
      isIP(name) ? { type: "ip", value: name } : { type: "dns", value: name },
    );
    const usage = keyType.startsWith("rsa")
      ? x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment
      : x509.KeyUsageFlags.digitalSignature;
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: randomSerial(),
      subject: [{ CN: [input.hostnames[0] ?? ""] }],
      issuer: this.certificate.subject,
      notBefore: new Date(now - CLOCK_SKEW_MS),
      notAfter: this.capped(new Date(now + input.years * 365 * DAY)),
      signingAlgorithm: SIGNING_ALG,
      publicKey,
      signingKey: this.privateKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(usage, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth], false),
        new x509.SubjectAlternativeNameExtension(sans, false),
        await x509.AuthorityKeyIdentifierExtension.create(this.certificate, false),
        await x509.SubjectKeyIdentifierExtension.create(publicKey),
      ],
    });
    return { ...this.issued(cert, privateKeyPem), keyType };
  }

  /**
   * A CRL of the given serial numbers (lowercase hex), valid from an hour
   * ago until the authority expires: nodes keep enforcing it however long
   * the console is unreachable, and every change replaces it.
   */
  async crl(
    revoked: { serial: string; revokedAt: Date }[],
    issuedAt = new Date(),
  ): Promise<string> {
    const crl = await x509.X509CrlGenerator.create({
      issuer: this.certificate.subject,
      thisUpdate: new Date(issuedAt.getTime() - CLOCK_SKEW_MS),
      nextUpdate: this.certificate.notAfter,
      entries: revoked.map((r) => ({ serialNumber: r.serial, revocationDate: r.revokedAt })),
      signingAlgorithm: SIGNING_ALG,
      signingKey: this.privateKey,
      extensions: [await x509.AuthorityKeyIdentifierExtension.create(this.certificate, false)],
    });
    // OpenSSL (nginx's *_ssl_crl) reads the label "X509 CRL" only, not the library's "CRL".
    return pemFromDer("X509 CRL", crl.rawData);
  }

  private capped(notAfter: Date): Date {
    return notAfter > this.certificate.notAfter ? this.certificate.notAfter : notAfter;
  }

  private issued(cert: x509.X509Certificate, privateKeyPem: string): IssuedKeyPairCertificate {
    return {
      certificatePem: `${cert.toString("pem").trim()}\n`,
      privateKeyPem,
      serialNumber: cert.serialNumber,
      fingerprintSha256: sha256Fingerprint(cert),
      notBefore: cert.notBefore,
      notAfter: cert.notAfter,
    };
  }
}

/** Whether `pem`'s first certificate was signed by the authority certificate `caPem`. */
export async function issuedBy(pem: string, caPem: string): Promise<boolean> {
  try {
    const cert = new x509.X509Certificate(pem);
    const ca = new x509.X509Certificate(caPem);
    if (cert.issuer !== ca.subject) return false;
    return await cert.verify({ publicKey: ca.publicKey, signatureOnly: true });
  } catch {
    return false;
  }
}
