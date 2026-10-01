/**
 * The DNS provider catalog: the single definition of every provider the
 * console can manage records with, shared by DNS accounts (cluster DNS),
 * DNS credentials (DNS-01) and edgeweir-certd, which
 * embeds the generated `helpers/certd/catalog.json`
 * (`pnpm --filter @edgeweir/contract dns:catalog`).
 *
 * Display names and field labels are Paraglide messages
 * (`dns_provider_<id>`, `dns_field_<key>`, `dns_option_<value>`); `name` is
 * the English name for API clients. Placeholders are language-neutral format
 * examples.
 */

export type DnsFieldType = "text" | "secret" | "select" | "textarea" | "url";
export type DnsRecordKind = "A" | "AAAA" | "CNAME" | "TXT";

/**
 * Canonical resolution lines (carrier / region views of one name). The
 * adapters in edgeweir-certd map them to each provider's own line ids;
 * "default" answers every resolver no other line matches.
 */
export const DNS_LINES = ["default", "telecom", "unicom", "mobile", "edu", "overseas"] as const;
export type DnsResolutionLine = (typeof DNS_LINES)[number];
const DEFAULT_LINE_ONLY: readonly DnsResolutionLine[] = ["default"];

export interface DnsProviderField {
  /** Credential key (snake_case), stored in the sealed credential JSON. */
  readonly key: string;
  readonly type: DnsFieldType;
  /** Never displayed again after saving; entered in a password field. */
  readonly secret: boolean;
  readonly required: boolean;
  readonly placeholder?: string;
  /** JavaScript and Go (RE2) compatible regular expression, anchored. */
  readonly pattern?: string;
  readonly maxLength: number;
  readonly options?: readonly string[];
  readonly default?: string;
}

export interface DnsProviderCapabilities {
  readonly recordTypes: readonly DnsRecordKind[];
  /** The API can list the account's zones. */
  readonly listZones: boolean;
  /**
   * The resolution lines the adapter writes ("default" first); providers
   * with only "default" get the same records for every resolver.
   */
  readonly lines: readonly DnsResolutionLine[];
  /** How the apex can point at a host name: CNAME flattening, an ALIAS record, or not at all. */
  readonly apex: "cname" | "alias" | null;
  /** "custom": the user enters the server address; the outbound address policy applies. */
  readonly endpoint: "fixed" | "custom";
}

export interface DnsProviderEntry {
  readonly id: string;
  readonly name: string;
  readonly fields: readonly DnsProviderField[];
  readonly capabilities: DnsProviderCapabilities;
  /** Only available when the operator configured the local test fixture. */
  readonly hidden?: boolean;
}

const ALL: readonly DnsRecordKind[] = ["A", "AAAA", "CNAME", "TXT"];
type Extra = Partial<Pick<DnsProviderField, "placeholder" | "pattern" | "default">>;
const text = (key: string, maxLength: number, extra: Extra = {}): DnsProviderField => ({
  key,
  type: "text",
  secret: false,
  required: true,
  maxLength,
  ...extra,
});
const secret = (key: string, maxLength: number, extra: Extra = {}): DnsProviderField => ({
  key,
  type: "secret",
  secret: true,
  required: true,
  maxLength,
  ...extra,
});
const select = (key: string, options: readonly string[], extra: Extra = {}): DnsProviderField => ({
  key,
  type: "select",
  secret: false,
  required: true,
  maxLength: Math.max(...options.map((o) => o.length)),
  options,
  ...extra,
});
const optional = (field: DnsProviderField): DnsProviderField => ({ ...field, required: false });
/** lines: true when the adapter implements every canonical line, otherwise "default" only. */
const caps = (
  listZones: boolean,
  lines: boolean,
  apex: DnsProviderCapabilities["apex"] = null,
  endpoint: DnsProviderCapabilities["endpoint"] = "fixed",
): DnsProviderCapabilities => ({
  recordTypes: ALL,
  listZones,
  lines: lines ? DNS_LINES : DEFAULT_LINE_ONLY,
  apex,
  endpoint,
});
const GUID = "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const guid = { placeholder: "00000000-0000-0000-0000-000000000000", pattern: GUID };
const region = (placeholder: string) =>
  optional(text("region_id", 32, { placeholder, pattern: "^[a-z0-9-]{1,32}$" }));
