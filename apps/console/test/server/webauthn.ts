import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

/**
 * A software WebAuthn authenticator (ES256, "none" attestation) for driving
 * better-auth's passkey endpoints the way a browser would.
 */

const b64url = (data: Uint8Array | string) => Buffer.from(data).toString("base64url");
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

type Cbor = number | string | Uint8Array | Map<Cbor, Cbor>;

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) return Buffer.from([(major << 5) | 25, length >> 8, length & 0xff]);
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(length, 1);
  return out;
}

/** Just enough CBOR (RFC 8949) for attestation objects and COSE keys. */
function cbor(value: Cbor): Buffer {
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, bytes.length), bytes]);
  }
  if (value instanceof Map) {
    const parts = [cborHead(5, value.size)];
    for (const [k, v] of value) parts.push(cbor(k), cbor(v));
    return Buffer.concat(parts);
  }
  return Buffer.concat([cborHead(2, value.length), Buffer.from(value)]);
}

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private counter = 0;

  constructor(
    private readonly rpId: string,
    private readonly origin: string,
  ) {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  private authData(flags: number, attested?: Buffer): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter++);
    return Buffer.concat([
      sha256(this.rpId),
      Buffer.from([flags]),
      counter,
      attested ?? Buffer.alloc(0),
    ]);
  }

  /** navigator.credentials.create() for the given registration options. */
  register(options: { challenge: string }) {
    const jwk = this.publicKey.export({ format: "jwk" });
    const coseKey = cbor(
      new Map<Cbor, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x ?? "", "base64url")],
        [-3, Buffer.from(jwk.y ?? "", "base64url")],
      ]),
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const attested = Buffer.concat([Buffer.alloc(16), idLength, this.credentialId, coseKey]);
    // Flags: user present, user verified, attested credential data.
    const authData = this.authData(0x45, attested);
    const clientData = JSON.stringify({
      type: "webauthn.create",
      challenge: options.challenge,
      origin: this.origin,
      crossOrigin: false,
    });
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientData),
        attestationObject: b64url(attestationObject),
        transports: ["internal"],
      },
    };
  }

  /** navigator.credentials.get() for the given authentication options. */
  authenticate(options: { challenge: string }) {
    const authData = this.authData(0x05);
    const clientData = JSON.stringify({
      type: "webauthn.get",
      challenge: options.challenge,
      origin: this.origin,
      crossOrigin: false,
    });
    const signature = sign(
      "sha256",
      Buffer.concat([authData, sha256(clientData)]),
      this.privateKey,
    );
    return {
      id: b64url(this.credentialId),
      rawId: b64url(this.credentialId),
      type: "public-key",
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientData),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
      },
    };
  }
}
