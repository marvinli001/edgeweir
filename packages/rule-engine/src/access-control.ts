/**
 * The decisions of a site's access control (ADR-0039) as nodes make them:
 * host and origin forms, Referer parsing, hotlink, user agent, geo and CORS
 * origin checks. The console validates settings with the same functions; the
 * node's Lua (edgeweir.access) passes the shared vectors in
 * test/access_vectors.json.
 */
import { wildcardMatchBytes, wildcardSegments } from "./index.ts";

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** A lowercase host name (labels of [a-z0-9_-], at most 253 bytes) or an IPv4 address. */
export function validHostName(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (IPV4.test(host)) return true;
  return host.split(".").every((label) => LABEL.test(label));
}

/** An IPv6 address as written between brackets in a URL (no zone). */
function validIpv6(text: string): boolean {
  if (!/^[0-9a-f:.]+$/.test(text) || !text.includes(":")) return false;
  const v4 = text.includes(".");
  const parts = text.split("::");
  if (parts.length > 2) return false;
  const groups = (s: string) => (s === "" ? [] : s.split(":"));
  const head = groups(parts[0] ?? "");
  const tail = parts.length === 2 ? groups(parts[1] ?? "") : [];
  const all = [...head, ...tail];
  let count = all.length;
  for (let i = 0; i < all.length; i++) {
    const g = all[i] ?? "";
    if (v4 && i === all.length - 1) {
      if (!IPV4.test(g)) return false;
      count += 1;
    } else if (!/^[0-9a-f]{1,4}$/.test(g)) return false;
  }
  return parts.length === 2 ? count <= 7 : count === 8;
}

/**
 * A hotlink source as stored: "a.com", "*.a.com", ".a.com" or "*", lowercase,
 * a trailing dot removed; null when invalid.
 */
export function normalizeHostForm(text: string): string | null {
  let form = text.trim().toLowerCase();
  if (form === "*") return form;
  if (form.endsWith(".") && form.length > 1) form = form.slice(0, -1);
  if (form.startsWith("*."))
    return validHostName(form.slice(2)) && !IPV4.test(form.slice(2)) ? form : null;
  if (form.startsWith("."))
    return validHostName(form.slice(1)) && !IPV4.test(form.slice(1)) ? form : null;
  return validHostName(form) ? form : null;
}

/** Whether a normalized host form matches a host (lowercase, no trailing dot). */
export function hostFormMatches(form: string, host: string): boolean {
  if (form === "*") return true;
  if (form.startsWith("*.")) {
    const rest = form.slice(1);
    if (!host.endsWith(rest)) return false;
    const label = host.slice(0, host.length - rest.length);
    return label.length > 0 && !label.includes(".");
  }
  if (form.startsWith(".")) return host.length > form.length && host.endsWith(form);
  return host === form;
}

/**
 * The host of a Referer (or Origin) value: an http(s) URL's host, lowercase,
 * without user information, port and one trailing dot, IPv6 without
 * brackets. Null when the value is no such URL or its host is invalid.
 */
export function refererHost(value: string): string | null {
  const m = /^(https?):\/\/([^/?#]*)/i.exec(value);
  if (!m) return null;
  let authority = m[2] ?? "";
  const at = authority.lastIndexOf("@");
  if (at >= 0) authority = authority.slice(at + 1);
  let host: string;
  let port: string;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) return null;
    host = authority.slice(1, close).toLowerCase();
    const rest = authority.slice(close + 1);
    if (rest !== "" && !rest.startsWith(":")) return null;
    port = rest.slice(1);
    if (!validIpv6(host)) return null;
  } else {
    const colon = authority.indexOf(":");
    host = (colon < 0 ? authority : authority.slice(0, colon)).toLowerCase();
    port = colon < 0 ? "" : authority.slice(colon + 1);
    if (host.endsWith(".")) host = host.slice(0, -1);
    if (!validHostName(host)) return null;
  }
  if (port !== "" && (!/^\d{1,5}$/.test(port) || Number(port) > 65535)) return null;
  return host;
}

