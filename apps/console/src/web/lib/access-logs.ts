import {
  type AuthKind,
  type BlockReason,
  type BROWSERS,
  type DEVICES,
  FORBIDDEN_LOG_HEADERS,
  type LogEntry,
  type LogQuery,
  MAX_LOG_HEADERS,
  type OPERATING_SYSTEMS,
  parseCidr,
  type STATS_HTTP_VERSIONS,
  type STATS_TLS_VERSIONS,
} from "@edgeweir/contract";
// Relative on purpose: the module is unit-tested outside Vite's "@" alias.
import { m } from "../paraglide/messages.js";
import { getLocale } from "../paraglide/runtime.js";

type Label = () => string;

/** A label from a table, or the key itself for a value newer than the table. */
const lookup =
  <K extends string>(table: Record<K, Label>) =>
  (key: string): string =>
    Object.hasOwn(table, key) ? table[key as K]() : key;

const BLOCK_REASON_LABELS: Record<BlockReason, Label> = {
  ip_banned: m.block_reason_ip_banned,
  ip_blocked: m.block_reason_ip_blocked,
  rule: m.block_reason_rule,
  rate_limit: m.block_reason_rate_limit,
  crs: m.block_reason_crs,
  cc: m.block_reason_cc,
  challenge: m.block_reason_challenge,
  auth: m.block_reason_auth,
  referer: m.block_reason_referer,
  user_agent: m.block_reason_user_agent,
  region: m.block_reason_region,
  cors: m.block_reason_cors,
  websocket_origin: m.block_reason_websocket_origin,
  client_cert: m.block_reason_client_cert,
  maintenance: m.block_reason_maintenance,
};
/** Why a node refused or challenged a request (ADR-0041 §3). */
export const blockReasonLabel = lookup(BLOCK_REASON_LABELS);

export const browserLabel = lookup<(typeof BROWSERS)[number]>({
  chrome: m.ua_browser_chrome,
  edge: m.ua_browser_edge,
  firefox: m.ua_browser_firefox,
  safari: m.ua_browser_safari,
  opera: m.ua_browser_opera,
  samsung: m.ua_browser_samsung,
  uc: m.ua_browser_uc,
  qq: m.ua_browser_qq,
  wechat: m.ua_browser_wechat,
  yandex: m.ua_browser_yandex,
  ie: m.ua_browser_ie,
  crawler: m.ua_browser_crawler,
  tool: m.ua_browser_tool,
  other: m.ua_browser_other,
});

export const osLabel = lookup<(typeof OPERATING_SYSTEMS)[number]>({
  windows: m.ua_os_windows,
  macos: m.ua_os_macos,
  ios: m.ua_os_ios,
  android: m.ua_os_android,
  linux: m.ua_os_linux,
  chromeos: m.ua_os_chromeos,
  harmonyos: m.ua_os_harmonyos,
  other: m.ua_os_other,
});

export const deviceLabel = lookup<(typeof DEVICES)[number]>({
  desktop: m.ua_device_desktop,
  mobile: m.ua_device_mobile,
  tablet: m.ua_device_tablet,
  crawler: m.ua_device_crawler,
  other: m.ua_device_other,
});

/** "1.1" → "HTTP/1.1"; statistics add "other". */
export const httpVersionLabel = lookup<(typeof STATS_HTTP_VERSIONS)[number]>({
  "1.0": m.http_version_1_0,
  "1.1": m.http_version_1_1,
  "2": m.http_version_2,
  "3": m.http_version_3,
  other: m.http_version_other,
});

/** "1.3" → "TLS 1.3"; statistics add "none" (plain HTTP) and "other". */
export const tlsVersionLabel = lookup<(typeof STATS_TLS_VERSIONS)[number]>({
  "1.2": m.tls_version_1_2,
  "1.3": m.tls_version_1_3,
  none: m.tls_version_none,
  other: m.tls_version_other,
});

const regionNames = new Map<string, Intl.DisplayNames>();

