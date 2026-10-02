import type { CaaRecord } from "node:dns";
import { Resolver } from "node:dns/promises";
import { formatIp, parseIp } from "@edgeweir/contract";

/** What the checks need of a resolver (node:dns/promises Resolver); tests pass their own. */
export interface AddressResolver {
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
  /** CAA lookups; without them nothing is checked against CAA. */
  resolveCaa?(name: string): Promise<CaaRecord[]>;
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

/**
 * The issuer domain names each CA recognizes in CAA issue and issuewild
 * properties (ZeroSSL issues through Sectigo).
 */
export const CAA_ISSUERS = {
  letsencrypt: ["letsencrypt.org"],
  zerossl: ["sectigo.com", "trust-provider.com", "usertrust.com"],
} as const;

/** Property tags whose meaning is known (RFC 8659, RFC 9495); others with the critical flag forbid. */
const CAA_TAGS = new Set([
  "issue",
  "issuewild",
  "iodef",
  "issuemail",
  "issuevmc",
  "contactemail",
  "contactphone",
]);
/** A record's property tag (node:dns names the property after it, unknown tags too). */
const tagOf = (record: CaaRecord) => Object.keys(record).find((key) => key !== "critical") ?? "";

/** Whether an issue / issuewild value names one of `issuers` and allows `method`. */
function caaValueAllows(value: string, issuers: readonly string[], method: string) {
  const [issuer = "", ...params] = value.split(";");
  if (!issuers.includes(issuer.trim().toLowerCase())) return false;
  for (const param of params) {
    const [key = "", list = ""] = param.split("=");
    // RFC 8657: the validation methods the CA may use.
    if (key.trim().toLowerCase() === "validationmethods")
      return list
        .split(",")
        .map((m) => m.trim().toLowerCase())
        .includes(method);
  }
  return true;
}

/**
 * Whether CAA lets one of `issuers` issue for `name` ("*.example.com" for a
 * wildcard) validated by `method` ("http-01", "dns-01"): the first CAA
 * record set found from the name up to its top-level domain decides (RFC
 * 8659 §3); a wildcard reads issuewild properties when there are any, else
 * issue ones. `unknown` when a lookup fails other than with no records.
 */
export async function caaPermits(
  resolver: AddressResolver,
  name: string,
  issuers: readonly string[],
  method: string,
): Promise<"allowed" | "forbidden" | "unknown"> {
  const resolveCaa = resolver.resolveCaa?.bind(resolver);
  if (!resolveCaa) return "unknown";
  const wildcard = name.startsWith("*.");
  let domain = wildcard ? name.slice(2) : name;
  for (;;) {
    let records: CaaRecord[];
    try {
      records = await resolveCaa(domain);
    } catch (error) {
      if (!NO_RECORD.has(String((error as { code?: unknown })?.code))) return "unknown";
      records = [];
    }
    if (records.length) {
      if (records.some((r) => (Number(r.critical) & 128) !== 0 && !CAA_TAGS.has(tagOf(r))))
        return "forbidden";
      const values = (tag: "issue" | "issuewild") =>
        records.flatMap((r) => (typeof r[tag] === "string" ? [r[tag]] : []));
      const wild = values("issuewild");
      const relevant = wildcard && wild.length ? wild : values("issue");
      if (!relevant.length) return "allowed";
      return relevant.some((value) => caaValueAllows(value, issuers, method))
        ? "allowed"
        : "forbidden";
    }
    const dot = domain.indexOf(".");
    if (dot < 0) return "allowed";
    domain = domain.slice(dot + 1);
  }
}
