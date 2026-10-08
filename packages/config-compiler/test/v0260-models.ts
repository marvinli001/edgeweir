import { parseExpression } from "@edgeweir/rule-engine";
import type { CompileInput } from "../src/index";
import { site, tls } from "./v0230-models";

/** A self-signed ECDSA P-256 CA (CN=Edgeweir G11 vector CA, 2026-2046); no key is committed. */
export const VECTOR_CLIENT_CA =
  "-----BEGIN CERTIFICATE-----\nMIIBVzCB/qADAgECAgILETAKBggqhkjOPQQDAjAhMR8wHQYDVQQDExZFZGdld2Vp\nciBHMTEgdmVjdG9yIENBMB4XDTI2MDEwMTAwMDAwMFoXDTQ2MDEwMTAwMDAwMFow\nITEfMB0GA1UEAxMWRWRnZXdlaXIgRzExIHZlY3RvciBDQTBZMBMGByqGSM49AgEG\nCCqGSM49AwEHA0IABNIvw6o2z+Y6TdXLM3Zg8ho9YLAkLylVVArzoR4CaByEcafl\nTd2x94FNKW76LHSCeMl3y1+7y9HFKjkPxtgVHDCjJjAkMBIGA1UdEwEB/wQIMAYB\nAf8CAQAwDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMCA0gAMEUCIQDNW4suHpPe\n2oyav7yguz8JNo1fe2082+r9KO6vrHQR9AIgV7mT2XiwYAeaNu/AUDm5eDSIpVxq\n/13mwC976EolPR4=\n-----END CERTIFICATE-----\n";

const ref = (id: string, names: string[], fingerprint: string) => ({
  id,
  names,
  sha256Fingerprint: fingerprint.repeat(64),
});

/**
 * The console models behind the v0.26.0 vector: site a with an ECDSA and
 * an RSA certificate for a.test and a third certificate for b-a.test (the
 * site's order kept, not sorted), required client certificates with header
 * forwarding and a rule reading tls.client.verified; site b with one
 * certificate; the cluster's session ticket keys given out of order.
 */
export const v0260Models = (): CompileInput => ({
  clusterId: "c1",
  certificates: [
    ref("cert-ec", ["a.test"], "a"),
    ref("cert-rsa", ["a.test"], "b"),
    ref("cert-b", ["b-a.test"], "c"),
    ref("cert-site-b", ["b.test"], "d"),
  ] as never,
  sites: [
    site("a", {
      domains: [
        { name: "a.test", wildcard: false },
        { name: "b-a.test", wildcard: false },
      ],
      certificateId: "cert-ec",
      additionalCertificateIds: ["cert-rsa", "cert-b"],
      clientCertificate: {
        mode: "required",
        caPem: VECTOR_CLIENT_CA,
        depth: 2,
        forwardHeaders: true,
      },
      tls: tls(),
      rules: [
        {
          id: "mtls",
          phase: "waf-custom",
          expression: parseExpression(
            'tls.client.verified eq false and http.request.uri.path ne "/public"',
            "waf-custom",
          ),
          action: { kind: "block", statusCode: 403 },
        },
      ],
    }),
    site("b", { certificateId: "cert-site-b", tls: tls() }),
  ],
  sessionTicketKeys: [
    { id: "k3", role: "next" },
    { id: "k1", role: "previous" },
    { id: "k2", role: "current" },
  ],
});
