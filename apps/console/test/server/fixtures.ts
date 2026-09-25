import type { Envelope } from "../../src/server/lib/envelope";

/** Sealed by envelope.ts before record binding (v1), with TEST_MASTER_KEY. Do not regenerate. */
export const LEGACY_V1_FIXTURE = {
  plaintext: "legacy-s3-secret",
  purpose: "origin-credential/s3-secret",
  envelope: {
    v: 1,
    alg: "A256GCM",
    kid: "4bb06f8e4e3a7715",
    purpose: "origin-credential/s3-secret",
    wrappedKey: "rM+Bu0+AGLZPnmhtZeFsAT+cD/+tuDDUy7UYpFfj7+0=",
    wrapIv: "eEbM5GBg/SylC/p2",
    wrapTag: "pKEzaSmPgMm55Uk0J/s/Xw==",
    iv: "6/b2zBVoN1OduyRh",
    tag: "mVKTwlXrWZ7fWvW7UPfOWw==",
    ciphertext: "WLV6qAXLuYn7R2YGUwYOww==",
  } satisfies Envelope,
};
