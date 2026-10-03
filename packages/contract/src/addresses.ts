/**
 * IP literals, CIDRs and the special-purpose address ranges origins may not
 * use unless the platform allows them (N-H2). Pure functions, shared by the
 * server and the web UI; the edge nodes apply the same list to DNS answers.
 */

export interface IpAddress {
  version: 4 | 6;
  /** 4 or 16 bytes, network order. */
  bytes: Uint8Array;
}

export interface Cidr extends IpAddress {
  /** Prefix length: 0–32 for IPv4, 0–128 for IPv6. */
  prefix: number;
}

const DEC_OCTET = /^(?:0|[1-9][0-9]{0,2})$/;
const HEXTET = /^[0-9a-f]{1,4}$/i;

/** Strict dotted-quad IPv4 ("10.0.0.1"): four decimal octets, no leading zeros. */
export function parseIPv4(text: string): Uint8Array | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (const [i, part] of parts.entries()) {
    if (!DEC_OCTET.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes[i] = n;
  }
  return bytes;
}

/**
 * IPv6 text form (RFC 4291 section 2.2): hex groups, one "::", and an
 * optional dotted IPv4 in the last 32 bits. Zone ids are not accepted.
 */
export function parseIPv6(text: string): Uint8Array | null {
  if (text.length < 2 || text.length > 45 || !/^[0-9a-f:.]+$/i.test(text)) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (part: string | undefined) => (part ? part.split(":") : []);
  const head = groups(halves[0]);
  const tail = halves.length === 2 ? groups(halves[1]) : [];
  const words: number[] = [];
  const tailWords: number[] = [];
  const read = (list: string[], out: number[], lastMayBeV4: boolean) => {
    for (const [i, group] of list.entries()) {
      if (lastMayBeV4 && i === list.length - 1 && group.includes(".")) {
        const v4 = parseIPv4(group);
        if (!v4) return false;
        out.push(((v4[0] ?? 0) << 8) | (v4[1] ?? 0), ((v4[2] ?? 0) << 8) | (v4[3] ?? 0));
        continue;
      }
      if (!HEXTET.test(group)) return false;
      out.push(Number.parseInt(group, 16));
    }
    return true;
  };
  if (halves.length === 2) {
    if (!read(head, words, false) || !read(tail, tailWords, true)) return null;
    if (words.length + tailWords.length > 7) return null;
    while (words.length + tailWords.length < 8) words.push(0);
  } else {
    if (!read(head, words, true) || words.length !== 8) return null;
  }
  const all = [...words, ...tailWords];
  if (all.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (const [i, word] of all.entries()) {
    bytes[2 * i] = word >> 8;
    bytes[2 * i + 1] = word & 0xff;
  }
  return bytes;
}

/** An IPv4 or IPv6 literal (IPv6 without brackets), or null. */
export function parseIp(text: string): IpAddress | null {
  const v4 = parseIPv4(text);
  if (v4) return { version: 4, bytes: v4 };
  const v6 = parseIPv6(text);
  return v6 ? { version: 6, bytes: v6 } : null;
}

function mask(bytes: Uint8Array, prefix: number): Uint8Array {
  const out = new Uint8Array(bytes);
  for (let i = 0; i < out.length; i++) {
    const keep = Math.max(0, Math.min(8, prefix - i * 8));
    out[i] = (out[i] ?? 0) & (keep === 0 ? 0 : (0xff << (8 - keep)) & 0xff);
  }
  return out;
}

/**
 * "10.0.0.0/8", "fc00::/7", or a bare address (a single-host prefix). Host
 * bits are cleared, so "10.1.2.3/8" means 10.0.0.0/8.
 */
export function parseCidr(text: string): Cidr | null {
  const slash = text.indexOf("/");
  const ip = parseIp(slash < 0 ? text : text.slice(0, slash));
  if (!ip) return null;
  const max = ip.version === 4 ? 32 : 128;
  let prefix = max;
  if (slash >= 0) {
    const bits = text.slice(slash + 1);
    if (!/^(?:0|[1-9][0-9]{0,2})$/.test(bits)) return null;
    prefix = Number(bits);
    if (prefix > max) return null;
  }
  return { version: ip.version, bytes: mask(ip.bytes, prefix), prefix };
}

/** RFC 5952 text of an address: lowercase, no leading zeros, the longest zero run as "::". */
export function formatIp(ip: IpAddress): string {
  if (ip.version === 4) return [...ip.bytes].join(".");
  const words = Array.from(
    { length: 8 },
    (_, i) => ((ip.bytes[2 * i] ?? 0) << 8) | (ip.bytes[2 * i + 1] ?? 0),
  );
  let bestStart = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (words[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && words[j] === 0) j++;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = (list: number[]) => list.map((w) => w.toString(16)).join(":");
  if (bestStart < 0) return hex(words);
  return `${hex(words.slice(0, bestStart))}::${hex(words.slice(bestStart + bestLen))}`;
}

export function formatCidr(cidr: Cidr): string {
  return `${formatIp(cidr)}/${cidr.prefix}`;
}

/** The canonical text of a CIDR ("10.1.2.3/8" → "10.0.0.0/8", "FC00::/7" → "fc00::/7"), or null. */
export function normalizeCidr(text: string): string | null {
  const cidr = parseCidr(text.trim());
  return cidr ? formatCidr(cidr) : null;
}

export function cidrContains(cidr: Cidr, ip: IpAddress): boolean {
  if (cidr.version !== ip.version) return false;
  const masked = mask(ip.bytes, cidr.prefix);
  return masked.every((b, i) => b === cidr.bytes[i]);
}

/** Whether two CIDRs share at least one address (one of them contains the other). */
export function cidrsOverlap(a: Cidr, b: Cidr): boolean {
  if (a.version !== b.version) return false;
  return a.prefix <= b.prefix ? cidrContains(a, b) : cidrContains(b, a);
}

/** Special-purpose IPv4 ranges (RFC 6890 and friends) origins may not use by default. */
export const SPECIAL_PURPOSE_IPV4 = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
] as const;

/**
 * Special-purpose IPv6 ranges. IPv4-mapped (::ffff:0:0/96) and NAT64
 * (64:ff9b::/96) addresses are judged by the IPv4 address they embed.
 */
export const SPECIAL_PURPOSE_IPV6 = [
  "::/128",
  "::1/128",
  "100::/64",
  "2001:db8::/32",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
] as const;

const parsedRanges = [...SPECIAL_PURPOSE_IPV4, ...SPECIAL_PURPOSE_IPV6].map((text) => {
  const cidr = parseCidr(text);
  if (!cidr) throw new Error(`bad special-purpose range ${text}`);
  return { text, cidr };
});

const EMBEDDING_PREFIXES = [parseCidr("::ffff:0:0/96"), parseCidr("64:ff9b::/96")];

/** The IPv4 address inside an IPv4-mapped or NAT64 IPv6 address, or null. */
export function embeddedIPv4(ip: IpAddress): IpAddress | null {
  if (ip.version !== 6) return null;
  if (!EMBEDDING_PREFIXES.some((p) => p && cidrContains(p, ip))) return null;
  return { version: 4, bytes: ip.bytes.slice(12) };
}

/** Ranges without unicast host addresses: unspecified, loopback, link-local, multicast, reserved and broadcast. */
const NOT_UNICAST = [
  "0.0.0.0/8",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "::1/128",
  "fe80::/10",
  "ff00::/8",
].map((text) => parseCidr(text) as Cidr);

/**
 * The canonical text of a single unicast host address, as nodes report
 * theirs, or null for anything else (a CIDR, a host name, loopback,
 * link-local, multicast...). Private and documentation addresses count.
 */
export function unicastAddress(text: string): string | null {
  const ip = parseIp(text.trim());
  if (!ip) return null;
  const judged = embeddedIPv4(ip) ?? ip;
  return NOT_UNICAST.some((range) => cidrContains(range, judged)) ? null : formatIp(ip);
}

/** Host names that always mean the node itself (RFC 6761 section 6.3). */
export function isLocalhostName(host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return name === "localhost" || name.endsWith(".localhost");
}

/**
 * Why an origin address is refused: the special-purpose range its IP literal
 * falls in (e.g. "127.0.0.0/8"), or "localhost" for localhost names. Null when
 * the address may be used: a public IP literal, an address inside one of the
 * `allowed` CIDRs, or any other host name (nodes check what it resolves to).
 */
export function forbiddenOriginRange(address: string, allowed: readonly string[]): string | null {
  const ip = parseIp(address.trim());
  if (!ip) return isLocalhostName(address.trim()) ? "localhost" : null;
  const judged = embeddedIPv4(ip) ?? ip;
  const range = parsedRanges.find((r) => cidrContains(r.cidr, judged));
  if (!range) return null;
  const allowList = allowed.map(parseCidr).filter((c): c is Cidr => c !== null);
  return allowList.some((c) => cidrContains(c, judged)) ? null : range.text;
}

/** Loopback and unspecified ranges: a URL with such a host only reaches the machine itself. */
const LOCAL_ONLY = ["0.0.0.0/8", "127.0.0.0/8", "::/128", "::1/128"].map(
  (text) => parseCidr(text) as Cidr,
);

/**
 * Whether other machines can reach a URL by its host: "local" for localhost
 * names and loopback or unspecified addresses, "private" for an IP literal
 * in another special-purpose range (private networks, CGNAT, link-local,
 * documentation), null for public addresses and other host names.
 */
export function urlHostScope(url: string): "local" | "private" | null {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
  if (isLocalhostName(host)) return "local";
  const ip = parseIp(host);
  if (!ip) return null;
  const judged = embeddedIPv4(ip) ?? ip;
  if (LOCAL_ONLY.some((range) => cidrContains(range, judged))) return "local";
  return forbiddenOriginRange(host, []) === null ? null : "private";
}

/**
 * Why nodes on other networks may fail to reach the console: install.sh is
 * downloaded from the console URL, enrollment and every later RPC use the
 * node channel URL. console_url_http: a public console URL without TLS, so
 * the install.sh that hosts pipe to `sudo bash` travels unprotected.
 */
export const CONSOLE_URL_WARNINGS = [
  "console_url_local",
  "console_url_private",
  "console_url_http",
  "node_api_url_local",
  "node_api_url_private",
] as const;
export type ConsoleUrlWarning = (typeof CONSOLE_URL_WARNINGS)[number];

/**
 * The parsed URL, or undefined when `value` is not one. Refinements run
 * even after z.url() rejected the value, so they parse with this.
 */
export function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * A node channel URL as nodes take it, `https://host[:port]` with nothing
 * after it (a trailing "/" is fine), normalized to its origin; undefined for
 * anything else. EDGEWEIR_NODE_API_URL follows the same rule.
 */
export function nodeChannelOrigin(value: string): string | undefined {
  const url = parseUrl(value);
  if (
    url?.protocol !== "https:" ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    return undefined;
  return url.origin;
}

/** Whether a URL is plain http:// (unparsable URLs are not). */
export function isPlainHttp(url: string): boolean {
  try {
    return new URL(url).protocol === "http:";
  } catch {
    return false;
  }
}

/** The warnings of the console URL (EDGEWEIR_PUBLIC_URL) and the node channel URL. */
export function consoleUrlWarnings(urls: {
  consoleUrl: string;
  nodeApiUrl: string;
}): ConsoleUrlWarning[] {
  const warnings: ConsoleUrlWarning[] = [];
  const consoleScope = urlHostScope(urls.consoleUrl);
  if (consoleScope) warnings.push(`console_url_${consoleScope}`);
  else if (isPlainHttp(urls.consoleUrl)) warnings.push("console_url_http");
  const channelScope = urlHostScope(urls.nodeApiUrl);
  if (channelScope) warnings.push(`node_api_url_${channelScope}`);
  return warnings;
}
