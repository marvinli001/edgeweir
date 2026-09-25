import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";

/**
 * Envelope encryption for secrets at rest (private keys, DNS API keys, ...).
 * Each record gets a random data key (DEK); the DEK is wrapped with a key
 * derived from EDGEWEIR_MASTER_KEY via HKDF. AES-256-GCM everywhere, with the
 * purpose string bound as additional authenticated data.
 */
export interface Envelope {
  v: 1;
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

export class MasterKey {
  readonly kid: string;
  private readonly kek: Buffer;

  constructor(encoded: string) {
    const raw = Buffer.from(encoded, "base64");
    if (raw.length < 32) {
      throw new Error("EDGEWEIR_MASTER_KEY must be at least 32 bytes, base64 encoded");
    }
    this.kid = createHash("sha256").update(raw).digest("hex").slice(0, 16);
    this.kek = Buffer.from(hkdfSync("sha256", raw, "edgeweir/kek/v1", "envelope", 32));
  }

  seal(plaintext: Uint8Array | string, purpose: string): Envelope {
    const dek = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", dek, iv);
    cipher.setAAD(Buffer.from(purpose));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();

    const wrapIv = randomBytes(12);
    const wrap = createCipheriv("aes-256-gcm", this.kek, wrapIv);
    wrap.setAAD(Buffer.from(`${purpose}\u0000${this.kid}`));
    const wrappedKey = Buffer.concat([wrap.update(dek), wrap.final()]);
    return {
      v: 1,
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

  open(envelope: Envelope, purpose: string): Buffer {
    if (envelope.v !== 1 || envelope.alg !== "A256GCM") throw new Error("unsupported envelope");
    if (envelope.purpose !== purpose) throw new Error("envelope purpose mismatch");
    if (envelope.kid !== this.kid)
      throw new Error("envelope was sealed with a different master key");
    const unwrap = createDecipheriv(
      "aes-256-gcm",
      this.kek,
      Buffer.from(envelope.wrapIv, "base64"),
    );
    unwrap.setAAD(Buffer.from(`${purpose}\u0000${this.kid}`));
    unwrap.setAuthTag(Buffer.from(envelope.wrapTag, "base64"));
    const dek = Buffer.concat([
      unwrap.update(Buffer.from(envelope.wrappedKey, "base64")),
      unwrap.final(),
    ]);
    const decipher = createDecipheriv("aes-256-gcm", dek, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(Buffer.from(purpose));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
  }
}
