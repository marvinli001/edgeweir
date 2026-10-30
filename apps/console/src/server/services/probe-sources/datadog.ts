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

const SITES = new Set([
  "datadoghq.com",
  "us3.datadoghq.com",
  "us5.datadoghq.com",
  "datadoghq.eu",
  "ap1.datadoghq.com",
  "ap2.datadoghq.com",
  "uk1.datadoghq.com",
  "ddog-gov.com",
  "us2.ddog-gov.com",
]);

function api(ctx: PullContext) {
  const site = ctx.options.site ?? "datadoghq.com";
  if (!SITES.has(site)) throw new ProbeSourceError("refused");
  return `https://api.${site}/api/v1/synthetics`;
}
const headers = (ctx: PullContext) => ({
  "dd-api-key": ctx.credentials.api_key ?? "",
  "dd-application-key": ctx.credentials.application_key ?? "",
  accept: "application/json",
});

/**
 * Datadog Synthetics: API tests by public id; per test, the newest result
 * of each location (probe_dc) from /tests/{public_id}/results:
 * result.passed, result.timings.total (ms), check_time (ms).
 */
export const datadog: ProbeSourceAdapter = {
  provider: "datadog",
  async listMonitors(ctx): Promise<Monitor[]> {
    const out: Monitor[] = [];
    for (let page = 0; page < 20; page++) {
      const json = await getJson(ctx.http, {
        method: "GET",
        url: `${api(ctx)}/tests?page_size=100&page_number=${page}`,
        headers: headers(ctx),
      });
      if (!isRecord(json)) throw new ProbeSourceError("bad_response");
      const tests = asArray(json.tests).filter(isRecord);
      for (const t of tests) {
        const config = isRecord(t.config) ? t.config : {};
        const request = isRecord(config.request) ? config.request : {};
        out.push({
          id: str(t.public_id),
          name: str(t.name),
          target: str(request.url) || str(request.host),
        });
      }
      if (tests.length < 100) break;
    }
    return out;
  },
  async poll(ctx): Promise<Observation[]> {
    const out: Observation[] = [];
    for (const id of ctx.monitorIds) {
      if (!/^[a-z0-9]{3}-[a-z0-9]{3}-[a-z0-9]{3}$/.test(id)) continue;
      const json = await getJson(ctx.http, {
        method: "GET",
        url: `${api(ctx)}/tests/${id}/results`,
        headers: headers(ctx),
      });
      if (!isRecord(json)) throw new ProbeSourceError("bad_response");
      const newest = new Map<string, Record<string, unknown>>();
      for (const r of asArray(json.results).filter(isRecord)) {
        const location = str(r.probe_dc);
        const prev = newest.get(location);
        if (!prev || Number(r.check_time) > Number(prev.check_time)) newest.set(location, r);
      }
      for (const [location, r] of newest) {
        const result = isRecord(r.result) ? r.result : {};
        const timings = isRecord(result.timings) ? result.timings : {};
        const up = result.passed === true;
        out.push({
          monitorId: id,
          location,
          up,
          rttMs: up ? millis(timings.total) : null,
          lossPercent: null,
          error: up ? "" : "failed",
          checkedAt: dateOf(r.check_time),
        });
      }
    }
    return out;
  },
};
