import { createHash } from "node:crypto";
import { probeSourceEntry } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { AccessKeyRateLimiter } from "./access-keys";
import { openWebhookSecret, recordObservations } from "./external-probes";
import { adapterOf } from "./probe-sources";
import { WEBHOOK_TOLERANCE_SECONDS } from "./probe-sources/types";

/** Largest delivery body. */
export const PROBE_SOURCE_WEBHOOK_MAX_BYTES = 256 * 1024;
/** Deliveries per client address and minute (before any secret is checked). */
const PER_IP_PER_MINUTE = 600;
/** Deliveries per source and minute. */
const PER_SOURCE_PER_MINUTE = 300;
/** Signatures remembered per process to refuse an exact replay within the tolerance. */
const MAX_REMEMBERED = 20_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WebhookOutcome {
  status: 202 | 400 | 401 | 404 | 409 | 429;
  code: string;
  retryAfterSeconds?: number;
  /** Clusters whose evaluation the delivery concerns (202 only). */
  clusterIds?: string[];
  accepted?: number;
}

/**
 * The receiving side of external probe source webhooks: rate limits per
 * client address and per source, the provider's verification (constant
 * time, timestamp tolerance), exact replays refused, then the results
 * recorded (older results than the stored ones are ignored). Process-local
 * state, like the AccessKey limits.
 */
export class ProbeSourceWebhooks {
  private readonly limits: AccessKeyRateLimiter;
  private readonly seen = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {
    this.limits = new AccessKeyRateLimiter(now);
  }

  async handle(
    app: AppContext,
    sourceId: string,
    request: { headers: Headers; body: Buffer; ip: string },
  ): Promise<WebhookOutcome> {
    const ipWait = this.limits.take(`ip:${request.ip}`, PER_IP_PER_MINUTE, 60_000);
    if (ipWait !== null)
      return { status: 429, code: "rate_limited", retryAfterSeconds: Math.ceil(ipWait / 1000) };
    if (!UUID_RE.test(sourceId)) return { status: 404, code: "not_found" };
    const [row] = await app.db
      .select()
      .from(schema.externalProbeSource)
      .where(eq(schema.externalProbeSource.id, sourceId.toLowerCase()));
    const adapter = row ? adapterOf(row.provider) : undefined;
    // Unknown, disabled and webhook-less sources look alike.
    if (
      !row ||
      !row.enabled ||
      !row.webhookSecretEnvelope ||
      !adapter?.verifyWebhook ||
      !adapter.parseWebhook ||
      !probeSourceEntry(row.provider)?.webhook
    )
      return { status: 404, code: "not_found" };
    const sourceWait = this.limits.take(`source:${row.id}`, PER_SOURCE_PER_MINUTE, 60_000);
    if (sourceWait !== null)
      return { status: 429, code: "rate_limited", retryAfterSeconds: Math.ceil(sourceWait / 1000) };
    const now = new Date(this.now());
    const secret = openWebhookSecret(app, row) ?? "";
    const verdict = adapter.verifyWebhook(
      { headers: request.headers, body: request.body, now },
      secret,
    );
    if (verdict !== "ok") {
      app.log.warn("probe source delivery refused", {
        sourceId: row.id,
        ip: request.ip,
        reason: verdict,
      });
      return { status: 401, code: verdict };
    }
    const fingerprint = createHash("sha256")
      .update(row.id)
      .update("\u0000")
      .update(request.body)
      .update("\u0000")
      .update(
        [...request.headers.entries()]
          .filter(([name]) => /signature|timestamp/i.test(name))
          .map(([name, value]) => `${name}:${value}`)
          .sort()
          .join("\n"),
      )
      .digest("hex");
    if (!this.remember(fingerprint, now.getTime())) return { status: 409, code: "replayed" };
    let body: unknown;
    try {
      body = JSON.parse(request.body.toString("utf8"));
    } catch {
      return { status: 400, code: "invalid_payload" };
    }
    const observations = adapter.parseWebhook(body, now);
    if (!observations) return { status: 400, code: "invalid_payload" };
    const clusterIds = await recordObservations(app.db, row.id, observations, now, "webhook");
    return { status: 202, code: "accepted", clusterIds, accepted: observations.length };
  }

  /** False when the fingerprint was seen within the tolerance. */
  private remember(fingerprint: string, now: number) {
    const ttl = 2 * WEBHOOK_TOLERANCE_SECONDS * 1000;
    const expires = this.seen.get(fingerprint);
    if (expires !== undefined && expires > now) return false;
    if (this.seen.size >= MAX_REMEMBERED)
      for (const [key, until] of this.seen) if (until <= now) this.seen.delete(key);
    // Still full of live entries: forget the oldest (Map keeps insertion order).
    while (this.seen.size >= MAX_REMEMBERED) {
      const first = this.seen.keys().next().value;
      if (first === undefined) break;
      this.seen.delete(first);
    }
    this.seen.set(fingerprint, now + ttl);
    return true;
  }
}
