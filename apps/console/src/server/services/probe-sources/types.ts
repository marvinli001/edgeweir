import { createHmac, timingSafeEqual } from "node:crypto";
import type { ProbeSourceProvider } from "@edgeweir/contract";

/** One result of a provider's monitor, normalized (ADR-0069). */
export interface Observation {
  monitorId: string;
  /** The provider's checking location; "" when it reports one result per monitor. */
  location: string;
  up: boolean;
  /** Response time of the check; null when the provider gives none (or it failed). */
  rttMs: number | null;
  /** Packet or attempt loss the provider measured; null: from `up` alone. */
  lossPercent: number | null;
  /** A short failure code (letters, digits, underscores); "" when up. */
  error: string;
  /** When the provider checked; null: unknown (the console's time is used). */
  checkedAt: Date | null;
}

/** A monitor as the provider lists it, for the mapping table. */
export interface Monitor {
  id: string;
  name: string;
  /** What it checks: a URL, host name or IP. */
  target: string;
}

export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Record<string, string>;
  body?: Buffer;
}
interface HttpResponse {
  status: number;
  body: Buffer;
}
/** An outbound request under the console's outbound policy (tests pass a fake). */
export type Http = (request: HttpRequest) => Promise<HttpResponse>;

export interface PullContext {
  credentials: Record<string, string>;
  options: Record<string, string>;
  http: Http;
  now: Date;
  /** The mapped monitors (poll asks for these only, where the API allows). */
  monitorIds: readonly string[];
}

/** Failure codes a source reports (stored as last_error; `probe_source_error_<code>` in the UI). */
const PROBE_SOURCE_ERRORS = [
  "auth_failed",
  "rate_limited",
  "unreachable",
  "refused",
  "bad_response",
  "provider_error",
] as const;
export type ProbeSourceErrorCode = (typeof PROBE_SOURCE_ERRORS)[number];

export class ProbeSourceError extends Error {
  constructor(readonly code: ProbeSourceErrorCode) {
    super(`probe source: ${code}`);
  }
}

interface WebhookRequest {
  headers: Headers;
  body: Buffer;
  now: Date;
}
/** ok, or why a delivery is refused (401). */
type WebhookVerdict = "ok" | "signature_invalid" | "timestamp_invalid";

export interface ProbeSourceAdapter {
  provider: ProbeSourceProvider;
  /** Lists the account's monitors (pull providers). */
  listMonitors?(ctx: PullContext): Promise<Monitor[]>;
  /** The latest results of the mapped monitors (pull providers). */
  poll?(ctx: PullContext): Promise<Observation[]>;
  /** Checks a delivery's authentication with the source's webhook secret. */
  verifyWebhook?(request: WebhookRequest, secret: string): WebhookVerdict;
  /**
   * The results a verified delivery carries; null when the body is not a
   * delivery this adapter understands (400).
   */
  parseWebhook?(body: unknown, now: Date): Observation[] | null;
}

/** Deliveries signed longer ago (or further ahead) than this are refused. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/** Constant-time comparison of two strings (false when the lengths differ). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

export const hmacHex = (secret: string, data: Buffer | string) =>
  createHmac("sha256", secret).update(data).digest("hex");

/** A Unix-seconds timestamp header inside the tolerance of `now`. */
export function freshTimestamp(value: string | null, now: Date): boolean {
  if (!value || !/^\d{1,12}$/.test(value)) return false;
  return Math.abs(now.getTime() / 1000 - Number(value)) <= WEBHOOK_TOLERANCE_SECONDS;
}

/** A failure code from free text: lowercase letters, digits and underscores, at most 32. */
export function errorCode(value: unknown): string {
  return typeof value === "string"
    ? value
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 32)
    : "";
}

/** A finite, non-negative number of milliseconds (at most a minute), else null. */
export function millis(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 60_000
    ? Math.round(n)
    : null;
}

/** A date from an ISO string or Unix seconds / milliseconds; null when it is none. */
export function dateOf(value: unknown): Date | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0)
    return new Date(value < 1e11 ? value * 1000 : value);
  if (typeof value === "string" && value) {
    if (/^\d+$/.test(value)) return dateOf(Number(value));
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : new Date(t);
  }
  return null;
}

/** Parses a JSON response body; bad_response when it is not JSON. */
export function jsonBody(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ProbeSourceError("bad_response");
  }
}

/** Maps an HTTP status of a provider API to an error (null for 2xx). */
function statusError(status: number): ProbeSourceError | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return new ProbeSourceError("auth_failed");
  if (status === 429) return new ProbeSourceError("rate_limited");
  return new ProbeSourceError("provider_error");
}

/** Sends the request and returns the parsed JSON of a 2xx answer. */
export async function getJson(http: Http, request: HttpRequest): Promise<unknown> {
  const response = await http(request);
  const error = statusError(response.status);
  if (error) throw error;
  return jsonBody(response.body);
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const str = (value: unknown): string =>
  typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
