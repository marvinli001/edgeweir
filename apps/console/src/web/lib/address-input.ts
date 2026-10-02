/**
 * Reads the host out of what operators paste into domain and origin fields: URLs
 * (scheme, host, path), "host:port" and bracketed IPv6. The contract validates the result.
 */

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;

/** Drops a URL's scheme, path, query and fragment, keeping "host[:port]". */
function authority(value: string): { scheme?: string; rest: string } {
  const trimmed = value.trim();
  const scheme = SCHEME_RE.exec(trimmed);
  const rest = scheme ? trimmed.slice(scheme[0].length) : trimmed;
  return {
    scheme: scheme?.[1]?.toLowerCase(),
    rest: rest.split(/[/?#]/, 1)[0] ?? "",
  };
}

/** A pasted URL or "Shop.test:443" → "shop.test"; "*.shop.test" stays as it is. */
export function domainInput(value: string): string {
  const { rest } = authority(value);
  return rest.replace(/:\d+$/, "").replace(/\.$/, "").toLowerCase();
}

/** Splits a list of domains (whitespace, commas) and reads each one with domainInput. */
export function domainList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map(domainInput)
        .filter(Boolean),
    ),
  ];
}

/**
 * A URL gives { address, port?, scheme } (http and https only);
 * "origin.test:8080" and "[2001:db8::1]:8080" carry a port; a bare IPv6 address has none.
 */
export function originInput(value: string): {
  address: string;
  port?: number;
  scheme?: "http" | "https";
} {
  const { scheme, rest } = authority(value);
  const known = scheme === "http" || scheme === "https" ? scheme : undefined;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (bracketed) return withPort(bracketed[1] ?? "", bracketed[2], known);
  const hostPort = /^([^:]+):(\d+)$/.exec(rest);
  if (hostPort) return withPort(hostPort[1] ?? "", hostPort[2], known);
  return { address: rest, ...(known ? { scheme: known } : {}) };
}

function withPort(address: string, port: string | undefined, scheme?: "http" | "https") {
  return {
    address,
    ...(port ? { port: Number(port) } : {}),
    ...(scheme ? { scheme } : {}),
  };
}

type Scheme = "http" | "https";

/**
 * The origin fields once `value` is in the address field: a URL or
 * "host:port" moves its scheme and port into their own fields (a scheme
 * without a port sets that scheme's `defaultPort`); a plain host only
 * changes the address.
 */
export function fillOrigin(
  value: string,
  fields: { scheme: Scheme; port: string },
  defaultPort: (scheme: Scheme) => string,
): { address: string; scheme: Scheme; port: string } {
  const parsed = originInput(value);
  const scheme = parsed.scheme ?? fields.scheme;
  const port =
    parsed.port !== undefined
      ? String(parsed.port)
      : parsed.scheme
        ? defaultPort(parsed.scheme)
        : fields.port;
  return { address: parsed.address, scheme, port };
}

/**
 * Whether a paste replaces the whole field (it is empty or all selected):
 * only then is the pasted text read as a whole origin.
 */
export const replacesField = (field: {
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
}) =>
  field.value === "" || (field.selectionStart === 0 && field.selectionEnd === field.value.length);
