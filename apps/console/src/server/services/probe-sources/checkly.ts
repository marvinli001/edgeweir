import * as z from "zod";
import {
  dateOf,
  errorCode,
  freshTimestamp,
  getJson,
  hmacHex,
  isRecord,
  type Monitor,
  millis,
  type Observation,
  type ProbeSourceAdapter,
  ProbeSourceError,
  type PullContext,
  safeEqual,
  str,
} from "./types";

const API = "https://api.checklyhq.com/v2";
/** Results looked at per check: the newest run of each location among them. */
const RESULTS = 100;
const MAX_PAGES = 20;

const headers = (ctx: PullContext) => ({
  authorization: `Bearer ${ctx.credentials.api_key ?? ""}`,
  "x-checkly-account": ctx.options.account_id ?? "",
});
/** A list answer: a bare array, or the entries of a paged object. */
const entries = (json: unknown) => {
  if (Array.isArray(json)) return json.filter(isRecord);
  if (isRecord(json) && Array.isArray(json.entries)) return json.entries.filter(isRecord);
  throw new ProbeSourceError("bad_response");
};

/**
 * The body of the Checkly webhook the docs ask for (a custom template):
 * {"checkId":"{{CHECK_ID}}","alertType":"{{ALERT_TYPE}}","runLocation":
 * "{{RUN_LOCATION}}","responseTime":"{{RESPONSE_TIME}}","startedAt":
 * "{{STARTED_AT}}"}. ALERT_FAILURE is down; ALERT_RECOVERY, ALERT_DEGRADED
 * and ALERT_DEGRADED_RECOVERY are up (degraded still answers); other types
 * (SSL) carry no result.
 */
const delivery = z.object({
  checkId: z.string().min(1).max(64),
  alertType: z.string().max(64),
  runLocation: z.string().max(64).optional(),
  responseTime: z.union([z.string(), z.number()]).optional(),
  startedAt: z.string().max(64).optional(),
});

/**
 * Checkly: per check, the newest result of each run location from
 * /v2/check-results/{checkId} (hasFailures or hasErrors is down,
 * responseTime in ms). The webhook alert channel's own secret signs the raw
 * body (x-checkly-signature, hex HMAC-SHA256); its x-checkly-timestamp is
 * not signed, so a delivery is also refused unless its startedAt is within
 * the tolerance, and a replayed body never overrides a newer result.
 */
export const checkly: ProbeSourceAdapter = {
  provider: "checkly",
  async listMonitors(ctx): Promise<Monitor[]> {
    const out: Monitor[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const list = entries(
        await getJson(ctx.http, {
          method: "GET",
          url: `${API}/checks?limit=100&page=${page}`,
          headers: headers(ctx),
        }),
      );
      for (const c of list) {
        const request = isRecord(c.request) ? c.request : {};
        out.push({
          id: str(c.id),
          name: str(c.name),
          target: str(request.url) || str(request.hostname) || str(request.host),
        });
      }
      if (list.length < 100) break;
    }
    return out;
  },
  async poll(ctx): Promise<Observation[]> {
    const out: Observation[] = [];
    const since = Math.floor(ctx.now.getTime() / 1000) - 3600;
    for (const id of ctx.monitorIds) {
      if (!/^[\w-]{1,64}$/.test(id)) continue;
      const list = entries(
        await getJson(ctx.http, {
          method: "GET",
          url: `${API}/check-results/${encodeURIComponent(id)}?limit=${RESULTS}&from=${since}&resultType=FINAL`,
          headers: headers(ctx),
        }),
      );
      const newest = new Map<string, Record<string, unknown>>();
      for (const r of list) {
        const location = str(r.runLocation);
        const at = dateOf(r.startedAt)?.getTime() ?? 0;
        const prev = newest.get(location);
        if (!prev || at > (dateOf(prev.startedAt)?.getTime() ?? 0)) newest.set(location, r);
      }
      for (const [location, r] of newest) {
        const up = !r.hasFailures && !r.hasErrors;
        out.push({
          monitorId: id,
          location,
          up,
          rttMs: up ? millis(r.responseTime) : null,
          lossPercent: null,
          error: up ? "" : r.hasErrors ? "error" : "failed",
          checkedAt: dateOf(r.startedAt),
        });
      }
    }
    return out;
  },
  verifyWebhook({ headers: h, body, now }, secret) {
    if (!freshTimestamp(h.get("x-checkly-timestamp"), now)) return "timestamp_invalid";
    const signature = (h.get("x-checkly-signature") ?? "").trim().toLowerCase();
    return safeEqual(signature, hmacHex(secret, body)) ? "ok" : "signature_invalid";
  },
  parseWebhook(body, now) {
    const parsed = delivery.safeParse(body);
    if (!parsed.success) return null;
    const d = parsed.data;
    const startedAt = dateOf(d.startedAt);
    // The body is signed, its timestamp header is not: the run time bounds a replay.
    if (!startedAt || Math.abs(now.getTime() - startedAt.getTime()) > 3600_000) return null;
    const type = d.alertType.toUpperCase();
    if (!type.startsWith("ALERT_") || type === "ALERT_SSL") return [];
    const up = type !== "ALERT_FAILURE";
    return [
      {
        monitorId: d.checkId,
        location: d.runLocation ?? "",
        up,
        rttMs: up ? millis(d.responseTime) : null,
        lossPercent: null,
        error: up ? "" : errorCode(type.replace(/^ALERT_/, "")) || "failure",
        checkedAt: startedAt,
      },
    ];
  },
};
