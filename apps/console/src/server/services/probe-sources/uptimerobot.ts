import {
  asArray,
  getJson,
  isRecord,
  type Monitor,
  type Observation,
  type ProbeSourceAdapter,
  ProbeSourceError,
  type PullContext,
  str,
} from "./types";

const API = "https://api.uptimerobot.com/v3";
/** Monitors per page (the API's maximum). */
const PAGE = 200;
const MAX_PAGES = 25;

/** Every monitor of the account, following `nextLink` (same API only). */
async function monitors(ctx: PullContext) {
  const out: Record<string, unknown>[] = [];
  let url: string | null = `${API}/monitors?limit=${PAGE}`;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const json = await getJson(ctx.http, {
      method: "GET",
      url,
      headers: { authorization: `Bearer ${ctx.credentials.api_key ?? ""}` },
    });
    if (!isRecord(json)) throw new ProbeSourceError("bad_response");
    out.push(...asArray(json.data).filter(isRecord));
    const next = json.nextLink;
    url = typeof next === "string" && next.startsWith(`${API}/monitors`) ? next : null;
  }
  return out;
}

/**
 * UptimeRobot (API v3, GET /monitors, a bearer API token; a read-only key
 * is enough): one result per monitor, UP up, DOWN and LOOKS_DOWN down;
 * PAUSED and STARTED (not checked yet) give none. One request per poll:
 * the free plan allows 10 a minute, and the API has neither per-location
 * state nor packet loss.
 */
export const uptimerobot: ProbeSourceAdapter = {
  provider: "uptimerobot",
  async listMonitors(ctx): Promise<Monitor[]> {
    return (await monitors(ctx)).map((m) => ({
      id: str(m.id),
      name: str(m.friendlyName),
      target: str(m.url),
    }));
  },
  async poll(ctx): Promise<Observation[]> {
    const wanted = new Set(ctx.monitorIds);
    const out: Observation[] = [];
    for (const m of await monitors(ctx)) {
      const id = str(m.id);
      const status = str(m.status).toUpperCase();
      if (!wanted.has(id) || !["UP", "DOWN", "LOOKS_DOWN"].includes(status)) continue;
      const up = status === "UP";
      out.push({
        monitorId: id,
        location: "",
        up,
        rttMs: null,
        lossPercent: null,
        error: up ? "" : status.toLowerCase(),
        checkedAt: null,
      });
    }
    return out;
  },
};