const DEFAULT_PORTS: Record<string, string> = { http: "80", https: "443" };

interface Origin {
  scheme: string;
  host: string;
  port: string;
}

function parseOrigin(text: string, wildcard: boolean): Origin | null {
  const m = /^(https?):\/\/([^/?#@\s]+)$/i.exec(text);
  if (!m) return null;
  const scheme = (m[1] ?? "").toLowerCase();
  const authority = m[2] ?? "";
  const colon = authority.lastIndexOf(":");
  let host = (colon < 0 ? authority : authority.slice(0, colon)).toLowerCase();
  let port = colon < 0 ? "" : authority.slice(colon + 1);
  if (port !== "") {
    if (!/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535) return null;
    if (port === DEFAULT_PORTS[scheme]) port = "";
  }
  if (wildcard && host.startsWith("*.")) {
    const rest = host.slice(2);
    if (!validHostName(rest) || IPV4.test(rest)) return null;
  } else if (!validHostName(host)) return null;
  host = host.toLowerCase();
  return { scheme, host, port };
}

function formatOrigin(o: Origin): string {
  return `${o.scheme}://${o.host}${o.port ? `:${o.port}` : ""}`;
}

/**
 * A CORS or WebSocket origin as stored: "scheme://host[:port]" (http or
 * https; lowercase; the default port left out), the host may start with
 * "*."; "*" alone only when `star`. Null when invalid.
 */
export function normalizeOriginForm(text: string, star = false): string | null {
  const t = text.trim();
  if (t === "*") return star ? "*" : null;
  const o = parseOrigin(t, true);
  return o ? formatOrigin(o) : null;
}

/** A request's Origin header normalized like the forms; null when it is no such origin. */
export function normalizeOrigin(value: string): string | null {
  const o = parseOrigin(value, false);
  return o ? formatOrigin(o) : null;
}

/** Whether a normalized origin form (not "*") matches a normalized origin. */
export function originFormMatches(form: string, origin: string): boolean {
  const f = parseOrigin(form, true);
  const o = parseOrigin(origin, false);
  if (!f || !o || f.scheme !== o.scheme || f.port !== o.port) return false;
  return f.host.startsWith("*.") ? hostFormMatches(f.host, o.host) : f.host === o.host;
}

/** Whether `path` is in a scope: under a prefix (none: every path) and under no excluded one. */
export function pathInScope(
  path: string,
  prefixes: readonly string[],
  excluded: readonly string[] = [],
): boolean {
  if (prefixes.length && !prefixes.some((p) => path.startsWith(p))) return false;
  return !excluded.some((p) => path.startsWith(p));
}

/** A user agent pattern: "" or a valid wildcard of 1-512 printable ASCII bytes. */
export function validUserAgentPattern(pattern: string): boolean {
  if (pattern === "") return true;
  if (pattern.length > 512 || !/^[\x20-\x7e]+$/.test(pattern)) return false;
  try {
    wildcardSegments(pattern);
    return true;
  } catch {
    return false;
  }
}

export interface UserAgentRuleModel {
  pattern: string;
  allow: boolean;
}

/**
 * The user agent decision: an allow rule matching passes; else a deny rule
 * matching denies; else the request passes. `ua` is the User-Agent value
 * (several headers joined with ", "), "" when missing.
 */
export function userAgentDecision(
  rules: readonly UserAgentRuleModel[],
  ua: string,
): "pass" | "deny" {
  const matches = (r: UserAgentRuleModel) =>
    r.pattern === "" ? ua === "" : wildcardMatchBytes(ua, r.pattern);
  if (rules.some((r) => r.allow && matches(r))) return "pass";
  return rules.some((r) => !r.allow && matches(r)) ? "deny" : "pass";
}

export interface HotlinkModel {
  allowEmpty: boolean;
  allowSiteDomains: boolean;
  allowed: string[];
  denied: string[];
  checkOrigin: boolean;
  extensions: string[];
  pathPrefixes: string[];
  excludePathPrefixes: string[];
  redirectUrl: string;
}

export interface HotlinkRequest {
  path: string;
  /** http.request.uri.path.extension: lowercase, "" without one. */
  extension: string;
  referer: string;
  origin: string;
  /** Whether the node resolves a host to this site. */
  siteHost: (host: string) => boolean;
}

/** The hotlink decision: "skip" out of scope, else "pass" or "deny". */
export function hotlinkDecision(cfg: HotlinkModel, req: HotlinkRequest): "skip" | "pass" | "deny" {
  const selected =
    (cfg.extensions.length === 0 && cfg.pathPrefixes.length === 0) ||
    cfg.extensions.includes(req.extension) ||
    cfg.pathPrefixes.some((p) => req.path.startsWith(p));
  if (!selected || cfg.excludePathPrefixes.some((p) => req.path.startsWith(p))) return "skip";
  if (cfg.redirectUrl.startsWith("/") && req.path === cfg.redirectUrl.split(/[?#]/)[0])
    return "skip";
  const values = [req.referer, cfg.checkOrigin ? req.origin : ""].filter((v) => v !== "");
  if (values.length === 0) return cfg.allowEmpty ? "pass" : "deny";
  for (const value of values) {
    const host = refererHost(value);
    if (host === null) return "deny";
    if (cfg.denied.some((f) => hostFormMatches(f, host))) return "deny";
    if (cfg.allowSiteDomains && req.siteHost(host)) continue;
    if (!cfg.allowed.some((f) => hostFormMatches(f, host))) return "deny";
  }
  return "pass";
}

export interface GeoAccessModel {
  allowOnly: boolean;
  countries: string[];
  subdivisions: string[];
  asns: number[];
  pathPrefixes: string[];
  exceptPathPrefixes: string[];
}

export interface GeoRecord {
  country: string;
  subdivision: string;
  asnum: number;
}

/** Whether a client's GeoIP record matches any of the lists. */
export function geoMatches(cfg: GeoAccessModel, geo: GeoRecord): boolean {
  if (geo.country !== "" && cfg.countries.includes(geo.country)) return true;
  if (geo.country !== "" && geo.subdivision !== "") {
    const key = `${geo.country}-${geo.subdivision}`.toLowerCase();
    if (cfg.subdivisions.some((s) => s.toLowerCase() === key)) return true;
  }
  return geo.asnum > 0 && cfg.asns.includes(geo.asnum);
}

/** The geo decision for a request in scope. */
export function geoDecision(cfg: GeoAccessModel, geo: GeoRecord): "pass" | "deny" {
  return geoMatches(cfg, geo) === cfg.allowOnly ? "pass" : "deny";
}

/**
 * The Access-Control-Allow-Origin a CORS setting gives a request's Origin:
 * "*" for "*" without credentials, the Origin itself when a form matches,
 * null when the origin is not allowed (or missing).
 */
export function corsAllowOrigin(
  cfg: { allowedOrigins: readonly string[]; allowCredentials: boolean },
  origin: string,
): string | null {
  if (origin === "") return null;
  if (!cfg.allowCredentials && cfg.allowedOrigins.includes("*")) return "*";
  const normalized = normalizeOrigin(origin);
  if (normalized === null) return null;
  return cfg.allowedOrigins.some((f) => f !== "*" && originFormMatches(f, normalized))
    ? origin
    : null;
}

/** Whether a WebSocket upgrade's Origin passes a list (empty: every origin). */
export function websocketOriginAllowed(origins: readonly string[], origin: string): boolean {
  if (origins.length === 0) return true;
  const normalized = origin === "" ? null : normalizeOrigin(origin);
  return normalized !== null && origins.some((f) => originFormMatches(f, normalized));
}
