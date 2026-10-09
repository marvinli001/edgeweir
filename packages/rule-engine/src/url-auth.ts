// Signed URLs of access authentication rules (kinds A-D, ADR-0038). The
// console signs URLs with these functions; nodes check them in
// edgeweir.auth. test/url_auth_vectors.json, copied to edgeweir-node
// (test/lua/url_auth_vectors.json), keeps both sides in step.
//
//   A  path?sign=ts-rand-md5(path@ts@rand@key)
//   B  /ts/md5(path@ts@key)/path
//   C  /md5(path@ts@key)/ts/path
//   D  path?sign=md5(path@ts@key)&t=ts
//
// path is the request's raw path (before "?", percent-encoding as sent);
// for B and C the part after the two signature segments. Parameter values
// are taken as they are (no decoding).
import { md5Hex } from "./digest.ts";

export const URL_AUTH_KINDS = ["url_a", "url_b", "url_c", "url_d"] as const;
export type UrlAuthKind = (typeof URL_AUTH_KINDS)[number];

export const DEFAULT_SIGN_PARAM = "sign";
export const DEFAULT_TIME_PARAM = "t";
/** Names of the signature and timestamp parameters (A, D). */
export const URL_AUTH_PARAM = /^[A-Za-z0-9_-]{1,32}$/;
/** A signing key: printable ASCII without spaces. */
export const URL_AUTH_KEY = /^[\x21-\x7e]{16,128}$/;
export const URL_AUTH_RAND = /^[A-Za-z0-9]{1,64}$/;

const TS = /^[0-9]{1,12}$/;
const HASH = /^[0-9a-f]{32}$/;
const SEGMENTS = {
  url_b: /^\/([0-9]{1,12})\/([0-9a-f]{32})(\/.*)$/s,
  url_c: /^\/([0-9a-f]{32})\/([0-9]{1,12})(\/.*)$/s,
} as const;

export interface UrlAuthNames {
  signParam: string;
  timeParam: string;
}

/** The UTF-8 bytes of text as a byte string (md5Hex hashes one character per byte). */
function utf8(text: string): string {
  return String.fromCharCode(...new TextEncoder().encode(text));
}

/** md5(path@ts@key), or md5(path@ts@rand@key) for kind A. */
export function urlAuthHash(path: string, ts: string, key: string, rand?: string): string {
  return md5Hex(utf8(rand === undefined ? `${path}@${ts}@${key}` : `${path}@${ts}@${rand}@${key}`));
}

/** The name of a query element: the text before its first "=". */
const elementName = (element: string) => {
  const eq = element.indexOf("=");
  return eq < 0 ? element : element.slice(0, eq);
};

/** The value of a query element: the text after its first "=" ("" without one). */
const elementValue = (element: string) => {
  const eq = element.indexOf("=");
  return eq < 0 ? "" : element.slice(eq + 1);
};

/** The non-empty elements of a query string. */
const elements = (query: string) => query.split("&").filter((e) => e !== "");

/** Splits a request URI into its raw path and query (null: no "?"). */
export function splitRequestUri(uri: string): { path: string; query: string | null } {
  const q = uri.indexOf("?");
  return q < 0 ? { path: uri, query: null } : { path: uri.slice(0, q), query: uri.slice(q + 1) };
}

/** A signature found in a request URI, and the URI without it. */
export interface ParsedSignature {
  /** The path the hash covers. */
  path: string;
  ts: string;
  /** Kind A only. */
  rand?: string;
  hash: string;
  /** The request URI without the signature (path and query). */
  stripped: string;
}

/**
 * The signature of a request URI (raw path and query, no fragment) of a rule
 * of kind, or null when it carries none in the expected form. The first
 * element of a parameter counts; all of them are removed.
 */
