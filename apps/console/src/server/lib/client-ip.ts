import { BlockList, isIP } from "node:net";

/**
 * Header the console sets on requests it hands to better-auth (and to server
 * side `auth.api.*` calls): the client IP it resolved itself. Any incoming
 * copy is removed first, so better-auth never reads a client-supplied value.
 */
export const CLIENT_IP_HEADER = "x-edgeweir-client-ip";

/** Headers a client could use to claim another address. */
const FORWARDING_HEADERS = ["x-forwarded-for", "x-real-ip", CLIENT_IP_HEADER] as const;

/** IPv4-mapped IPv6 (`::ffff:192.0.2.1`) as plain IPv4; brackets removed. */
export function normalizeIp(value: string): string {
  const ip = value.trim().replace(/^\[(.*)\]$/, "$1");
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1] && isIP(mapped[1]) === 4) return mapped[1];
  return isIP(ip) ? ip.toLowerCase() : "";
}

/** The reverse proxies whose forwarding headers are believed (EDGEWEIR_TRUSTED_PROXIES). */
export class TrustedProxies {
  readonly entries: readonly string[];
  private readonly list = new BlockList();

  /** Comma-separated IPs and CIDR ranges; throws on an entry that is neither. */
  constructor(spec: string) {
    const entries: string[] = [];
    for (const raw of spec.split(",")) {
      const entry = raw.trim();
      if (!entry) continue;
      const [address = "", prefix, ...rest] = entry.split("/");
      const ip = normalizeIp(address);
      const family = isIP(ip);
      const bits = prefix === undefined ? (family === 6 ? 128 : 32) : Number(prefix);
      const max = family === 6 ? 128 : 32;
      if (
        !family ||
        rest.length > 0 ||
        (prefix !== undefined && !/^\d{1,3}$/.test(prefix)) ||
        bits > max
      ) {
        throw new Error(`not an IP address or CIDR range: ${entry}`);
      }
      this.list.addSubnet(ip, bits, family === 6 ? "ipv6" : "ipv4");
      entries.push(entry);
    }
    this.entries = entries;
  }

  get size(): number {
    return this.entries.length;
  }

  has(address: string): boolean {
    const ip = normalizeIp(address);
    const family = isIP(ip);
    if (!family || this.entries.length === 0) return false;
    return this.list.check(ip, family === 6 ? "ipv6" : "ipv4");
  }
}

/**
 * The client address of a request. X-Forwarded-For and X-Real-IP are honored
 * only when the TCP peer is a trusted proxy: the forwarded chain is walked
 * from the right, trusted hops are skipped and the first untrusted address is
 * the client. Otherwise the socket address is the client, whatever the
 * headers say.
 */
export function resolveClientIp(peer: string, headers: Headers, trusted: TrustedProxies): string {
  const socket = normalizeIp(peer);
  if (!socket || !trusted.has(socket)) return socket;
  const chain = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  if (chain.length > 0) {
    let client = socket;
    for (let i = chain.length - 1; i >= 0; i--) {
      const hop = normalizeIp(chain[i] ?? "");
      // A malformed hop ends what can be believed; keep the last good one.
      if (!hop) return client;
      client = hop;
      if (!trusted.has(hop)) return hop;
    }
    return client;
  }
  const real = normalizeIp(headers.get("x-real-ip") ?? "");
  return real || socket;
}

/** A copy of the headers without any client-supplied forwarding claims, carrying the resolved IP. */
export function withClientIp(source: Headers, ip: string): Headers {
  const headers = new Headers(source);
  for (const name of FORWARDING_HEADERS) headers.delete(name);
  if (ip) headers.set(CLIENT_IP_HEADER, ip);
  return headers;
}
