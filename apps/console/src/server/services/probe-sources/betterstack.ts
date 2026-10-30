import {
  asArray,
  dateOf,
  getJson,
  isRecord,
  type Monitor,
  millis,
  type Observation,
  type ProbeSourceAdapter,
  ProbeSourceError,
  type PullContext,
  str,
} from "./types";

const API = "https://incidents.betterstack.com/api/v2";
const MAX_PAGES = 40;

const auth = (ctx: PullContext) => ({ authorization: `Bearer ${ctx.credentials.api_token ?? ""}` });

/** Every monitor (JSON:API pages, `pagination.next`). */
async function monitors(ctx: PullContext) {
  const out: Record<string, unknown>[] = [];
  let url: string | null = `${API}/monitors?per_page=250`;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const json = await getJson(ctx.http, { method: "GET", url, headers: auth(ctx) });
    if (!isRecord(json)) throw new ProbeSourceError("bad_response");
    out.push(...asArray(json.data).filter(isRecord));
    const next: unknown = isRecord(json.pagination) ? json.pagination.next : null;
    // Only follow pages of the same API.
    url = typeof next === "string" && next.startsWith(`${API}/`) ? next : null;
  }
  return out;
}

/**
 * Better Stack Uptime: the monitor's status ("up", "down"; paused,
 * pending, maintenance and validating give no result) and, per region,
 * the newest response time (seconds) from /monitors/{id}/response-times.
 * The state is the monitor's own: each region's result carries it.
 */
export const betterstack: ProbeSourceAdapter = {
  provider: "betterstack",
  async listMonitors(ctx): Promise<Monitor[]> {
    return (await monitors(ctx)).map((m) => {
      const a = isRecord(m.attributes) ? m.attributes : {};
      return {
        id: str(m.id),
        name: str(a.pronounceable_name) || str(a.url),
        target: str(a.url),
      };
    });
  },
  async poll(ctx): Promise<Observation[]> {
    const wanted = new Set(ctx.monitorIds);
    const out: Observation[] = [];
    for (const m of await monitors(ctx)) {
      const id = str(m.id);
      if (!wanted.has(id)) continue;
      const a = isRecord(m.attributes) ? m.attributes : {};
      const status = str(a.status);
      if (status !== "up" && status !== "down") continue;
      const up = status === "up";
      const checkedAt = dateOf(a.last_checked_at);
      const regions: { region: string; rtt: number | null }[] = [];
      if (up) {
        const json = await getJson(ctx.http, {
          method: "GET",
          url: `${API}/monitors/${encodeURIComponent(id)}/response-times`,
          headers: auth(ctx),
        });
        const attributes =
          isRecord(json) && isRecord(json.data) && isRecord(json.data.attributes)
            ? json.data.attributes
            : {};
        for (const r of asArray(attributes.regions).filter(isRecord)) {
          const times = asArray(r.response_times).filter(isRecord);
          const newest = times.reduce<Record<string, unknown> | undefined>(
            (best, t) =>
              !best || (dateOf(t.at)?.getTime() ?? 0) > (dateOf(best.at)?.getTime() ?? 0)
                ? t
                : best,
            undefined,
          );
          const seconds = Number(newest?.response_time);
          regions.push({
            region: str(r.region),
            rtt: Number.isFinite(seconds) ? millis(seconds * 1000) : null,
          });
        }
      }
      if (!regions.length) regions.push({ region: "", rtt: null });
      for (const r of regions)
        out.push({
          monitorId: id,
          location: r.region,
          up,
          rttMs: up ? r.rtt : null,
          lossPercent: null,
          error: up ? "" : "down",
          checkedAt,
        });
    }
    return out;
  },
};
