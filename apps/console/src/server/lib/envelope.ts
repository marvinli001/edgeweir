import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/**
 * Envelope encryption for secrets at rest (private keys, DNS API keys, ...).
 * Each record gets a random data key (DEK); the DEK is wrapped with a key
 * derived from EDGEWEIR_MASTER_KEY via HKDF. AES-256-GCM everywhere.
 *
 * Version 2 binds the purpose (table and column) *and the record id* as
 * additional authenticated data, so a ciphertext copied into another row,
 * or another column, fails to decrypt. Version 1 bound the purpose only;
 * such envelopes are opened only by the one-time upgrade
 * (services/envelope-upgrade.ts), never by the normal read path.
 */
export interface Envelope {
  v: 1 | 2;
  alg: "A256GCM";
  kid: string;
  purpose: string;
  wrappedKey: string;
  wrapIv: string;
  wrapTag: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

/** What an envelope is bound to: the kind of secret and the row it belongs to. */
export interface EnvelopeBinding {
  /** Table and column, e.g. "origin_credential.secret_envelope". */
  purpose: string;
  /** Primary key of the row that stores the envelope. */
  recordId: string;
}

export class LegacyEnvelopeError extends Error {
  constructor() {
    super("legacy (v1) envelope: run the envelope upgrade before reading it");
  }
}

function bindingAad(binding: EnvelopeBinding): string {
  for (const part of [binding.purpose, binding.recordId]) {
    if (!part || part.includes("\u0000")) throw new Error("invalid envelope binding");
  }
  return `edgeweir/envelope/v2\u0000${binding.purpose}\u0000${binding.recordId}`;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Why EDGEWEIR_MASTER_KEY cannot be used, or null: it must be canonical
 * base64 (standard or URL-safe alphabet) of 32+ bytes. Buffer.from skips
 * characters outside the alphabet, so a key whose "+" a panel turned into a
 * space would otherwise decode to another key.
 */
export function masterKeyProblem(encoded: string): string | null {
  const standard = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const unpadded = standard.replace(/=+$/, "");
  if (
    !BASE64.test(standard) ||
    (unpadded !== standard && standard.length % 4 !== 0) ||
    Buffer.from(standard, "base64").toString("base64").replace(/=+$/, "") !== unpadded
  ) {
    return 'is not valid base64: use the output of `openssl rand -base64 32` as is, without quotes or spaces (check that "+" did not become a space)';
  }
  if (Buffer.from(standard, "base64").length < 32) {
    return "must be at least 32 bytes, base64 encoded (generate one with `openssl rand -base64 32` and use the output as is)";
  }
  return null;
}

/** The raw bytes of EDGEWEIR_MASTER_KEY; throws when masterKeyProblem finds one. */
export function decodeMasterKey(encoded: string): Buffer {
  const problem = masterKeyProblem(encoded);
  if (problem) throw new Error(`EDGEWEIR_MASTER_KEY ${problem}`);
  return Buffer.from(encoded, "base64");
}

export class MasterKey {
  readonly kid: string;
  private readonly kek: Buffer;

  constructor(encoded: string) {
    const raw = decodeMasterKey(encoded);
    this.kid = createHash("sha256").update(raw).digest("hex").slice(0, 16);
    this.kek = Buffer.from(hkdfSync("sha256", raw, "edgeweir/kek/v1", "envelope", 32));
  }

  seal(plaintext: Uint8Array | string, binding: EnvelopeBinding): Envelope {
    return this.sealWith(plaintext, binding.purpose, bindingAad(binding));
  }

  open(envelope: Envelope, binding: EnvelopeBinding): Buffer {
    if (envelope.v === 1) throw new LegacyEnvelopeError();
    if (envelope.v !== 2) throw new Error("unsupported envelope");
    return this.openWith(envelope, binding.purpose, bindingAad(binding));
  }

  /** Opens a version 1 envelope (purpose-only AAD). For the upgrade only. */
  openLegacy(envelope: Envelope, purpose: string): Buffer {
    if (envelope.v !== 1) throw new Error("not a legacy envelope");
    return this.openWith(envelope, purpose, purpose);
  }

  static isLegacy(envelope: Pick<Envelope, "v">): boolean {
    return envelope.v === 1;
  }

  private sealWith(plaintext: Uint8Array | string, purpose: string, aad: string): Envelope {
    const dek = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const wrapIv = randomBytes(12);
    const wrap = createCipheriv("aes-256-gcm", this.kek, wrapIv);
    wrap.setAAD(Buffer.from(`${aad}\u0000${this.kid}`));
    const wrappedKey = Buffer.concat([wrap.update(dek), wrap.final()]);
    return {
      v: 2,
      alg: "A256GCM",
      kid: this.kid,
      purpose,
      wrappedKey: wrappedKey.toString("base64"),
      wrapIv: wrapIv.toString("base64"),
      wrapTag: wrap.getAuthTag().toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  private openWith(envelope: Envelope, purpose: string, aad: string): Buffer {
    if (envelope.alg !== "A256GCM") throw new Error("unsupported envelope");
    if (envelope.purpose !== purpose) throw new Error("envelope purpose mismatch");
    if (envelope.kid !== this.kid) {
      throw new Error("envelope was sealed with a different master key");
    }
    const unwrap = createDecipheriv(
      "aes-256-gcm",
      this.kek,
      Buffer.from(envelope.wrapIv, "base64"),
    );
    unwrap.setAAD(Buffer.from(`${aad}\u0000${this.kid}`));
    unwrap.setAuthTag(Buffer.from(envelope.wrapTag, "base64"));
    const dek = Buffer.concat([
      unwrap.update(Buffer.from(envelope.wrappedKey, "base64")),
      unwrap.final(),
    ]);
    const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
  }
}
