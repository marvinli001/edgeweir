import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { normalizeCidr, releaseBaseUrl } from "@edgeweir/contract";
import * as z from "zod";
import { TrustedProxies } from "./client-ip";
import { decodeMasterKey, masterKeyProblem } from "./envelope";

/**
 * A rejected value for an error message, a password in it masked: a platform
 * reference that did not expand (`${HOST}`, `https://:`) shows as it arrived.
 */
const shown = (value: string) =>
  JSON.stringify(value.replace(/(\/\/[^/?#@:]*:)[^/?#@]*@/, "$1***@"));

/**
 * `<scheme>://host[:port]` with nothing after it (a trailing "/" is fine), as
 * deploy.sh's valid_url; parses to the origin. z.url() would also take
 * "localhost:3000" (scheme "localhost:") and URLs with a path.
 */
const originUrl = (schemes: readonly ("http" | "https" | "ws" | "wss")[]) =>
  z.string().transform((value, ctx) => {
    let url: URL | undefined;
    try {
      url = new URL(value);
    } catch {}
    if (
      !url ||
      !schemes.some((scheme) => url.protocol === `${scheme}:`) ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      const names = schemes.map((s) => `${s}://`);
      const expected =
        names.length > 1 ? `${names.slice(0, -1).join(", ")} or ${names.at(-1)}` : names[0];
      ctx.issues.push({
        code: "custom",
        message: `expected ${expected}host[:port] without a path, e.g. https://cdn-admin.example.com; got ${shown(value)}`,
        input: value,
      });
      return z.NEVER;
    }
    return url.origin;
  });

/** A master key: canonical base64 of 32+ bytes (masterKeyProblem). */
const masterKey = z
  .string()
  .min(1)
  .check((ctx) => {
    const problem = masterKeyProblem(ctx.value);
    if (problem) ctx.issues.push({ code: "custom", message: problem, input: ctx.value });
  });

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  ROLE: z.enum(["app", "worker", "all"]).default("all"),
  DATABASE_URL: z.string().min(1),
  /** Base64-encoded 32+ byte key used to envelope-encrypt secrets at rest. */
  EDGEWEIR_MASTER_KEY: masterKey,
  /**
   * The master key before a rotation: opens what it sealed until the startup
   * re-seal pass has moved everything to EDGEWEIR_MASTER_KEY; never seals.
   */
  EDGEWEIR_MASTER_KEY_PREVIOUS: z.preprocess(
    (value) => (value === "" ? undefined : value),
    masterKey.optional(),
  ),
  /**
   * better-auth's secret (session signatures, two-factor secrets at rest).
   * Empty or unset: derived from EDGEWEIR_MASTER_KEY (lib/auth-secret.ts).
   */
  BETTER_AUTH_SECRET: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(32).optional(),
  ),
  /** Public URL of the web console (behind a reverse proxy this is the proxy URL). */
  EDGEWEIR_PUBLIC_URL: originUrl(["http", "https"]).default("http://localhost:3000"),
  /**
   * URL nodes use to reach the node channel: https:// for its port, wss:// or
   * ws:// for its WebSocket entry on the web port. TLS is terminated by the
   * console itself either way.
   */
  EDGEWEIR_NODE_API_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    originUrl(["https", "wss", "ws"]).optional(),
  ),
  /**
   * Without EDGEWEIR_NODE_API_URL, nodes get the WebSocket entry on the web
   * port (wss://<EDGEWEIR_PUBLIC_URL host>) instead of the node channel port:
   * for platforms that only forward HTTP. Also keeps the entry open.
   */
  EDGEWEIR_NODE_API_WEBSOCKET: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z
      .stringbool({ truthy: ["true", "1", "yes", "on"], falsy: ["false", "0", "no", "off"] })
      .default(false),
  ),
  /** Extra DNS names / IPs for the node-channel server certificate, comma separated. */
  EDGEWEIR_NODE_API_HOSTNAMES: z.string().default(""),
  /**
   * Reverse proxies (comma-separated IPs / CIDR ranges) whose X-Forwarded-For
   * and X-Real-IP headers are believed. Empty: the socket address is the client.
   */
  EDGEWEIR_TRUSTED_PROXIES: z.string().default(""),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  /**
   * Listen address of the node channel; empty or unset: HOST. Lets a host-network
   * deployment keep the web console on loopback while nodes reach the channel.
   */
  NODE_API_HOST: z.preprocess((value) => (value === "" ? undefined : value), z.string().optional()),
  NODE_API_PORT: z.coerce.number().int().min(0).max(65535).default(8443),
  /**
   * Fallback node release mirror when none is saved in system settings; empty
   * or unset means the official GitHub releases.
   */
  EDGEWEIR_NODE_RELEASE_BASE_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    releaseBaseUrl.optional(),
  ),
  EDGEWEIR_ANALYTICS: z.enum(["lite", "clickhouse"]).default("lite"),
  EDGEWEIR_CLICKHOUSE_URL: z
    .url()
    .refine((v) => {
      const u = new URL(v);
      return (
        ["http:", "https:"].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash
      );
    })
    .default("http://clickhouse:8123"),
  EDGEWEIR_CLICKHOUSE_DATABASE: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/)
    .default("edgeweir"),
  EDGEWEIR_CLICKHOUSE_USER: z.string().default("edgeweir"),
  EDGEWEIR_CLICKHOUSE_PASSWORD: z.string().default(""),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  EDGEWEIR_WEB_DIST: z.string().optional(),
  /**
   * Release mirror served at /downloads (edgeweir-node/latest,
   * edgeweir-node/v<version>/<file>, cosign/v<version>/<file>). Unset: 404.
   */
  EDGEWEIR_DOWNLOADS_DIR: z.string().optional(),
  EDGEWEIR_CERTD_BIN: z.string().default("edgeweir-certd"),
  /** Fallback URL of the custom ACME directory (system settings win). */
  EDGEWEIR_ACME_DIRECTORY: z.string().default(""),
  EDGEWEIR_OUTBOUND_ALLOW_CIDRS: z.string().default(""),
  /** Fallback PEM bundle for SMTP TLS when the SMTP settings carry no CA. */
  EDGEWEIR_SMTP_CA_FILE: z.string().default(""),
  EDGEWEIR_DNS_TEST_ENDPOINT: z.string().default(""),
  /** Fallback CA certificates (PEM file) of the custom ACME directory. */
  EDGEWEIR_ACME_CA_FILE: z.string().default(""),
});

