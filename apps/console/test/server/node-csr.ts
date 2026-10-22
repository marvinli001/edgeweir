import "reflect-metadata";
import { webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";

/** A node's P-256 key and the CSR it enrolls with (CN=edge-host). */
export async function nodeKeyAndCsr() {
  const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
  const keys = (await webcrypto.subtle.generateKey(alg, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const csr = await x509.Pkcs10CertificateRequestGenerator.create({
    name: "CN=edge-host",
    keys: keys as never,
    signingAlgorithm: alg,
  });
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", keys.privateKey));
  const keyPem = `-----BEGIN PRIVATE KEY-----\n${pkcs8.toString("base64")}\n-----END PRIVATE KEY-----\n`;
  return { csrPem: csr.toString("pem"), keyPem, keys };
}
