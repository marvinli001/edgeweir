import { oc } from "@orpc/contract";
import * as z from "zod";
import { isoDateTime, uuid } from "./schemas";

/**
 * Node logs (feature node-logs-v1, ADR-0050): a node's warnings, errors and
 * whitelisted events from its agent, supervisor and OpenResty, uploaded with
 * ReportNodeLogs and kept for a short time.
 */
export const NODE_LOG_LEVELS = ["info", "warn", "error"] as const;
export type NodeLogLevel = (typeof NODE_LOG_LEVELS)[number];
export const NODE_LOG_SOURCES = ["agent", "supervisor", "nginx", "lua"] as const;
export type NodeLogSource = (typeof NODE_LOG_SOURCES)[number];
/** The only info entries a node uploads (the node's nodelog.events). */
export const NODE_LOG_EVENTS = [
  "agent_started",
  "config_applied",
  "last_known_good",
  "engine_started",
  "certificate_renewed",
  "channel_switched",
  "upgrade_applied",
  "engine_logs_unavailable",
] as const;
export type NodeLogEvent = (typeof NODE_LOG_EVENTS)[number];
/** entry: one the node uploaded; dropped: how many the node dropped before a batch. */
export const NODE_LOG_KINDS = ["entry", "dropped"] as const;

/** Limits of one entry (the node applies the same). */
export const NODE_LOG_LIMITS = {
  message: 2048,
  fields: 16,
  fieldKey: 64,
  fieldValue: 512,
  /** Entries in one ReportNodeLogs batch. */
  batch: 500,
} as const;

export const nodeLogQuery = z.object({
  id: uuid,
  /** Entries at this level and above (default all). */
  minLevel: z.enum(NODE_LOG_LEVELS).optional(),
  source: z.enum(NODE_LOG_SOURCES).optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  /** Message contains (any case). */
  q: z.string().trim().max(200).optional(),
  /** nextCursor of the previous page (older entries). */
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type NodeLogQuery = z.infer<typeof nodeLogQuery>;

export const nodeLogEntry = z.object({
  id: z.string(),
  /** When it happened on the node. */
  time: isoDateTime,
  receivedAt: isoDateTime,
  kind: z.enum(NODE_LOG_KINDS),
  level: z.enum(NODE_LOG_LEVELS),
  source: z.enum(NODE_LOG_SOURCES),
  component: z.string(),
  message: z.string(),
  fields: z.record(z.string(), z.string()),
  /** Entries like this one the node folded into it. */
  repeated: z.number().int(),
  truncated: z.boolean(),
  /** An info entry's event; empty otherwise. */
  event: z.string(),
  /** kind dropped: entries over the node's rate limits and for its buffers. */
  dropped: z.object({ rateLimited: z.number().int(), overflow: z.number().int() }).nullable(),
});
export type NodeLogEntry = z.infer<typeof nodeLogEntry>;

export const nodeLogPage = z.object({
  /** Newest first. */
  entries: z.array(nodeLogEntry),
  nextCursor: z.string().nullable(),
  /** The node reports node-logs-v1 (older nodes upload none). */
  supported: z.boolean(),
});
export type NodeLogPage = z.infer<typeof nodeLogPage>;

/** System setting: how long node logs are kept, and at most how many per node. */
export const NODE_LOG_RETENTION_DEFAULTS = { days: 7, perNode: 10000 } as const;
export const nodeLogRetention = z.object({
  days: z.number().int().min(1).max(30),
  perNode: z.number().int().min(1000).max(100000),
});
export type NodeLogRetention = z.infer<typeof nodeLogRetention>;

export const nodeLogsContract = {
  logs: oc
    .route({ method: "GET", path: "/nodes/{id}/logs", tags: ["nodes"] })
    .input(nodeLogQuery)
    .output(nodeLogPage),
};

// Secrets the node removes before it stores an entry; the console removes
// them again (an older or faulty node). The node's internal/nodelog/redact.go
// has the same rules, test/fixtures/node-log-redaction.json the shared vectors.
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g;
const USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s@"'<>]+@/gi;
const QUERY =
  /((?:\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>?#]*|(?:^|[\s"'(=:,[])\/[^\s"'<>?#]*)\?)[^\s"'<>#]+/gi;
const HEADER =
  /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-amz-security-token)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\r\n"']*)/gi;
const BEARER = /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KEY_VALUE =
  /\b([a-z0-9_.-]*(?:token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?key|signature|credential|session[_-]?id)[a-z0-9_.-]*)(["']?\s*=\s*|["']\s*:\s*)("[^"]*"|'[^']*'|[^\s,;&"'<>)]+)/gi;
const CONSOLE_TOKEN = /\bew[kpstw]_[A-Za-z0-9_-]{16,}/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const SENSITIVE_KEY =
  /(token|secret|passw(?:or)?d|api[_-]?key|access[_-]?key|private[_-]?key|auth[_-]?key|signature|credential|session[_-]?id|authorization|cookie)/i;
export const NODE_LOG_REDACTED = "[redacted]";

/**
 * Removes secrets from node log text: PEM blocks, URL userinfo, query
 * strings, credential headers, bearer tokens, values of credential-like
 * keys, the console's tokens and JWTs. Applying it twice changes nothing more.
 */
export function redactNodeLogText(s: string): string {
  if (!s) return s;
  const r = NODE_LOG_REDACTED;
  return s
    .replace(PEM_BLOCK, r)
    .replace(USERINFO, `$1${r}@`)
    .replace(QUERY, `$1${r}`)
    .replace(HEADER, `$1$2${r}`)
    .replace(BEARER, `$1 ${r}`)
    .replace(KEY_VALUE, `$1$2${r}`)
    .replace(CONSOLE_TOKEN, r)
    .replace(JWT, r);
}

/** A field's value with secrets removed; a credential-like key removes all of it. */
export function redactNodeLogField(key: string, value: string): string {
  return SENSITIVE_KEY.test(key) ? NODE_LOG_REDACTED : redactNodeLogText(value);
}
