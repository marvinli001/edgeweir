/// <reference path="./tr46.d.ts" />
import { ldhHost, needsIdna, parseSiteDomain, punycodeDecode } from "@edgeweir/contract";
import { toASCII } from "tr46";

/**
 * The ASCII form of a host name: UTS #46 ToASCII with nontransitional
 * processing, CheckBidi, CheckJoiners, UseSTD3ASCIIRules and VerifyDnsLength
 * on and CheckHyphens off (so "ab--c" labels stay valid, as in LDH), then the
 * LDH rules; a Unicode label may not begin or end with a hyphen either (the
 * part of CheckHyphens that LDH applies to ASCII labels). Pure ASCII without
 * `xn--` labels is only lowercased. Null when the name is not valid.
 */
export function toAsciiHost(host: string): string | null {
  if (!needsIdna(host)) {
    const lower = host.toLowerCase();
    return ldhHost(lower) ? lower : null;
  }
  const ascii = toASCII(host, {
    checkBidi: true,
    checkHyphens: false,
    checkJoiners: true,
    ignoreInvalidPunycode: false,
    transitionalProcessing: false,
    useSTD3ASCIIRules: true,
    verifyDNSLength: true,
  });
  if (ascii === null || !ldhHost(ascii)) return null;
  for (const label of ascii.split(".")) {
    if (!label.startsWith("xn--")) continue;
    const unicode = punycodeDecode(label.slice(4));
    if (unicode === null || unicode.startsWith("-") || unicode.endsWith("-")) return null;
  }
  return ascii;
}

/** A formatted site domain (contract `siteDomain`) with its host in ASCII; null when not valid. */
export function normalizeSiteDomain(formatted: string) {
  return parseSiteDomain(formatted, toAsciiHost);
}