/**
 * Variables that can be read from the file `<name>_FILE` names instead (a
 * Docker or orchestrator secret), so the value stays out of the environment.
 */
export const FILE_VARIABLES = [
  "DATABASE_URL",
  "EDGEWEIR_MASTER_KEY",
  "EDGEWEIR_MASTER_KEY_PREVIOUS",
  "BETTER_AUTH_SECRET",
  "EDGEWEIR_CLICKHOUSE_PASSWORD",
] as const;

/** Every environment variable the console reads (documented in .env.example). */
export const ENV_VARIABLES = [
  ...Object.keys(schema.shape),
  ...FILE_VARIABLES.map((name) => `${name}_FILE`),
  "EDGEWEIR_VERSION",
];

export type Env = z.infer<typeof schema> & {
  nodeApiHost: string;
  nodeApiUrl: string;
  nodeApiHostnames: string[];
  trustedProxies: TrustedProxies;
  version: string;
};

/**
 * EDGEWEIR_OUTBOUND_ALLOW_CIDRS (commas or whitespace) as canonical CIDRs;
 * throws on an entry that is neither an IP address nor a CIDR range.
 */
export function parseOutboundAllowCidrs(text: string): string[] {
  return text
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((value) => {
      const cidr = normalizeCidr(value);
      if (!cidr) throw new Error(`not an IP address or CIDR range: ${value}`);
      return cidr;
    });
}

