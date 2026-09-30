/**
 * The DNS provider catalog: the single definition of every provider the
 * console can manage records with, shared by platform DNS accounts, tenant
 * DNS credentials (DNS-01 and automatic records) and edgeweir-certd, which
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
  /** The provider resolves by carrier or region (lines); informational. */
  readonly lines: boolean;
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
const region = (placeholder: string): DnsProviderField => ({
  key: "region_id",
  type: "text",
  secret: false,
  required: false,
  placeholder,
  pattern: "^[a-z0-9-]{1,32}$",
  maxLength: 32,
});
const id = (key: string, placeholder?: string): DnsProviderField => ({
  key,
  type: "text",
  secret: false,
  required: true,
  maxLength: 256,
  ...(placeholder ? { placeholder } : {}),
});
const secret = (key: string, placeholder?: string, maxLength = 1024): DnsProviderField => ({
  key,
  type: "secret",
  secret: true,
  required: true,
  maxLength,
  ...(placeholder ? { placeholder } : {}),
});
const optional = (field: DnsProviderField): DnsProviderField => ({ ...field, required: false });
const caps = (
  listZones: boolean,
  lines: boolean,
  apex: DnsProviderCapabilities["apex"] = null,
  endpoint: DnsProviderCapabilities["endpoint"] = "fixed",
): DnsProviderCapabilities => ({ recordTypes: ALL, listZones, lines, apex, endpoint });

export const dnsProviderCatalog = [
  {
    id: "cloudflare",
    name: "Cloudflare",
    fields: [secret("api_token"), optional(secret("zone_token"))],
    capabilities: caps(true, false, "cname"),
  },
  {
    id: "alidns",
    name: "Alibaba Cloud DNS",
    fields: [
      id("access_key_id"),
      secret("access_key_secret"),
      region("cn-hangzhou"),
      optional(secret("security_token", undefined, 4096)),
    ],
    capabilities: caps(true, true),
  },
  {
    id: "huaweicloud",
    name: "Huawei Cloud DNS",
    fields: [id("access_key_id"), secret("secret_access_key"), region("cn-south-1")],
    capabilities: caps(true, true),
  },
  {
    id: "dnspod",
    name: "DNSPod (token API)",
    fields: [
      {
        ...secret("auth_token", "12345,0123456789abcdef0123456789abcdef"),
        pattern: "^[0-9]+,[0-9A-Za-z]+$",
      },
    ],
    capabilities: caps(true, true),
  },
  {
    id: "tencentcloud",
    name: "Tencent Cloud DNSPod (API 3.0)",
    fields: [id("secret_id"), secret("secret_key")],
    capabilities: caps(true, true),
  },
  {
    id: "volcengine",
    name: "Volcengine DNS",
    fields: [id("access_key_id"), secret("secret_access_key")],
    capabilities: caps(true, true),
  },
  {
    id: "baiducloud",
    name: "Baidu AI Cloud DNS",
    fields: [id("access_key_id"), secret("secret_access_key")],
    capabilities: caps(true, true),
  },
  {
    id: "westcn",
    name: "West.cn",
    fields: [id("username"), secret("api_password")],
    capabilities: caps(false, false),
  },
  {
    id: "dnsla",
    name: "DNS.LA",
    fields: [id("api_id"), secret("api_secret")],
    capabilities: caps(true, true),
  },
  {
    id: "route53",
    name: "Amazon Route 53",
    fields: [
      id("access_key_id", "AKIAIOSFODNN7EXAMPLE"),
      secret("secret_access_key"),
      optional(secret("session_token", undefined, 4096)),
      optional(id("hosted_zone_id", "Z0123456789ABCDEFGHIJ")),
    ],
    capabilities: caps(true, true),
  },
  {
    id: "googleclouddns",
    name: "Google Cloud DNS",
    fields: [
      {
        ...secret("service_account_json", '{"type":"service_account",…}', 16384),
        type: "textarea",
      },
      optional(id("project_id")),
      optional(id("managed_zone")),
    ],
    capabilities: caps(true, true),
  },
  {
    id: "azure",
    name: "Azure DNS",
    fields: [
      id("tenant_id"),
      id("client_id"),
      secret("client_secret"),
      id("subscription_id"),
      id("resource_group"),
    ],
    capabilities: caps(true, false),
  },
  {
    id: "digitalocean",
    name: "DigitalOcean",
    fields: [secret("api_token")],
    capabilities: caps(true, false),
  },
  { id: "vultr", name: "Vultr", fields: [secret("api_key")], capabilities: caps(true, false) },
  {
    id: "linode",
    name: "Akamai Cloud (Linode)",
    fields: [secret("api_token")],
    capabilities: caps(true, false),
  },
  {
    id: "hetzner",
    name: "Hetzner",
    fields: [secret("api_token")],
    capabilities: caps(true, false),
  },
  {
    id: "ovh",
    name: "OVHcloud",
    fields: [
      {
        key: "endpoint",
        type: "select",
        secret: false,
        required: true,
        maxLength: 32,
        options: ["ovh-eu", "ovh-ca", "ovh-us"],
        default: "ovh-eu",
      },
      id("application_key"),
      secret("application_secret"),
      secret("consumer_key"),
    ],
    capabilities: caps(true, false),
  },
  { id: "gandi", name: "Gandi", fields: [secret("bearer_token")], capabilities: caps(true, false) },
  {
    id: "godaddy",
    name: "GoDaddy",
    fields: [secret("api_token", "key:secret")],
    capabilities: caps(true, false),
  },
  {
    id: "porkbun",
    name: "Porkbun",
    fields: [secret("api_key"), secret("api_secret_key")],
    capabilities: caps(true, false),
  },
  {
    id: "namesilo",
    name: "NameSilo",
    fields: [secret("api_token")],
    capabilities: caps(true, false),
  },
  { id: "gcore", name: "Gcore", fields: [secret("api_key")], capabilities: caps(true, false) },
  {
    id: "bunny",
    name: "Bunny DNS",
    fields: [secret("access_key")],
    capabilities: caps(true, false),
  },
  { id: "desec", name: "deSEC", fields: [secret("token")], capabilities: caps(true, false) },
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
      secret("api_key"),
      optional({ ...id("server_id", "localhost"), pattern: "^[A-Za-z0-9._-]{1,64}$" }),
    ],
    capabilities: caps(true, false, null, "custom"),
  },
  {
    id: "rfc2136",
    name: "RFC 2136 (TSIG)",
    fields: [
      {
        ...id("server", "ns1.example.net:53"),
        pattern: "^[A-Za-z0-9.:\\[\\]-]{1,255}$",
      },
      id("tsig_key_name", "edgeweir-key."),
      {
        key: "tsig_algorithm",
        type: "select",
        secret: false,
        required: true,
        maxLength: 16,
        options: ["hmac-sha256", "hmac-sha512", "hmac-sha384", "hmac-sha224", "hmac-sha1"],
        default: "hmac-sha256",
      },
      secret("tsig_secret"),
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
      { ...secret("secret"), pattern: "^.{16,}$" },
    ],
    capabilities: caps(true, false, null, "custom"),
  },
  {
    id: "test",
    name: "Local test fixture",
    fields: [secret("api_token")],
    capabilities: caps(true, false),
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
