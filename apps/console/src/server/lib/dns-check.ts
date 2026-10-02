import { Resolver } from "node:dns/promises";
import { formatIp, parseIp } from "@edgeweir/contract";

/** What the check needs of a resolver (node:dns/promises Resolver); tests pass their own. */
export interface AddressResolver {
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
}

/**
 * Where a name points compared with the nodes' addresses: `ok` (every
 * address it resolves to is a node's), `elsewhere` (some address is not),
 * `unresolved` (no A or AAAA record), `unknown` (resolution failed
 * otherwise, such as a timeout, or no node address is known). Only
 * `unresolved` and `elsewhere` ever stop anything.
 */
export type Pointing = "ok" | "elsewhere" | "unresolved" | "unknown";

/** The system's resolvers, with a short deadline: 3 seconds a try, 2 tries. */
export function defaultResolver(): AddressResolver {
  return new Resolver({ timeout: 3000, tries: 2 });
}

/** Answers that mean "no such record" rather than a failed lookup. */
const NO_RECORD = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN"]);

const canonical = (address: string) => {
  const ip = parseIp(address.trim());
  return ip ? formatIp(ip) : null;
};

/** Where `name` points, compared with `addresses` (the nodes' public addresses). */
export async function pointing(
  resolver: AddressResolver,
  name: string,
  addresses: Iterable<string>,
): Promise<Pointing> {
  const known = new Set([...addresses].flatMap((a) => canonical(a) ?? []));
  if (!known.size) return "unknown";
  const answers = await Promise.allSettled([resolver.resolve4(name), resolver.resolve6(name)]);
  const found: string[] = [];
  let failed = false;
  for (const answer of answers) {
    if (answer.status === "fulfilled") found.push(...answer.value);
    else if (!NO_RECORD.has(String((answer.reason as { code?: unknown })?.code))) failed = true;
  }
  if (found.length)
    return found.every((address) => known.has(canonical(address) ?? "")) ? "ok" : "elsewhere";
  return failed ? "unknown" : "unresolved";
}
