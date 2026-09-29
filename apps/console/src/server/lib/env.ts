import { hostname } from "node:os";
import { releaseBaseUrl } from "@edgeweir/contract";
import * as z from "zod";
import { TrustedProxies } from "./client-ip";

const bool = z
  .enum(["true", "false", "1", "0", "yes", "no", "on", "off", ""])
  .transform((v) => ["true", "1", "yes", "on"].includes(v));

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  ROLE: z.enum(["app", "worker", "all"]).default("all"),
  DATABASE_URL: z.string().min(1),
  /** Base64-encoded 32+ byte key used to envelope-encrypt secrets at rest. */
  EDGEWEIR_MASTER_KEY: z.string().min(1),
  /**
   * better-auth's secret (session signatures, two-factor secrets at rest).
   * Empty or unset: derived from EDGEWEIR_MASTER_KEY (lib/auth-secret.ts).
   */
  BETTER_AUTH_SECRET: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.string().min(32).optional(),
  ),
  /** Public URL of the web console (behind a reverse proxy this is the proxy URL). */
  EDGEWEIR_PUBLIC_URL: z.url().default("http://localhost:3000"),
  /** URL nodes use to reach the node channel. TLS is terminated by the console itself. */
  EDGEWEIR_NODE_API_URL: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.url().optional(),
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
  /** Anonymous usage telemetry. Off unless explicitly enabled; Phase 0 sends nothing. */
  EDGEWEIR_TELEMETRY: bool.default(false),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  EDGEWEIR_WEB_DIST: z.string().optional(),
  /**
   * Release mirror served at /downloads (edgeweir-node/latest,
   * edgeweir-node/v<version>/<file>, cosign/v<version>/<file>). Unset: 404.
   */
  EDGEWEIR_DOWNLOADS_DIR: z.string().optional(),
  EDGEWEIR_CERTD_BIN: z.string().default("edgeweir-certd"),
  EDGEWEIR_ACME_DIRECTORY: z.string().default(""),
  EDGEWEIR_OUTBOUND_ALLOW_CIDRS: z.string().default(""),
  /** Fallback PEM bundle for SMTP TLS when the SMTP settings carry no CA. */
  EDGEWEIR_SMTP_CA_FILE: z.string().default(""),
  EDGEWEIR_DNS_TEST_ENDPOINT: z.string().default(""),
  EDGEWEIR_DNS_RESOLVERS: z.string().default(""),
  EDGEWEIR_ACME_CA_FILE: z.string().default(""),
});

/** Every environment variable the console reads (documented in .env.example). */
export const ENV_VARIABLES = [...Object.keys(schema.shape), "EDGEWEIR_VERSION"];

export type Env = z.infer<typeof schema> & {
  nodeApiHost: string;
  nodeApiUrl: string;
  nodeApiHostnames: string[];
  trustedProxies: TrustedProxies;
  version: string;
};

/** Rolling image version `<YYYYMMDD>-<commit>` baked in by the Dockerfile; `dev` from source. */
export const VERSION = process.env.EDGEWEIR_VERSION ?? "dev";

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`invalid configuration:\n${issues}`);
  }
  const env = parsed.data;
  let trustedProxies: TrustedProxies;
  try {
    trustedProxies = new TrustedProxies(env.EDGEWEIR_TRUSTED_PROXIES);
  } catch (error) {
    throw new Error(
      `invalid configuration:\n  EDGEWEIR_TRUSTED_PROXIES: ${(error as Error).message}`,
    );
  }
  const nodeApiUrl =
    env.EDGEWEIR_NODE_API_URL ??
    `https://${new URL(env.EDGEWEIR_PUBLIC_URL).hostname}:${env.NODE_API_PORT}`;
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
