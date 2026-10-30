import { tc3Sign } from "../sms";
import {
  asArray,
  dateOf,
  errorCode,
  isRecord,
  jsonBody,
  type Monitor,
  millis,
  type Observation,
  type ProbeSourceAdapter,
  ProbeSourceError,
  type PullContext,
  str,
} from "./types";

const HOST = "cat.tencentcloudapi.com";
const PAGE = 100;
const MAX_PAGES = 20;
/** Probe records looked at per task: the newest of each city/ISP among them. */
const RECORDS = 1000;
/** Task types with network-quality data (5); others (page, port, …) have no ping. */
const FIELDS = ["PingTime", "PingPackageLossRate", "ErrorId"];

/** One API call of CAT 2018-04-09 (TC3, service "cat"). */
async function call(ctx: PullContext, action: string, params: Record<string, unknown>) {
  const payload = JSON.stringify(params);
  const timestamp = Math.floor(ctx.now.getTime() / 1000);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    host: HOST,
    "x-tc-action": action,
  };
  const { authorization } = tc3Sign({
    secretId: ctx.options.secret_id ?? "",
    secretKey: ctx.credentials.secret_key ?? "",
    service: "cat",
    timestamp,
    headers,
    payload,
  });
  const response = await ctx.http({
    method: "POST",
    url: `https://${HOST}/`,
    headers: {
      ...headers,
      "x-tc-timestamp": String(timestamp),
      "x-tc-version": "2018-04-09",
      authorization,
    },
    body: Buffer.from(payload),
  });
  if (response.status === 429) throw new ProbeSourceError("rate_limited");
  if (response.status < 200 || response.status >= 300) throw new ProbeSourceError("provider_error");
  const json = jsonBody(response.body);
  const reply = isRecord(json) && isRecord(json.Response) ? json.Response : null;
  if (!reply) throw new ProbeSourceError("bad_response");
  if (isRecord(reply.Error)) {
    const code = str(reply.Error.Code);
    if (/^(AuthFailure|UnauthorizedOperation)/.test(code))
      throw new ProbeSourceError("auth_failed");
    if (/^RequestLimitExceeded/.test(code)) throw new ProbeSourceError("rate_limited");
    throw new ProbeSourceError("provider_error");
  }
  return reply;
}

/** A label or field of a probe record by its ID or Name. */
function pick(list: unknown, id: string) {
  for (const item of asArray(list).filter(isRecord))
    if (item.ID === id || item.Name === id) return item.Value;
  return undefined;
}

/**
 * Tencent Cloud CAT (云拨测, 2018-04-09, TC3): tasks from DescribeProbeTasks;
 * per task, the newest network-quality record of each city/ISP from
 * DescribeDetailedSingleProbeData (the last 10 minutes): ErrorId 0 is up,
 * PingTime the latency (ms), PingPackageLossRate the loss (%).
 */
export const tencentCat: ProbeSourceAdapter = {
  provider: "tencent_cat",
  async listMonitors(ctx): Promise<Monitor[]> {
    const out: Monitor[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const reply = await call(ctx, "DescribeProbeTasks", { Offset: page * PAGE, Limit: PAGE });
      const list = asArray(reply.TaskSet).filter(isRecord);
      for (const t of list)
        out.push({ id: str(t.TaskId), name: str(t.Name), target: str(t.TargetAddress) });
      if (list.length < PAGE || out.length >= Number(reply.Total ?? 0)) break;
    }
    return out;
  },
  async poll(ctx): Promise<Observation[]> {
    const out: Observation[] = [];
    const end = ctx.now.getTime();
    for (const id of ctx.monitorIds) {
      if (!/^[\w-]{1,64}$/.test(id)) continue;
      const reply = await call(ctx, "DescribeDetailedSingleProbeData", {
        BeginTime: end - 600_000,
        EndTime: end,
        TaskType: "AnalyzeTaskType_Network",
        SortField: "ProbeTime",
        Ascending: false,
        SelectedFields: FIELDS,
        Offset: 0,
        Limit: RECORDS,
        TaskID: [id],
      });
      const newest = new Map<string, Record<string, unknown>>();
      for (const r of asArray(reply.DataSet).filter(isRecord)) {
        const location = [str(pick(r.Labels, "City")), str(pick(r.Labels, "Operator"))]
          .filter(Boolean)
          .join("/")
          .slice(0, 64);
        const prev = newest.get(location);
        if (!prev || Number(r.ProbeTime) > Number(prev.ProbeTime)) newest.set(location, r);
      }
      for (const [location, r] of newest) {
        const errorId = str(pick(r.Fields, "ErrorId"));
        const up = errorId === "" || errorId === "0";
        const loss = Number(pick(r.Fields, "PingPackageLossRate"));
        out.push({
          monitorId: id,
          location,
          up,
          rttMs: up ? millis(pick(r.Fields, "PingTime")) : null,
          lossPercent: Number.isFinite(loss) && loss >= 0 && loss <= 100 ? loss : null,
          error: up ? "" : errorCode(`error_${errorId}`),
          checkedAt: dateOf(r.ProbeTime),
        });
      }
    }
    return out;
  },
};
