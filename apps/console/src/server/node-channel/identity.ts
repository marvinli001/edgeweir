import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import type { NodeInfo } from "@edgeweir/proto";
import type { AppContext } from "../lib/context";
import type { IssuedCertificate } from "../pki/ca";
import { acceptedCertificate } from "../services/nodes";

/** Signs the CSR of an enrollment or renewal; one the CA refuses is the caller's error. */
export async function signCsr(sign: () => Promise<IssuedCertificate>): Promise<IssuedCertificate> {
  try {
    return await sign();
  } catch (error) {
    throw new ConnectError(`rejected CSR: ${(error as Error).message}`, Code.InvalidArgument);
  }
}

/** A node's or probe's row columns for its current certificate. */
export const certificateColumns = (issued: IssuedCertificate) => ({
  certSerial: issued.serialNumber,
  certFingerprint: issued.fingerprintSha256,
  certNotAfter: issued.notAfter,
});

/**
 * The serial a renewal keeps accepted (the row read for update): the
 * certificate the caller authenticated with stays accepted until it uses
 * the new one, so one that could not install the new certificate keeps
 * working and renews again.
 */
export function keptSerial(
  row: { certSerial: string | null; previousCertSerial: string | null } | undefined,
  peerSerial: string | undefined,
): string | null {
  const certificate = row && acceptedCertificate(row, peerSerial);
  if (!certificate) throw new ConnectError("certificate has been superseded", Code.Unauthenticated);
  return certificate === "current" ? row.certSerial : row.previousCertSerial;
}

/** The certificate fields of an enrollment or renewal response. */
export const issuedCertificateResponse = (
  app: Pick<AppContext, "nodeCa">,
  issued: IssuedCertificate,
) => ({
  certificatePem: issued.certificatePem,
  caCertificatePem: app.nodeCa.certificatePem,
  notAfter: timestampFromDate(issued.notAfter),
});

/** The features a node reports, as stored: distinct, well-formed, at most 64. */
export const supportedFeatures = (features: readonly string[]) =>
  [...new Set(features)].filter((f) => /^[a-z0-9-]{1,64}$/.test(f)).slice(0, 64);

/** What a node reports about its host and agent (none: empty), as stored on its row. */
export const nodeInfoColumns = (info: NodeInfo | undefined) => ({
  hostname: info?.hostname ?? "",
  agentVersion: info?.agentVersion ?? "",
  supportedFeatures: supportedFeatures(info?.supportedFeatures ?? []),
  engine: info?.engine ?? "",
  engineVersion: info?.engineVersion ?? "",
  os: info?.os ?? "",
  arch: info?.arch ?? "",
});
