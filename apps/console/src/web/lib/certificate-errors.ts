import { isCertificateErrorCode } from "@edgeweir/contract";
// Relative on purpose: the module is unit-tested outside Vite's "@" alias.
import { m } from "../paraglide/messages.js";

type MessageFn = (params?: Record<string, string>) => string;
const messages = m as unknown as Record<string, MessageFn | undefined>;

/**
 * Why a certificate's last issuance failed (its `lastError`), in the
 * current locale: certificate codes, then DNS provider codes of DNS-01
 * (worded as for DNS revisions), then the code itself.
 */
export function certificateErrorText(code: string): string {
  if (!code) return "";
  const text = isCertificateErrorCode(code) ? messages[`cert_error_${code}`]?.() : undefined;
  if (text) return text;
  const dns = /^[a-z0-9_]+$/.test(code) ? messages[`dns_error_${code}`]?.() : undefined;
  return dns ?? m.cert_error_other({ code });
}
