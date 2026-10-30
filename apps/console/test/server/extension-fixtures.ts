import { createHash, createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";

// Vectors written by edgeweir-node (internal/extension, go test -update):
// the example extension packed and signed with the key derived below.
const fixture = (name: string) =>
  readFileSync(new URL(`../fixtures/extensions/${name}`, import.meta.url));
export const PACKAGE = fixture("hello-header-1.0.0.ewx");
export const SIGNATURE = fixture("hello-header-1.0.0.ewx.sig").toString().trim();
export const PUBLIC_JWK = fixture("test-key.pub.jwk").toString().trim();

const seed = createHash("sha256").update("edgeweir extension test key").digest();
// PKCS#8 wrapper of a raw Ed25519 seed (RFC 8410).
const privateKey = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
  format: "der",
  type: "pkcs8",
});
export const b64url = (data: Buffer | string) => Buffer.from(data).toString("base64url");
export const kid = (x: string) =>
  b64url(createHash("sha256").update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest());

/** A minimal ustar writer for test packages (regular files only). */
export function ustar(files: Record<string, string | Buffer>): Buffer {
  const blocks: Buffer[] = [];
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(path, 0, 100);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

/** The JWS of a package, signed by the test key. */
export function signPackage(
  bytes: Buffer,
  manifest: { id: string; version: string; publisher: string },
) {
  const x = JSON.parse(PUBLIC_JWK).x as string;
  const header = b64url(JSON.stringify({ alg: "EdDSA", kid: kid(x), typ: "edgeweir-ext+jws" }));
  const payload = b64url(
    JSON.stringify({
      format: "edgeweir-node-extension-v1",
      id: manifest.id,
      version: manifest.version,
      publisher: manifest.publisher,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      iat: 1,
    }),
  );
  return `${header}.${payload}.${b64url(sign(null, Buffer.from(`${header}.${payload}`), privateKey))}`;
}
