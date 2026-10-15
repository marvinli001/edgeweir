import type { CompileInput, OriginPoolSettingsModel } from "../src/index";
import { site, tls } from "./v0230-models";

/** A test Origin CA (ECDSA P-256) and the empty CRL it signed. */
export const VECTOR_ORIGIN_CA =
  "-----BEGIN CERTIFICATE-----\nMIIBfjCCASOgAwIBAgIJAMNby8wL02L2MAoGCCqGSM49BAMCMDAxGzAZBgNVBAMM\nEkVkZ2V3ZWlyIE9yaWdpbiBDQTERMA8GA1UECgwIRWRnZXdlaXIwHhcNMjYxMDE0\nMTEwNTQ4WhcNNDYxMDA5MTEwNTQ4WjAwMRswGQYDVQQDDBJFZGdld2VpciBPcmln\naW4gQ0ExETAPBgNVBAoMCEVkZ2V3ZWlyMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcD\nQgAEs8Geila/nM+LAbqiu8JjDbIf41bE3G1r82LO2xq8TjV5i2oSIkJ4j5Lovhyj\nkkhzLerv5HjFM2mxGv7ZZCE6OqMmMCQwEgYDVR0TAQH/BAgwBgEB/wIBADAOBgNV\nHQ8BAf8EBAMCAQYwCgYIKoZIzj0EAwIDSQAwRgIhAP3vrvLSFSqa9S0RTGqrZq41\nGpQy9lxVmASpPMN0utj/AiEA4shYb+8N787yD9sVGQ8heh+fixBspdo1pQL+p+RI\nyVE=\n-----END CERTIFICATE-----\n";
export const VECTOR_ORIGIN_CRL =
  "-----BEGIN X509 CRL-----\nMIHIMG8CAQEwCgYIKoZIzj0EAwIwMDEbMBkGA1UEAwwSRWRnZXdlaXIgT3JpZ2lu\nIENBMREwDwYDVQQKDAhFZGdld2VpchcNMjYxMDE0MTEwNTQ4WhcNNDYxMDA5MTEw\nNTQ4WqAOMAwwCgYDVR0UBAMCAQEwCgYIKoZIzj0EAwIDSQAwRgIhAIOCGaXLs8M0\nLrf8h0ADnuwgH6D5HFUY+WZlkJMJS75oAiEA8kskg/qYmjLq2arbH4kTt+ersvGP\nr5WZzdFVIldV5cI=\n-----END X509 CRL-----\n";

export const poolSettings: OriginPoolSettingsModel = {
  tlsVerify: true,
  maxFails: 3,
  recoverySeconds: 30,
  connectTimeoutMs: 10_000,
  sendTimeoutMs: 60_000,
  readTimeoutMs: 60_000,
  keepalive: true,
  keepaliveIdleSeconds: 60,
  keepaliveMaxRequests: 1000,
};

const https = (id: string) => ({
  id: `o-${id}`,
  address: "origin.test",
  port: 443,
  scheme: "https" as const,
  weight: 1,
  backup: false,
  hostHeader: "",
  sni: "origin.test",
});

/** A site whose pool has the given settings and one HTTPS origin. */
export const protectedSite = (id: string, settings: Partial<OriginPoolSettingsModel>) => {
  const model = site(id, { tls: tls() });
  return {
    ...model,
    originPool: {
      ...model.originPool,
      origins: [https(id)],
      settings: { ...poolSettings, ...settings },
    },
  };
};

/**
 * The console models behind the v1.3.0 vector: site a presents the
 * cluster's origin client certificate, site b verifies its origin against
 * the Origin CA alone, site c does both and site d neither.
 */
export const v130Models = (): CompileInput => ({
  clusterId: "c1",
  sites: [
    protectedSite("a", { clientCertificateId: "occ-2" }),
    protectedSite("b", { tlsTrust: "originCa" }),
    protectedSite("c", { tlsTrust: "originCa", clientCertificateId: "occ-2" }),
    protectedSite("d", {}),
  ],
  originClientCertificates: [
    { id: "occ-2", names: [], sha256Fingerprint: "b".repeat(64) },
    { id: "occ-1", names: [], sha256Fingerprint: "c".repeat(64) },
  ] as never,
  originCa: { certificatePem: VECTOR_ORIGIN_CA, crlPem: VECTOR_ORIGIN_CRL },
});