/** "JP" → "日本" / "Japan" in the current locale; "" is unknown, an unknown code stays as it is. */
export function countryName(code: string): string {
  if (!code) return m.stats_country_unknown();
  const locale = getLocale();
  try {
    let names = regionNames.get(locale);
    if (!names) {
      names = new Intl.DisplayNames([locale], { type: "region", fallback: "code" });
      regionNames.set(locale, names);
    }
    return names.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** An access authentication rule by its kind (rules have no names). */
export const authKindLabel = (kind: AuthKind): string =>
  ({
    basic: m.auth_kind_basic,
    forward: m.auth_kind_forward,
    url_a: m.auth_kind_url_a,
    url_b: m.auth_kind_url_b,
    url_c: m.auth_kind_url_c,
    url_d: m.auth_kind_url_d,
  })[kind]();

/** "AS64496" (the number's usual notation; not translated). */
export const asnText = (asn: number) => `AS${asn}`;

/** "HTTPS · HTTP/2 · TLS 1.3" from what a line knows; empty when it knows none of it. */
export function protocolText(entry: Pick<LogEntry, "scheme" | "httpVersion" | "tlsVersion">) {
  return [
    entry.scheme.toUpperCase(),
    entry.httpVersion ? httpVersionLabel(entry.httpVersion) : "",
    entry.tlsVersion ? tlsVersionLabel(entry.tlsVersion) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Recorded request headers as "name: value" lines, in name order. */
export const headerLines = (headers: Record<string, string>) =>
  Object.keys(headers)
    .sort()
    .map((name) => `${name}: ${headers[name]}`);

// ---------------------------------------------------------------------------------------------
// Request headers a site records

/** The names as the API stores them: lowercase, without duplicates. */
export const normalizeLogHeaders = (names: readonly string[]) => [
  ...new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean)),
];

/** Why the names cannot be saved, or null (the API's rules for Site.log_headers). */
export function logHeadersError(names: readonly string[]): string | null {
  const list = normalizeLogHeaders(names);
  const forbidden = list.find((name) =>
    (FORBIDDEN_LOG_HEADERS as readonly string[]).includes(name),
  );
  if (forbidden) return m.logs_headers_forbidden({ name: forbidden });
  const invalid = list.find((name) => !/^[a-z0-9-]{1,64}$/.test(name));
  if (invalid) return m.logs_headers_invalid({ name: invalid });
  if (list.length > MAX_LOG_HEADERS) return m.logs_headers_limit({ count: MAX_LOG_HEADERS });
  return null;
}

// ---------------------------------------------------------------------------------------------
// Filters

/** The query form as typed (numbers stay text); "" is "any". */
export interface LogFilters {
  from: string;
  to: string;
  status: string;
  ip: string;
  path: string;
  requestId: string;
  host: string;
  method: string;
  statusClass: string;
  cacheStatus: string;
  blockReason: string;
  country: string;
  asn: string;
  ua: string;
  referer: string;
  minDuration: string;
  cidr: string;
}

/** Filters behind "more filters", in the form's order. */
export const MORE_FILTERS = [
  "host",
  "method",
  "statusClass",
  "cacheStatus",
  "blockReason",
  "country",
  "asn",
  "ua",
  "referer",
  "minDuration",
  "cidr",
] as const satisfies readonly (keyof LogFilters)[];
export type MoreFilter = (typeof MORE_FILTERS)[number];

export const emptyMoreFilters = (): Pick<LogFilters, MoreFilter> =>
  Object.fromEntries(MORE_FILTERS.map((key) => [key, ""])) as Pick<LogFilters, MoreFilter>;

/** How many of the filters behind "more filters" are set. */
export const activeMoreFilters = (filters: LogFilters) =>
  MORE_FILTERS.filter((key) => filters[key].trim() !== "").length;

export const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
export const LOG_STATUS_CLASSES = ["1xx", "2xx", "3xx", "4xx", "5xx"] as const;

const MAX_ASN = 4294967295;
const MAX_DURATION_MS = 86400000;

const wholeNumber = (text: string, min: number, max: number): number | null => {
  const value = Number(text);
  return text !== "" && Number.isInteger(value) && value >= min && value <= max ? value : null;
};

/** Filters a value of which is refused, with the field it belongs to. */
export type LogFilterError = Extract<MoreFilter, "country" | "asn" | "minDuration" | "cidr">;

/**
 * The API query of the form between `from` and `to` (ISO), or the first filter that cannot be
 * sent. Empty filters are left out.
 */
export function logQueryOf(
  siteId: string,
  filters: LogFilters,
  from: string,
  to: string,
): { query: LogQuery } | { invalid: LogFilterError } {
  const trimmed = (key: keyof LogFilters) => filters[key].trim();
  const country = trimmed("country").toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) return { invalid: "country" };
  const asn = trimmed("asn");
  const asnValue = asn ? wholeNumber(asn, 1, MAX_ASN) : undefined;
  if (asnValue === null) return { invalid: "asn" };
  const minDuration = trimmed("minDuration");
  const minDurationValue = minDuration ? wholeNumber(minDuration, 0, MAX_DURATION_MS) : undefined;
  if (minDurationValue === null) return { invalid: "minDuration" };
  const cidr = trimmed("cidr");
  if (cidr && parseCidr(cidr) === null) return { invalid: "cidr" };
  const optional = <T>(value: T | "" | undefined) => (value === "" ? undefined : value);
  const status = trimmed("status");
  return {
    query: {
      siteId,
      from,
      to,
      status: status ? Number(status) : undefined,
      ip: filters.ip,
      path: filters.path,
      // Exact match; empty matches every request.
      requestId: optional(trimmed("requestId")),
      host: optional(trimmed("host")),
      method: optional(trimmed("method").toUpperCase()),
      statusClass: optional(trimmed("statusClass")) as LogQuery["statusClass"],
      cacheStatus: optional(trimmed("cacheStatus")) as LogQuery["cacheStatus"],
      blockReason: optional(trimmed("blockReason")) as LogQuery["blockReason"],
      country: optional(country),
      asn: asnValue,
      ua: optional(trimmed("ua")),
      referer: optional(trimmed("referer")),
      minDuration: minDurationValue,
      cidr: optional(cidr),
      limit: 100,
    },
  };
}
