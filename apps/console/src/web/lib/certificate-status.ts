import { type CertificateDto, certificateUnloadable } from "@edgeweir/contract";

/** What the certificate list shows: the stored status, "expired" or "unloadable". */
export type CertificateState = CertificateDto["status"] | "expired" | "unloadable";

const DAY = 86_400_000;

/** Whether a certificate's notAfter has passed at `now`. */
export function certificateExpired(notAfter: string | null, now = Date.now()): boolean {
  return !!notAfter && Date.parse(notAfter) <= now;
}

/**
 * A certificate's state at `now`: one past its notAfter is expired, whether
 * it was uploaded or issued (both stay "ready") or its renewal failed
 * ("error", the error still shows); a renewal in progress keeps its status.
 */
export function certificateState(
  cert: Pick<CertificateDto, "status" | "notAfter"> & { lastError?: string },
  now = Date.now(),
): CertificateState {
  // An upload nodes cannot load, expired or not: it is replaced either way.
  if (certificateUnloadable({ status: cert.status, lastError: cert.lastError ?? "" }))
    return "unloadable";
  const expired = certificateExpired(cert.notAfter, now);
  return expired && (cert.status === "ready" || cert.status === "error") ? "expired" : cert.status;
}

/** Whole days until `notAfter`, rounded up (0 once it has passed). */
export function certificateDaysLeft(notAfter: string, now = Date.now()): number {
  return Math.max(0, Math.ceil((Date.parse(notAfter) - now) / DAY));
}
