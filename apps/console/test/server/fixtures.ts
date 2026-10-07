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

/**
 * A test-only P-256 key with explicit curve parameters (OpenSSL 3:
 * `ecparam -name prime256v1 -genkey -noout -param_enc explicit`, then
 * `pkcs8 -topk8 -nocrypt`) and self-signed leaves for explicit.test valid
 * until 2126: `certificate` signed with the key as is, so its public key
 * spells out the curve too, and `namedCertificate` with the key converted
 * (`pkey -ec_param_enc named_curve`). Go's tls.X509KeyPair loads only
 * `namedCertificate` with the converted key.
 */
export const EXPLICIT_EC_FIXTURE = {
  sec1Key: `-----BEGIN EC PRIVATE KEY-----
MIIBaAIBAQQgL3TmAG6RTymf+/FhwHgMs0deQAd6XbRR0HyapTJNbsyggfowgfcC
AQEwLAYHKoZIzj0BAQIhAP////8AAAABAAAAAAAAAAAAAAAA////////////////
MFsEIP////8AAAABAAAAAAAAAAAAAAAA///////////////8BCBaxjXYqjqT57Pr
vVV2mIa8ZR0GsMxTsPY7zjw+J9JgSwMVAMSdNgiG5wSTamZ44ROdJreBn36QBEEE
axfR8uEsQkf4vOblY6RA8ncDfYEt6zOg9KE5RdiYwpZP40Li/hp/m47n60p8D54W
K84zV2sxXs7LtkBoN79R9QIhAP////8AAAAA//////////+85vqtpxeehPO5ysL8
YyVRAgEBoUQDQgAEYwhFe9aZFzFWmmTM2BK89BqWHAvDHBX3MtdoovUFcojZSZus
VvM1tlB8x/3MzDtENI+iwK787mlHRH9oguvgtQ==
-----END EC PRIVATE KEY-----
`,
  pkcs8Key: `-----BEGIN PRIVATE KEY-----
MIIBeQIBADCCAQMGByqGSM49AgEwgfcCAQEwLAYHKoZIzj0BAQIhAP////8AAAAB
AAAAAAAAAAAAAAAA////////////////MFsEIP////8AAAABAAAAAAAAAAAAAAAA
///////////////8BCBaxjXYqjqT57PrvVV2mIa8ZR0GsMxTsPY7zjw+J9JgSwMV
AMSdNgiG5wSTamZ44ROdJreBn36QBEEEaxfR8uEsQkf4vOblY6RA8ncDfYEt6zOg
9KE5RdiYwpZP40Li/hp/m47n60p8D54WK84zV2sxXs7LtkBoN79R9QIhAP////8A
AAAA//////////+85vqtpxeehPO5ysL8YyVRAgEBBG0wawIBAQQgL3TmAG6RTymf
+/FhwHgMs0deQAd6XbRR0HyapTJNbsyhRANCAARjCEV71pkXMVaaZMzYErz0GpYc
C8McFfcy12ii9QVyiNlJm6xW8zW2UHzH/czMO0Q0j6LArvzuaUdEf2iC6+C1
-----END PRIVATE KEY-----
`,
  certificate: `-----BEGIN CERTIFICATE-----
MIICkjCCAjigAwIBAgIUf6FDTfC9EKdaIX8d3jEbmD2aGfQwCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNZXhwbGljaXQudGVzdDAgFw0yNjEwMDcwMjA0MjNaGA8yMTI2
MDkxMzAyMDQyM1owGDEWMBQGA1UEAwwNZXhwbGljaXQudGVzdDCCAUswggEDBgcq
hkjOPQIBMIH3AgEBMCwGByqGSM49AQECIQD/////AAAAAQAAAAAAAAAAAAAAAP//
/////////////zBbBCD/////AAAAAQAAAAAAAAAAAAAAAP///////////////AQg
WsY12Ko6k+ez671VdpiGvGUdBrDMU7D2O848PifSYEsDFQDEnTYIhucEk2pmeOET
nSa3gZ9+kARBBGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4a
f5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfUCIQD/////AAAAAP//////////vOb6
racXnoTzucrC/GMlUQIBAQNCAARjCEV71pkXMVaaZMzYErz0GpYcC8McFfcy12ii
9QVyiNlJm6xW8zW2UHzH/czMO0Q0j6LArvzuaUdEf2iC6+C1o2owaDAdBgNVHQ4E
FgQUX5+vMgxXlYDT6jeUohf9pmpNdPgwHwYDVR0jBBgwFoAUX5+vMgxXlYDT6jeU
ohf9pmpNdPgwGAYDVR0RBBEwD4INZXhwbGljaXQudGVzdDAMBgNVHRMBAf8EAjAA
MAoGCCqGSM49BAMCA0gAMEUCIQC1KoikosHkrigsMB7VQq/OWbY0WeLwZdcebA67
Q0IVjgIgFVaZzS4gLvtE55aVY0EkqapUhfZulajGpfKl79HYI60=
-----END CERTIFICATE-----
`,
  namedCertificate: `-----BEGIN CERTIFICATE-----
MIIBnjCCAUSgAwIBAgIUGjMt1nQQsvrTJC2SaG2vpXV6Po8wCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNZXhwbGljaXQudGVzdDAgFw0yNjEwMDcwMjA0MjNaGA8yMTI2
MDkxMzAyMDQyM1owGDEWMBQGA1UEAwwNZXhwbGljaXQudGVzdDBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABGMIRXvWmRcxVppkzNgSvPQalhwLwxwV9zLXaKL1BXKI
2UmbrFbzNbZQfMf9zMw7RDSPosCu/O5pR0R/aILr4LWjajBoMB0GA1UdDgQWBBRf
n68yDFeVgNPqN5SiF/2mak10+DAfBgNVHSMEGDAWgBRfn68yDFeVgNPqN5SiF/2m
ak10+DAYBgNVHREEETAPgg1leHBsaWNpdC50ZXN0MAwGA1UdEwEB/wQCMAAwCgYI
KoZIzj0EAwIDSAAwRQIhAOlUrC9/0Ry3qO0iXj7Uyqck0Pe4NpMGF/wyzNYuhrWj
AiAmuvL8MtoYvkKaNMVQ5qFAeIgcYkCQ0r0YnTMFEsI6Vg==
-----END CERTIFICATE-----
`,
};
