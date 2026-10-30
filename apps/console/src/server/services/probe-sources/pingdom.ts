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

const API = "https://api.pingdom.com/api/3.1";

async function checks(ctx: PullContext) {
  const json = await getJson(ctx.http, {
    method: "GET",
    url: `${API}/checks?include_tags=false`,
    headers: { authorization: `Bearer ${ctx.credentials.api_token ?? ""}` },
  });
  if (!isRecord(json)) throw new ProbeSourceError("bad_response");
  return asArray(json.checks).filter(isRecord);
}

/**
 * Pingdom: one result per check from GET /checks: status "up", "down" or
 * "unconfirmed_down" (paused and unknown give none), lastresponsetime (ms)
 * and lasttesttime (Unix seconds).
 */
export const pingdom: ProbeSourceAdapter = {
  provider: "pingdom",
  async listMonitors(ctx): Promise<Monitor[]> {
    return (await checks(ctx)).map((c) => ({
      id: str(c.id),
      name: str(c.name),
      target: str(c.hostname),
    }));
  },
  async poll(ctx): Promise<Observation[]> {
    const wanted = new Set(ctx.monitorIds);
    const out: Observation[] = [];
    for (const c of await checks(ctx)) {
      const id = str(c.id);
      const status = str(c.status);
      if (!wanted.has(id) || !["up", "down", "unconfirmed_down"].includes(status)) continue;
      const up = status === "up";
      out.push({
        monitorId: id,
        location: "",
        up,
        rttMs: up ? millis(c.lastresponsetime) : null,
        lossPercent: null,
        error: up ? "" : status,
        checkedAt: dateOf(c.lasttesttime),
      });
    }
    return out;
  },
};
