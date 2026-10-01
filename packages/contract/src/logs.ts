import { oc } from "@orpc/contract";
import * as z from "zod";
export const logQuery = z.object({
  siteId: z.uuid(),
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  status: z.coerce.number().int().min(100).max(599).optional(),
  ip: z.string().max(64).default(""),
  path: z.string().max(2048).default(""),
  /** Exact request id (X-Request-Id); omitted or empty matches every request. */
  requestId: z.string().max(128).optional(),
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
});
export type LogEntry = z.infer<typeof logEntry>;
export const logsContract = {
  settings: oc
    .route({ method: "GET", path: "/sites/{siteId}/logs/settings", tags: ["logs"] })
    .input(z.object({ siteId: z.uuid() }))
    .output(z.object({ sampleRate: z.number(), storage: z.enum(["lite", "clickhouse"]) })),
  configure: oc
    .route({ method: "PUT", path: "/sites/{siteId}/logs/settings", tags: ["logs"] })
    .input(z.object({ siteId: z.uuid(), sampleRate: z.number().int().min(0).max(10000) }))
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
