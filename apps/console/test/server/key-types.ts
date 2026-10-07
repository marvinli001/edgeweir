import "reflect-metadata";
import { type KeyPairKeyObjectResult, webcrypto } from "node:crypto";
import * as x509 from "@peculiar/x509";

const provider = webcrypto as unknown as Parameters<typeof x509.cryptoProvider.set>[0];

/**
 * A leaf for `names` with a key of any type Node can generate, such as
 * secp256k1, Ed448 or DSA, which WebCrypto cannot sign with: a throwaway
 * P-256 issuer signs it (inspectCertificate does not verify a lone leaf's
 * signature). No key material is committed.
 */
export async function leafFor({ publicKey, privateKey }: KeyPairKeyObjectResult, names: string[]) {
  const issuer = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
    "sign",
  ]);
  const now = Date.now();
  const cert = await x509.X509CertificateGenerator.create(
    {
      subject: `CN=${names[0]}`,
      issuer: "CN=key-types.test",
      notBefore: new Date(now - 3_600_000),
      notAfter: new Date(now + 86_400_000),
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      publicKey: new x509.PublicKey(publicKey.export({ type: "spki", format: "der" })),
      signingKey: issuer.privateKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.SubjectAlternativeNameExtension(
          names.map((value) => ({ type: "dns" as const, value })),
          false,
        ),
      ],
    },
    provider,
  );
  return {
    certificatePem: cert.toString("pem"),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