export function parseSignedUri(
  kind: UrlAuthKind,
  uri: string,
  names: UrlAuthNames,
): ParsedSignature | null {
  const { path, query } = splitRequestUri(uri);
  if (kind === "url_b" || kind === "url_c") {
    const m = SEGMENTS[kind].exec(path);
    if (!m) return null;
    const [ts, hash] = kind === "url_b" ? [m[1], m[2]] : [m[2], m[1]];
    const rest = m[3] as string;
    return {
      path: rest,
      ts: ts as string,
      hash: hash as string,
      stripped: query === null ? rest : `${rest}?${query}`,
    };
  }
  const list = elements(query ?? "");
  const first = (name: string) => {
    const found = list.find((e) => elementName(e) === name);
    return found === undefined ? null : elementValue(found);
  };
  const drop = new Set(kind === "url_d" ? [names.signParam, names.timeParam] : [names.signParam]);
  const kept = list.filter((e) => !drop.has(elementName(e)));
  const stripped = kept.length ? `${path}?${kept.join("&")}` : path;
  const sign = first(names.signParam);
  if (sign === null) return null;
  if (kind === "url_a") {
    const m = /^([0-9]{1,12})-([A-Za-z0-9]{1,64})-([0-9a-f]{32})$/.exec(sign);
    if (!m) return null;
    return { path, ts: m[1] as string, rand: m[2] as string, hash: m[3] as string, stripped };
  }
  const ts = first(names.timeParam);
  if (ts === null || !TS.test(ts) || !HASH.test(sign)) return null;
  return { path, ts, hash: sign, stripped };
}

/** Constant-time comparison of two strings of the same length (else false). */
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type UrlAuthOutcome = "ok" | "expired" | "denied";

export interface UrlAuthCheck extends UrlAuthNames {
  /** The primary key, then the backup key if set. */
  keys: readonly string[];
  validitySeconds: number;
  skewSeconds: number;
  /** Unix seconds. */
  now: number;
}

/**
 * Checks a request URI against a rule of kind, as nodes do: "denied" without
 * a signature or when no key produces it, "expired" outside ts - skew to ts
 * + validity + skew, else "ok". stripped is the URI rules, the cache and the
 * origin see (the original one when no signature was found).
 */
export function checkSignedUri(
  kind: UrlAuthKind,
  uri: string,
  check: UrlAuthCheck,
): { outcome: UrlAuthOutcome; stripped: string } {
  const parsed = parseSignedUri(kind, uri, check);
  if (!parsed) return { outcome: "denied", stripped: uri };
  let match = false;
  for (const key of check.keys) {
    // Every key is tried: the time taken does not tell which one matched.
    if (sameText(urlAuthHash(parsed.path, parsed.ts, key, parsed.rand), parsed.hash)) match = true;
  }
  if (!match) return { outcome: "denied", stripped: parsed.stripped };
  const ts = Number(parsed.ts);
  const ok =
    check.now >= ts - check.skewSeconds &&
    check.now <= ts + check.validitySeconds + check.skewSeconds;
  return { outcome: ok ? "ok" : "expired", stripped: parsed.stripped };
}

export interface UrlAuthSigning extends UrlAuthNames {
  key: string;
  /** Unix seconds. */
  ts: number;
  /** Kind A: 1-64 letters and digits. */
  rand?: string;
}

/**
 * Signs a URL's path and query (raw, as clients send them; an optional
 * "#fragment" stays last) for a rule of kind. Signature parameters already
 * in the query are replaced.
 */
export function signUri(kind: UrlAuthKind, uri: string, signing: UrlAuthSigning): string {
  const hashAt = uri.indexOf("#");
  const fragment = hashAt < 0 ? "" : uri.slice(hashAt);
  const { path, query } = splitRequestUri(hashAt < 0 ? uri : uri.slice(0, hashAt));
  if (!path.startsWith("/")) throw new Error("the path must start with /");
  const ts = String(Math.floor(signing.ts));
  if (!TS.test(ts)) throw new Error("invalid timestamp");
  if (kind === "url_b" || kind === "url_c") {
    const hash = urlAuthHash(path, ts, signing.key);
    const prefix = kind === "url_b" ? `/${ts}/${hash}` : `/${hash}/${ts}`;
    return `${prefix}${path}${query === null ? "" : `?${query}`}${fragment}`;
  }
  const drop = new Set(
    kind === "url_d" ? [signing.signParam, signing.timeParam] : [signing.signParam],
  );
  const kept = elements(query ?? "").filter((e) => !drop.has(elementName(e)));
  if (kind === "url_a") {
    const rand = signing.rand ?? "";
    if (!URL_AUTH_RAND.test(rand)) throw new Error("invalid rand");
    kept.push(`${signing.signParam}=${ts}-${rand}-${urlAuthHash(path, ts, signing.key, rand)}`);
  } else {
    kept.push(
      `${signing.signParam}=${urlAuthHash(path, ts, signing.key)}`,
      `${signing.timeParam}=${ts}`,
    );
  }
  return `${path}?${kept.join("&")}${fragment}`;
}
