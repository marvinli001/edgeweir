/**
 * The Host header an origin or an origin rule sends upstream, checked exactly as edgeweir-node's
 * validHostHeader (internal/configir/plan.go) does: nodes skip an origin, or drop an origin rule,
 * whose Host header they refuse. test/host_header_vectors.json, copied to edgeweir-node, keeps
 * both sides equal; the IP literal parsing follows Go's net/netip.
 */

/** Longest Host header in bytes: a 253-byte host name and ":65535". */
export const MAX_HOST_HEADER_LENGTH = 253 + 6;

const utf8 = new TextEncoder();

/**
 * A host name, an IP literal with an optional port (IPv6 in brackets when it has a port), or a
 * host name with a port of 1 to 5 digits; no whitespace, quotes, slashes or backslashes. The empty
 * string is refused: callers treat it as unset.
 */
export function validHostHeader(h: string): boolean {
  if (utf8.encode(h).length > MAX_HOST_HEADER_LENGTH || /[ \t\r\n"'\\/]/.test(h)) return false;
  const addrPort = parseAddrPort(h);
  if (addrPort) return addrPort.zone === "";
  if (parseAddr(h)) return true;
  let host = goLower(h);
  const i = host.lastIndexOf(":");
  if (i > 0) {
    const port = host.slice(i + 1);
    if (port === "" || port.length > 5 || !/^[0-9]*$/.test(port)) return false;
    host = host.slice(0, i);
  }
  return validHostname(host);
}

/**
 * Go's strings.ToLower as far as host names care: the only non-ASCII runes whose simple lowercase
 * mapping is ASCII are U+0130 (to "i") and U+212A KELVIN SIGN (to "k"); every other non-ASCII
 * character stays non-ASCII, which host names refuse anyway. String.prototype.toLowerCase maps
 * U+0130 to two characters.
 */
const goLower = (s: string) =>
  s.replace(/[A-ZİK]/g, (c) => (c === "İ" ? "i" : c === "K" ? "k" : c.toLowerCase()));

/** edgeweir-node's ValidHostname: lowercase LDH labels of 1 to 63 bytes, at most 253 bytes. */
function validHostname(name: string): boolean {
  if (name === "" || name.length > 253) return false;
  return name
    .split(".")
    .every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        !label.startsWith("-") &&
        !label.endsWith("-") &&
        /^[a-z0-9-]+$/.test(label),
    );
}

interface Addr {
  is4: boolean;
  zone: string;
}

/** Go's netip.ParseAddrPort: "1.2.3.4:80" or "[2001:db8::1]:80", the port 0 to 65535. */
function parseAddrPort(s: string): Addr | null {
  const i = s.lastIndexOf(":");
  if (i === -1) return null;
  let ip = s.slice(0, i);
  const port = s.slice(i + 1);
  if (ip === "" || port === "") return null;
  let v6 = false;
  if (ip.startsWith("[")) {
    if (ip.length < 2 || !ip.endsWith("]")) return null;
    ip = ip.slice(1, -1);
    v6 = true;
  }
  if (!/^[0-9]+$/.test(port) || Number(port) > 65535) return null;
  const addr = parseAddr(ip);
  if (!addr || addr.is4 === v6) return null;
  return addr;
}

/** Go's netip.ParseAddr: IPv4 in dotted decimal, or IPv6 with an optional zone. */
function parseAddr(s: string): Addr | null {
  for (const c of s) {
    if (c === ".") return ipv4Fields(s) ? { is4: true, zone: "" } : null;
    if (c === ":") return parseIPv6(s);
    if (c === "%") return null;
  }
  return null;
}

/** Four decimal fields of 0 to 255 without leading zeros. */
function ipv4Fields(s: string): boolean {
  let val = 0;
  let pos = 0;
  let digits = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x30 && c <= 0x39) {
      if (digits === 1 && val === 0) return false;
      val = val * 10 + (c - 0x30);
      digits++;
      if (val > 255) return false;
    } else if (s[i] === ".") {
      if (i === 0 || i === s.length - 1 || s[i - 1] === "." || pos === 3) return false;
      pos++;
      val = 0;
      digits = 0;
    } else {
      return false;
    }
  }
  return pos === 3;
}

const isHex = (c: number) =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46);

function parseIPv6(input: string): Addr | null {
  let s = input;
  let zone = "";
  const z = s.indexOf("%");
  if (z !== -1) {
    zone = s.slice(z + 1);
    s = s.slice(0, z);
    if (zone === "") return null;
  }
  let ellipsis = -1;
  if (s.startsWith("::")) {
    ellipsis = 0;
    s = s.slice(2);
    if (s === "") return { is4: false, zone };
  }
  let i = 0;
  while (i < 16) {
    let off = 0;
    for (; off < s.length && isHex(s.charCodeAt(off)); off++) {
      if (off > 3) return null;
    }
    if (off === 0) return null;
    if (s[off] === ".") {
      // A trailing IPv4 address in place of the last two groups.
      if ((ellipsis < 0 && i !== 12) || i + 4 > 16 || !ipv4Fields(s)) return null;
      s = "";
      i += 4;
      break;
    }
    i += 2;
    s = s.slice(off);
    if (s === "") break;
    if (s[0] !== ":" || s.length === 1) return null;
    s = s.slice(1);
    if (s[0] === ":") {
      if (ellipsis >= 0) return null;
      ellipsis = i;
      s = s.slice(1);
      if (s === "") break;
    }
  }
  if (s !== "") return null;
  if (i < 16 ? ellipsis < 0 : ellipsis >= 0) return null;
  return { is4: false, zone };
}
