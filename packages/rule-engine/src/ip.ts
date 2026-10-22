import ipaddr from "ipaddr.js";

// ipaddr.js reads the deprecated IPv4-compatible form "::a.b.c.d" as IPv4-mapped
// ("::ffff:a.b.c.d"). Go's net/netip (the node's configir), the node's Lua and the contract's
// parser read it as the IPv6 address ::a.b.c.d; only an address with bytes 0-9 zero and 10-11
// 0xff (::ffff:0:0/96, written dotted or in hex) is IPv4-mapped.
function parseIp(text: string): ipaddr.IPv4 | ipaddr.IPv6 {
  const parsed = ipaddr.parse(text);
  if (parsed.kind() !== "ipv6" || !/^::[^:]*\./.test(text)) return parsed;
  const bytes = parsed.toByteArray();
  bytes[10] = 0;
  bytes[11] = 0;
  return ipaddr.fromByteArray(bytes);
}

export function canonicalCidr(value: string): string {
  const [address, prefix] = value.split("/");
  if (!address || value.includes("%") || value.split("/").length > 2)
    throw new Error("invalid IP/CIDR");
  if (!address.includes(":") && !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(address))
    throw new Error("invalid IPv4");
  const embedded =
    address.includes(":") && address.includes(".")
      ? address.slice(address.lastIndexOf(":") + 1)
      : null;
  if (embedded && !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(embedded))
    throw new Error("invalid embedded IPv4");
  let parsed = parseIp(address);
  let bits = prefix === undefined ? (parsed.kind() === "ipv4" ? 32 : 128) : Number(prefix);
  if (prefix !== undefined && !/^(0|[1-9]\d{0,2})$/.test(prefix)) throw new Error("invalid prefix");
  if (!Number.isInteger(bits) || bits < 0 || bits > (parsed.kind() === "ipv4" ? 32 : 128))
    throw new Error("invalid prefix");
  if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    if (bits < 96) throw new Error("ambiguous mapped IPv4 prefix");
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    bits -= 96;
  }
  const bytes = parsed.toByteArray();
  for (let i = 0; i < bytes.length; i++) {
    const keep = Math.max(0, Math.min(8, bits - i * 8));
    bytes[i] = (bytes[i] ?? 0) & (keep === 0 ? 0 : (0xff << (8 - keep)) & 0xff);
  }
  return `${ipaddr.fromByteArray(bytes).toString()}/${bits}`;
}
export function ipMatches(address: string, cidr: string): boolean {
  try {
    let parsed = parseIp(address);
    if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress())
      parsed = (parsed as ipaddr.IPv6).toIPv4Address();
    const [network, bits] = ipaddr.parseCIDR(canonicalCidr(cidr));
    return parsed.kind() === network.kind() && parsed.match(network, bits);
  } catch {
    return false;
  }
}
