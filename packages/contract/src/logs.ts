import { oc } from "@orpc/contract";
import * as z from "zod";
import { parseCidr } from "./addresses";

/**
 * Why a node refused or challenged a request (AccessLog.block_reason,
 * MinuteStats.block_reasons; ADR-0041 §3). The node records the reason where
 * it refuses; error codes alone are ambiguous (policy-denied, ip-banned).
 */
export const BLOCK_REASONS = [
  "ip_banned",
  "ip_blocked",
  "rule",
  "rate_limit",
  "crs",
  "cc",
  "challenge",
  "auth",
  "referer",
  "user_agent",
  "region",
  "cors",
  "websocket_origin",
  "client_cert",
  "maintenance",
] as const;
export const blockReason = z.enum(BLOCK_REASONS);
export type BlockReason = z.infer<typeof blockReason>;

/** Cache statuses nodes report (nginx $upstream_cache_status). */
export const CACHE_STATUSES = [
  "HIT",
  "MISS",
  "BYPASS",
  "EXPIRED",
  "STALE",
  "UPDATING",
  "REVALIDATED",
] as const;
/** AccessLog.http_version and MinuteStats.http_versions keys ("other" only in statistics). */
export const HTTP_VERSIONS = ["1.0", "1.1", "2", "3"] as const;
/** AccessLog.tls_version ("" on plain HTTP); statistics add "none" and "other". */
export const TLS_VERSIONS = ["1.2", "1.3"] as const;

/** Request headers a site may record at most (Site.log_headers). */
export const MAX_LOG_HEADERS = 8;
/** Request headers that never enter access logs. */
export const FORBIDDEN_LOG_HEADERS = ["authorization", "cookie", "proxy-authorization"] as const;
const logHeaderName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]{1,64}$/)
  .refine((name) => !(FORBIDDEN_LOG_HEADERS as readonly string[]).includes(name), {
    message: "header not allowed",
  });
export const logHeaders = z
  .array(logHeaderName)
  .max(MAX_LOG_HEADERS)
  .transform((names) => [...new Set(names)]);

/** "10.0.0.0/8", "2001:db8::/32" or a single address; host bits are cleared. */
const cidrFilter = z
  .string()
  .trim()
  .max(64)
  .refine((text) => text === "" || parseCidr(text) !== null, { message: "invalid CIDR" });

