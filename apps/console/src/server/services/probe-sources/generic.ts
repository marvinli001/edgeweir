import * as z from "zod";
import {
  errorCode,
  freshTimestamp,
  hmacHex,
  type Observation,
  type ProbeSourceAdapter,
  safeEqual,
} from "./types";

/** Results per delivery of the generic webhook. */
export const MAX_GENERIC_RESULTS = 1000;

const genericResult = z.object({
  /** The monitor id the mapping table names. */
  monitor: z.string().min(1).max(200),
  location: z
    .string()
    .max(64)
    .regex(/^[\w .:/-]*$/)
    .default(""),
  up: z.boolean(),
  latencyMs: z.number().min(0).max(60_000).nullable().optional(),
  lossPercent: z.number().min(0).max(100).nullable().optional(),
  error: z.string().max(64).optional(),
  checkedAt: z.iso.datetime({ offset: true }).optional(),
});
const genericDelivery = z.object({ results: z.array(genericResult).max(MAX_GENERIC_RESULTS) });

/**
 * The generic webhook: any sender that signs like the console's own
 * outgoing webhooks (X-Edgeweir-Timestamp: Unix seconds, X-Edgeweir-
 * Signature: v1=<hex HMAC-SHA256 of "<timestamp>.<body>">, 300 s).
 */
export const genericWebhook: ProbeSourceAdapter = {
  provider: "generic_webhook",
  verifyWebhook({ headers, body, now }, secret) {
    const timestamp = headers.get("x-edgeweir-timestamp");
    if (!freshTimestamp(timestamp, now)) return "timestamp_invalid";
    const signature = headers.get("x-edgeweir-signature") ?? "";
    const expected = `v1=${hmacHex(secret, Buffer.concat([Buffer.from(`${timestamp}.`), body]))}`;
    return safeEqual(signature.trim().toLowerCase(), expected) ? "ok" : "signature_invalid";
  },
  parseWebhook(body) {
    const parsed = genericDelivery.safeParse(body);
    if (!parsed.success) return null;
    return parsed.data.results.map(
      (r): Observation => ({
        monitorId: r.monitor,
        location: r.location.trim(),
        up: r.up,
        rttMs: r.up && r.latencyMs != null ? Math.round(r.latencyMs) : null,
        lossPercent: r.lossPercent ?? null,
        error: r.up ? "" : errorCode(r.error ?? "down") || "down",
        checkedAt: r.checkedAt ? new Date(r.checkedAt) : null,
      }),
    );
  },
};
