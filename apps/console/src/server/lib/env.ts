import { hostname } from "node:os";
import * as z from "zod";

const bool = z
  .enum(["true", "false", "1", "0", "yes", "no", "on", "off", ""])
  .transform((v) => ["true", "1", "yes", "on"].includes(v));

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  ROLE: z.enum(["app", "worker", "all"]).default("all"),
  DATABASE_URL: z.string().min(1),
  /** Base64-encoded 32+ byte key used to envelope-encrypt secrets at rest. */
  EDGEWEIR_MASTER_KEY: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  /** Public URL of the web console (behind a reverse proxy this is the proxy URL). */
  EDGEWEIR_PUBLIC_URL: z.url().default("http://localhost:3000"),
  /** URL nodes use to reach the node channel. TLS is terminated by the console itself. */
  EDGEWEIR_NODE_API_URL: z.url().optional(),
  /** Extra DNS names / IPs for the node-channel server certificate, comma separated. */
  EDGEWEIR_NODE_API_HOSTNAMES: z.string().default(""),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_API_PORT: z.coerce.number().int().min(0).max(65535).default(8443),
  EDGEWEIR_ANALYTICS: z.enum(["lite", "clickhouse"]).default("lite"),
  /** Anonymous usage telemetry. Off unless explicitly enabled; Phase 0 sends nothing. */
  EDGEWEIR_TELEMETRY: bool.default(false),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  EDGEWEIR_WEB_DIST: z.string().optional(),
});

export type Env = z.infer<typeof schema> & {
  nodeApiUrl: string;
  nodeApiHostnames: string[];
  version: string;
};

export const VERSION = process.env.EDGEWEIR_VERSION ?? "0.1.0-dev";

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`invalid configuration:\n${issues}`);
  }
  const env = parsed.data;
  const nodeApiUrl =
    env.EDGEWEIR_NODE_API_URL ??
    `https://${new URL(env.EDGEWEIR_PUBLIC_URL).hostname}:${env.NODE_API_PORT}`;
  const names = new Set<string>(["localhost", "127.0.0.1", "::1", hostname()]);
  names.add(new URL(nodeApiUrl).hostname.replace(/^\[|\]$/g, ""));
  for (const extra of env.EDGEWEIR_NODE_API_HOSTNAMES.split(",")) {
    if (extra.trim()) names.add(extra.trim());
  }
  return { ...env, nodeApiUrl, nodeApiHostnames: [...names], version: VERSION };
}
