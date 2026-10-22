import { oc } from "@orpc/contract";
import * as z from "zod";
import { type Cidr, cidrContains, formatCidr, parseCidr } from "./addresses";
import { cidr } from "./schemas";

/**
 * The networks the operator may sign in from (settings.loginAllowList). An empty list lets
 * anyone sign in. Outside the list better-auth's endpoints and session calls of /rpc answer
 * LOGIN_IP_NOT_ALLOWED; AccessKeys, service account keys and the demo account are not limited.
 */
export const MAX_LOGIN_ALLOWED_CIDRS = 64;

const loginAllowList = z.object({
  /** Sorted, without duplicates; empty when the list is off. */
  cidrs: z.array(z.string()),
  /** The caller's address as the console resolves it (EDGEWEIR_TRUSTED_PROXIES). */
  currentIp: z.string(),
  /**
   * currentIp may be a proxy's: a private or other special-purpose address, or the request
   * carried forwarding headers from a peer outside EDGEWEIR_TRUSTED_PROXIES.
   */
  proxyHint: z.boolean(),
});
export type LoginAllowList = z.infer<typeof loginAllowList>;

export const loginAllowListInput = z.object({
  cidrs: z.array(cidr).max(MAX_LOGIN_ALLOWED_CIDRS),
});

export const loginAllowListProcedures = {
  loginAllowList: oc
    .route({ method: "GET", path: "/settings/login-allow-list", tags: ["settings"] })
    .output(loginAllowList),
  /**
   * Replaces the list; a list that leaves out the caller's own address is refused
   * (LOGIN_ALLOW_LIST_EXCLUDES_CURRENT_IP). An empty list turns it off.
   */
  setLoginAllowList: oc
    .route({ method: "PUT", path: "/settings/login-allow-list", tags: ["settings"] })
    .input(loginAllowListInput)
    .output(loginAllowList),
};

const IPV4_MAPPED = parseCidr("::ffff:0:0/96") as Cidr;

/** An IPv4-mapped IPv6 range or address (`::ffff:192.0.2.0/120`) as the IPv4 one it maps. */
function unmapped(range: Cidr): Cidr {
  if (range.version !== 6 || range.prefix < 96 || !cidrContains(IPV4_MAPPED, range)) return range;
  return { version: 4, bytes: range.bytes.slice(12), prefix: range.prefix - 96 };
}

/**
 * Whether `address` is inside one of `cidrs`. IPv4-mapped IPv6 addresses and ranges count as
 * the IPv4 ones they map; anything that is not an address is outside.
 */
export function loginAllowListContains(cidrs: readonly string[], address: string): boolean {
  const parsed = address ? parseCidr(address) : null;
  if (!parsed || parsed.prefix !== (parsed.version === 4 ? 32 : 128)) return false;
  const ip = unmapped(parsed);
  return cidrs.some((text) => {
    const range = parseCidr(text);
    return range !== null && cidrContains(unmapped(range), ip);
  });
}

/**
 * What the demo account sees of an allowed range: at most its /24 (IPv4) or /48 (IPv6)
 * network, like the addresses of demoAddress. Text that is not a CIDR is dropped.
 */
export function demoCidr(text: string): string {
  const range = parseCidr(text);
  if (!range) return "";
  const prefix = Math.min(range.prefix, range.version === 4 ? 24 : 48);
  return formatCidr(parseCidr(`${formatCidr(range).split("/")[0]}/${prefix}`) as Cidr);
}