export const logQuery = z.object({
  siteId: z.uuid(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  status: z.coerce.number().int().min(100).max(599).optional(),
  ip: z.string().max(64).default(""),
  path: z.string().max(2048).default(""),
  /** Exact request id (X-Request-Id); omitted or empty matches every request. */
  requestId: z.string().max(128).optional(),
  /** Exact Host (any case). */
  host: z.string().trim().max(253).optional(),
  /** Exact method. */
  method: z
    .string()
    .trim()
    .regex(/^[A-Za-z_-]{0,32}$/)
    .optional(),
  /** Status class; with `status` both must hold. */
  statusClass: z.enum(["1xx", "2xx", "3xx", "4xx", "5xx"]).optional(),
  cacheStatus: z.enum(CACHE_STATUSES).optional(),
  /** A block reason, or `any` for every request with one. */
  blockReason: z.enum([...BLOCK_REASONS, "any"]).optional(),
  /** ISO 3166-1 alpha-2 country of the client. */
  country: z
    .string()
    .trim()
    .regex(/^(?:[A-Za-z]{2})?$/)
    .optional(),
  /** The client's network (AS number). */
  asn: z.coerce.number().int().min(1).max(4294967295).optional(),
  /** User-Agent contains (any case). */
  ua: z.string().max(256).optional(),
  /** Referer contains (any case). */
  referer: z.string().max(256).optional(),
  /** Duration at least this many milliseconds. */
  minDuration: z.coerce.number().int().min(0).max(86400000).optional(),
  /** Client IP in this network. */
  cidr: cidrFilter.optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});
export type LogQuery = z.infer<typeof logQuery>;
export const logEntry = z.object({
  id: z.string(),
  time: z.string(),
  nodeId: z.string(),
  siteId: z.string(),
  clientIp: z.string(),
  method: z.string(),
  host: z.string(),
  path: z.string(),
  status: z.coerce.number(),
  bytesSent: z.number(),
  durationMs: z.number(),
  cacheStatus: z.string(),
  sampleRate: z.number(),
  /** JA4 TLS client fingerprint; empty unless the site records it. */
  ja4: z.string().default(""),
  /** OWASP CRS rules the request matched (at most 16, ascending). */
  wafRuleIds: z.array(z.number().int()).default([]),
  /** CRS blocked the request (block mode, anomaly score at or above the threshold). */
  wafBlocked: z.boolean().default(false),
  /** The id the node answered with (X-Request-Id), also shown on error pages; empty for older nodes. */
  requestId: z.string().default(""),
  /** Rules with the log action that wrote this line whatever the sample rate (at most 8). */
  ruleIds: z.array(z.string()).default([]),
  /** User-Agent (at most 512 bytes); empty for older nodes. */
  userAgent: z.string().default(""),
  /** Referer without query string and fragment (at most 1024 bytes). */
  referer: z.string().default(""),
  /** "1.0", "1.1", "2" or "3". */
  httpVersion: z.string().default(""),
  /** "http" or "https". */
  scheme: z.string().default(""),
  /** ISO 3166-1 alpha-2; empty when unknown. */
  country: z.string().default(""),
  /** AS number; 0 when unknown. */
  asn: z.number().int().default(0),
  asName: z.string().default(""),
  /** The origin address that answered; empty when answered without the origin. */
  upstreamAddr: z.string().default(""),
  /** The origin's status; 0 without the origin. */
  upstreamStatus: z.number().int().default(0),
  /** Time to the origin, in milliseconds (with upstreamStatus). */
  upstreamMs: z.number().int().default(0),
  requestBytes: z.number().int().default(0),
  /** Response media type, lowercase, without parameters. */
  contentType: z.string().default(""),
  /** "1.2" or "1.3"; empty on plain HTTP. */
  tlsVersion: z.string().default(""),
  /** Why the node refused or challenged the request; empty when it did not. */
  blockReason: z.string().default(""),
  /** The rule behind blockReason (a WAF, rate limit or access authentication rule). */
  blockRuleId: z.string().default(""),
  /** Query string (without "?") while the site records it. */
  query: z.string().default(""),
  /** Recorded request headers (lowercase name → value) while the site records them. */
  headers: z.record(z.string(), z.string()).default({}),
  /** The connection's peer when it differs from clientIp, while the site records it. */
  peerIp: z.string().default(""),
});
export type LogEntry = z.infer<typeof logEntry>;

/** A site's access log settings; the options need node feature access-logs-v2. */
export const logSettings = z.object({
  sampleRate: z.number(),
  storage: z.enum(["lite", "clickhouse"]),
  /** Days the current storage keeps logs (system setting). */
  retentionDays: z.number().int(),
  /** Blocked, challenged and authentication-refused requests always get a line. */
  logBlocked: z.boolean(),
  /** Lines carry the query string. */
  logQuery: z.boolean(),
  /** Request headers lines carry (lowercase names). */
  logHeaders: z.array(z.string()),
  /** Lines carry the connection's peer address when it differs from the client's. */
  logPeer: z.boolean(),
});
export type LogSettings = z.infer<typeof logSettings>;
export const logSettingsInput = z.object({
  siteId: z.uuid(),
  /** Basis points; omitted keeps the current rate. */
  sampleRate: z.number().int().min(0).max(10000).optional(),
  logBlocked: z.boolean().optional(),
  logQuery: z.boolean().optional(),
  logHeaders: logHeaders.optional(),
  logPeer: z.boolean().optional(),
});
export type LogSettingsInput = z.infer<typeof logSettingsInput>;

/** System setting: days access logs are kept, per storage (ADR-0041 §5). */
export const LOG_RETENTION_DEFAULTS = { postgresDays: 7, clickhouseDays: 7 } as const;
export const logRetention = z.object({
  postgresDays: z.number().int().min(1).max(30),
  clickhouseDays: z.number().int().min(1).max(90),
});
export type LogRetention = z.infer<typeof logRetention>;
export const logRetentionSetting = logRetention.extend({
  /** The storage in use (EDGEWEIR_ANALYTICS): which of the two applies. */
  storage: z.enum(["lite", "clickhouse"]),
});

export const logsContract = {
  settings: oc
    .route({ method: "GET", path: "/sites/{siteId}/logs/settings", tags: ["logs"] })
    .input(z.object({ siteId: z.uuid() }))
    .output(logSettings),
  configure: oc
    .route({ method: "PUT", path: "/sites/{siteId}/logs/settings", tags: ["logs"] })
    .input(logSettingsInput)
    .output(z.object({ ok: z.literal(true) })),
  query: oc
    .route({ method: "GET", path: "/sites/{siteId}/logs", tags: ["logs"] })
    .input(logQuery)
    .output(z.object({ entries: z.array(logEntry), truncated: z.boolean() })),
  export: oc
    .route({ method: "GET", path: "/sites/{siteId}/logs/export", tags: ["logs"] })
    .input(logQuery)
    .output(z.object({ csv: z.string(), truncated: z.boolean() })),
};