const cloudflareToken = { pattern: "^[A-Za-z0-9_.-]{20,256}$" };

/**
 * apex: "cname" only where the provider flattens a CNAME at the apex on
 * every plan, "alias" where an ALIAS record points the apex at any host
 * name; plan-dependent or plain (unflattened) apex CNAMEs count as null.
 */
export const dnsProviderCatalog = [
  {
    id: "cloudflare",
    name: "Cloudflare",
    fields: [
      secret("api_token", 256, cloudflareToken),
      optional(secret("zone_token", 256, cloudflareToken)),
    ],
    capabilities: caps(true, false, "cname"),
  },
  {
    id: "alidns",
    name: "Alibaba Cloud DNS",
    fields: [
      text("access_key_id", 128, { pattern: "^[A-Za-z0-9.]{1,128}$" }),
      secret("access_key_secret", 256),
      region("cn-hangzhou"),
      optional(secret("security_token", 4096)),
    ],
    capabilities: caps(true, true),
  },
  {
    id: "huaweicloud",
    name: "Huawei Cloud DNS",
    fields: [
      text("access_key_id", 128, { pattern: "^[A-Za-z0-9]{1,128}$" }),
      secret("secret_access_key", 256),
      region("cn-north-4"),
    ],
    capabilities: caps(true, true),
  },
  {
    id: "dnspod",
    name: "DNSPod (token API)",
    fields: [
      secret("auth_token", 149, {
        placeholder: "123456,0123456789abcdef0123456789abcdef",
        pattern: "^[0-9]{1,20},[0-9A-Za-z]{8,128}$",
      }),
    ],
    capabilities: caps(true, true),
  },
  {
    id: "tencentcloud",
    name: "Tencent Cloud DNSPod (API 3.0)",
    fields: [
      text("secret_id", 128, { pattern: "^[A-Za-z0-9]{1,128}$" }),
      secret("secret_key", 256),
      optional(select("site", ["cn", "intl"], { default: "cn" })),
    ],
    capabilities: caps(true, true),
  },
  {
    id: "volcengine",
    name: "Volcengine DNS",
    fields: [
      text("access_key_id", 128, {
        placeholder: "AKLT…",
        pattern: "^[A-Za-z0-9]{16,128}$",
      }),
      secret("secret_access_key", 256),
    ],
    capabilities: caps(true, false),
  },
  {
    id: "baiducloud",
    name: "Baidu AI Cloud DNS",
    fields: [
      text("access_key_id", 128, {
        placeholder: "0123456789abcdef0123456789abcdef",
        pattern: "^[A-Za-z0-9]{16,128}$",
      }),
      secret("secret_access_key", 256),
    ],
    capabilities: caps(true, false),
  },
  {
    id: "westcn",
    name: "West.cn",
    fields: [text("username", 64), secret("api_password", 256)],
    capabilities: caps(true, false),
  },
  {
    id: "dnsla",
    name: "DNS.LA",
    fields: [
      text("api_id", 128, { pattern: "^[\\x21-\\x39\\x3B-\\x7E]{1,128}$" }),
      secret("api_secret", 256),
    ],
    capabilities: caps(true, false),
  },
  {
    id: "route53",
    name: "Amazon Route 53",
    fields: [
      text("access_key_id", 128, { placeholder: "AKIAIOSFODNN7EXAMPLE", pattern: "^\\w{16,128}$" }),
      secret("secret_access_key", 128),
      optional(secret("session_token", 8192)),
      optional(
        text("hosted_zone_id", 44, {
          placeholder: "Z0123456789ABCDEFGHIJ",
          pattern: "^(/hostedzone/)?[A-Z0-9]{1,32}$",
        }),
      ),
      optional(select("partition", ["aws", "aws-cn", "aws-us-gov"], { default: "aws" })),
    ],
    capabilities: caps(true, false),
  },
  {
    id: "googleclouddns",
    name: "Google Cloud DNS",
    fields: [
      {
        ...secret("service_account_json", 16384, { placeholder: '{"type":"service_account",…}' }),
        type: "textarea",
      },
      optional(
        text("project_id", 100, {
          placeholder: "my-project-123456",
          pattern: "^([a-z][a-z0-9.-]{0,62}:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$",
        }),
      ),
      optional(
        text("managed_zone", 63, {
          placeholder: "example-com",
          pattern: "^([a-z][a-z0-9-]{0,62}|[0-9]{1,20})$",
        }),
      ),
    ],
    capabilities: caps(true, false, "alias"),
  },
  {
    id: "azure",
    name: "Azure DNS",
    fields: [
      text("tenant_id", 253, {
        placeholder: guid.placeholder,
        pattern:
          "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+)$",
      }),
      text("client_id", 36, guid),
      secret("client_secret", 1024),
      text("subscription_id", 36, guid),
      text("resource_group", 90, {
        placeholder: "dns-rg",
        pattern: "^[A-Za-z0-9_().-]{0,89}[A-Za-z0-9_()-]$",
      }),
    ],
    capabilities: caps(true, false),
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    fields: [
      secret("api_token", 128, { placeholder: "dop_v1_…", pattern: "^(dop_v1_)?[0-9a-f]{64}$" }),
    ],
    capabilities: caps(true, false),
  },
  {
    id: "vultr",
    name: "Vultr",
    fields: [secret("api_key", 64, { placeholder: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" })],
    capabilities: caps(true, false),
  },
  {
    id: "linode",
    name: "Akamai Cloud (Linode)",
    fields: [secret("api_token", 128)],
    capabilities: caps(true, false),
  },
  {
    id: "hetzner",
    name: "Hetzner Cloud DNS",
    fields: [secret("api_token", 128)],
    capabilities: caps(true, false),
  },
  {
    id: "ovh",
    name: "OVHcloud",
    fields: [
      select("endpoint", ["ovh-eu", "ovh-ca", "ovh-us"], { default: "ovh-eu" }),
      text("application_key", 128, { pattern: "^[A-Za-z0-9]{8,128}$" }),
      secret("application_secret", 128, { pattern: "^[A-Za-z0-9]{8,128}$" }),
      secret("consumer_key", 128, { pattern: "^[A-Za-z0-9]{8,128}$" }),
    ],
    capabilities: caps(true, false),
  },
  {
    id: "gandi",
    name: "Gandi LiveDNS",
    fields: [secret("bearer_token", 512, { pattern: "^[A-Za-z0-9_.-]{16,512}$" })],
    capabilities: caps(true, false, "alias"),
  },
  {
    id: "godaddy",
    name: "GoDaddy",
    fields: [
      secret("api_token", 4096, {
        placeholder: "key:secret",
        pattern: "^([A-Za-z0-9_]{8,128}:[A-Za-z0-9_]{8,128}|[A-Za-z0-9_.~+/=-]{16,})$",
      }),
    ],
    capabilities: caps(true, false),
  },
  {
    id: "porkbun",
    name: "Porkbun",
    fields: [
      secret("api_key", 260, { placeholder: "pk1_…", pattern: "^pk1_[A-Za-z0-9_]{8,256}$" }),
      secret("api_secret_key", 260, { placeholder: "sk1_…", pattern: "^sk1_[A-Za-z0-9_]{8,256}$" }),
    ],
    capabilities: caps(true, false, "alias"),
  },
  {
    id: "namesilo",
    name: "NameSilo",
    fields: [secret("api_token", 128, { pattern: "^[A-Za-z0-9]{8,128}$" })],
    capabilities: caps(true, false),
  },
  {
    id: "gcore",
    name: "Gcore",
    fields: [
      secret("api_key", 4096, {
        placeholder: "1234$0123456789abcdef",
        pattern: "^[0-9]+\\$[A-Za-z0-9._~+/=-]+$",
      }),
    ],
    capabilities: caps(true, false, "cname"),
  },
  {
    id: "bunny",
    name: "Bunny DNS",
    fields: [secret("access_key", 128, { pattern: "^[A-Za-z0-9-]{16,128}$" })],
    capabilities: caps(true, false, "cname"),
  },
  {
    id: "desec",
    name: "deSEC",
    fields: [secret("token", 128, { pattern: "^[A-Za-z0-9_-]{16,128}$" })],
    capabilities: caps(true, false),
  },
  {
    id: "powerdns",
    name: "PowerDNS",
    fields: [
      {
        key: "server_url",
        type: "url",
        secret: false,
        required: true,
        placeholder: "https://pdns.example.net:8081",
        pattern: "^https?://[^/?#@\\s]+/?$",
        maxLength: 256,
      },
      secret("api_key", 256),
      optional(
        text("server_id", 64, {
          placeholder: "localhost",
          pattern: "^[A-Za-z0-9._-]{1,64}$",
          default: "localhost",
        }),
      ),
    ],
    capabilities: caps(true, false, null, "custom"),
  },
  {
    id: "rfc2136",
    name: "RFC 2136 (TSIG)",
    fields: [
      text("server", 261, {
        placeholder: "ns1.example.net:53",
        pattern: "^[A-Za-z0-9._:\\[\\]-]{1,261}$",
      }),
      text("tsig_key_name", 253, {
        placeholder: "edgeweir-key",
        pattern: "^[A-Za-z0-9._-]{1,253}$",
      }),
      select(
        "tsig_algorithm",
        ["hmac-sha256", "hmac-sha512", "hmac-sha384", "hmac-sha224", "hmac-sha1"],
        {
          default: "hmac-sha256",
        },
      ),
      secret("tsig_secret", 512, { pattern: "^[A-Za-z0-9+/]+={0,2}$" }),
    ],
    capabilities: caps(false, false, null, "custom"),
  },
  {
    id: "webhook",
    name: "Custom HTTP",
    fields: [
      {
        key: "url",
        type: "url",
        secret: false,
        required: true,
        placeholder: "https://dns-hook.example.net/edgeweir",
        pattern: "^https?://[^\\s@#]+$",
        maxLength: 512,
      },
      secret("secret", 256, { pattern: "^.{16,}$" }),
    ],
    capabilities: caps(true, false, null, "custom"),
  },
  {
    id: "test",
    name: "Local test fixture",
    fields: [secret("api_token", 1024)],
    capabilities: caps(true, true),
    hidden: true,
  },
] as const satisfies readonly DnsProviderEntry[];

export type DnsProviderId = (typeof dnsProviderCatalog)[number]["id"];
export const dnsProviderIds = dnsProviderCatalog.map((p) => p.id) as [
  DnsProviderId,
  ...DnsProviderId[],
];

export function dnsProviderEntry(id: string): DnsProviderEntry | undefined {
  return (dnsProviderCatalog as readonly DnsProviderEntry[]).find((p) => p.id === id);
}

/** The resolution lines a provider's adapter writes ("default" only for unknown providers). */
export function providerLines(id: string): readonly DnsResolutionLine[] {
  return dnsProviderEntry(id)?.capabilities.lines ?? DEFAULT_LINE_ONLY;
}

export type DnsCredentialProblem =
  | "unknown_provider"
  | "unknown_field"
  | "missing_field"
  | "invalid_field";

/**
 * Checks credential fields against the catalog: only known keys, required
 * ones present, no control characters, within length, matching the pattern
 * and select options; URL fields must be http(s) without user info or
 * fragment. Empty optional values are dropped.
 */
export function checkDnsCredentials(
  providerId: string,
  credentials: Record<string, string>,
):
  | { ok: true; value: Record<string, string> }
  | { ok: false; problem: DnsCredentialProblem; field?: string } {
  const entry = dnsProviderEntry(providerId);
  if (!entry) return { ok: false, problem: "unknown_provider" };
  const value: Record<string, string> = {};
  for (const key of Object.keys(credentials))
    if (!entry.fields.some((f) => f.key === key))
      return { ok: false, problem: "unknown_field", field: key };
  for (const field of entry.fields) {
    const raw = credentials[field.key] ?? "";
    const text = field.type === "textarea" || field.secret ? raw : raw.trim();
    if (!text) {
      if (field.required) return { ok: false, problem: "missing_field", field: field.key };
      continue;
    }
    const invalid = { ok: false as const, problem: "invalid_field" as const, field: field.key };
    if (text.length > field.maxLength) return invalid;
    // Newlines and tabs only where a multi-line value is expected (JSON keys).
    const allowed = field.type === "textarea" ? /[\t\n\r]/ : /$^/;
    if ([...text].some((c) => (c < " " && !allowed.test(c)) || c === "\u007f")) return invalid;
    if (field.pattern && !new RegExp(field.pattern).test(text)) return invalid;
    if (field.options && !field.options.includes(text)) return invalid;
    if (field.type === "url") {
      let url: URL;
      try {
        url = new URL(text);
      } catch {
        return invalid;
      }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash)
        return invalid;
    }
    value[field.key] = text;
  }
  return { ok: true, value };
}