/** Rolling image version `<YYYYMMDD>-<commit>` baked in by the Dockerfile; `dev` from source. */
export const VERSION = process.env.EDGEWEIR_VERSION ?? "dev";

/**
 * The environment with each FILE_VARIABLES entry read from its `<name>_FILE`
 * when that is set; the file's last line break is dropped. Setting both the
 * variable and its file, an unreadable file and an empty one are errors.
 */
function withSecretFiles(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  const problems: string[] = [];
  for (const name of FILE_VARIABLES) {
    const variable = `${name}_FILE`;
    const file = source[variable];
    if (!file) continue;
    if (source[name]) {
      problems.push(`${variable}: set either ${name} or ${variable}, not both`);
      continue;
    }
    let value: string;
    try {
      value = readFileSync(file, "utf8").replace(/[\r\n]+$/, "");
    } catch (error) {
      problems.push(
        `${variable}: cannot read ${file}: ${(error as NodeJS.ErrnoException).code ?? error}`,
      );
      continue;
    }
    if (!value) problems.push(`${variable}: ${file} is empty`);
    env[name] = value;
  }
  if (problems.length > 0) {
    throw new Error(`invalid configuration:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  }
  return env;
}

/**
 * The node channel URL when EDGEWEIR_NODE_API_URL is unset: the node channel
 * port on the console's host, or with EDGEWEIR_NODE_API_WEBSOCKET the
 * WebSocket entry at the console's own address (wss:// behind https://).
 */
export function defaultNodeApiUrl(
  env: Pick<Env, "EDGEWEIR_PUBLIC_URL" | "EDGEWEIR_NODE_API_WEBSOCKET" | "NODE_API_PORT">,
): string {
  const publicUrl = new URL(env.EDGEWEIR_PUBLIC_URL);
  if (env.EDGEWEIR_NODE_API_WEBSOCKET)
    return `${publicUrl.protocol === "https:" ? "wss" : "ws"}://${publicUrl.host}`;
  return `https://${publicUrl.hostname}:${env.NODE_API_PORT}`;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(withSecretFiles(source));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`invalid configuration:\n${issues}`);
  }
  const env = parsed.data;
  if (
    env.EDGEWEIR_MASTER_KEY_PREVIOUS &&
    decodeMasterKey(env.EDGEWEIR_MASTER_KEY_PREVIOUS).equals(
      decodeMasterKey(env.EDGEWEIR_MASTER_KEY),
    )
  ) {
    throw new Error(
      "invalid configuration:\n  EDGEWEIR_MASTER_KEY_PREVIOUS: is the same key as EDGEWEIR_MASTER_KEY (set it to the key before the rotation)",
    );
  }
  let trustedProxies: TrustedProxies;
  try {
    trustedProxies = new TrustedProxies(env.EDGEWEIR_TRUSTED_PROXIES);
  } catch (error) {
    throw new Error(
      `invalid configuration:\n  EDGEWEIR_TRUSTED_PROXIES: ${(error as Error).message}`,
    );
  }
  try {
    parseOutboundAllowCidrs(env.EDGEWEIR_OUTBOUND_ALLOW_CIDRS);
  } catch (error) {
    throw new Error(
      `invalid configuration:\n  EDGEWEIR_OUTBOUND_ALLOW_CIDRS: ${(error as Error).message}`,
    );
  }
  const nodeApiUrl = env.EDGEWEIR_NODE_API_URL ?? defaultNodeApiUrl(env);
  const names = new Set<string>(["localhost", "127.0.0.1", "::1", hostname()]);
  names.add(new URL(nodeApiUrl).hostname.replace(/^\[|\]$/g, ""));
  for (const extra of env.EDGEWEIR_NODE_API_HOSTNAMES.split(",")) {
    if (extra.trim()) names.add(extra.trim());
  }
  return {
    ...env,
    nodeApiHost: env.NODE_API_HOST ?? env.HOST,
    nodeApiUrl,
    nodeApiHostnames: [...names],
    trustedProxies,
    version: VERSION,
  };
}
