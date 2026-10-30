import { createHash, randomUUID } from "node:crypto";
import { acs3Sign } from "../sms";
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

const REGIONS = new Set([
  "cn-hangzhou",
  "cn-shanghai",
  "cn-beijing",
  "cn-shenzhen",
  "cn-hongkong",
  "ap-southeast-1",
]);
const PAGE = 100;
const MAX_PAGES = 20;
/** TaskIds per DescribeSiteMonitorLog request. */
const TASKS_PER_LOG = 20;
const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

/** One RPC call of CMS 2019-01-01 (ACS3, parameters in the query). */
async function call(ctx: PullContext, action: string, params: Record<string, string>) {
  const region = ctx.options.region ?? "cn-hangzhou";
  if (!REGIONS.has(region)) throw new ProbeSourceError("refused");
  const host = `metrics.${region}.aliyuncs.com`;
  const headers = {
    host,
    "x-acs-action": action,
    "x-acs-version": "2019-01-01",
    "x-acs-date": ctx.now.toISOString().replace(/\.\d+Z$/, "Z"),
    "x-acs-signature-nonce": randomUUID().replaceAll("-", ""),
    "x-acs-content-sha256": sha256(""),
  };
  const { query, authorization } = acs3Sign({
    method: "POST",
    query: params,
    headers,
    accessKeyId: ctx.options.access_key_id ?? "",
    accessKeySecret: ctx.credentials.access_key_secret ?? "",
  });
  const response = await ctx.http({
    method: "POST",
    url: `https://${host}/?${query}`,
    headers: { ...headers, authorization },
    body: Buffer.alloc(0),
  });
  const json = jsonBody(response.body);
  const code = isRecord(json) ? str(json.Code) : "";
  // Errors carry a Code (HTTP 4xx); a success has Code "200" or none.
  if (response.status >= 200 && response.status < 300 && (code === "" || code === "200"))
    return isRecord(json) ? json : {};
  if (/^(InvalidAccessKeyId|SignatureDoesNotMatch|Forbidden|InvalidSecurityToken)/.test(code))
    throw new ProbeSourceError("auth_failed");
  if (/^Throttling/.test(code) || response.status === 429)
    throw new ProbeSourceError("rate_limited");
  if (response.status === 401 || response.status === 403) throw new ProbeSourceError("auth_failed");
  throw new ProbeSourceError("provider_error");
}

/** A probe log's verdict: no error code and no HTTP error status. */
function upOf(log: Record<string, unknown>) {
  const error = str(log.errorCode);
  const http = Number(log.HTTPResponseCode);
  return (error === "" || error === "0") && !(Number.isFinite(http) && http >= 400);
}

/**
 * Alibaba Cloud CloudMonitor site monitoring (CMS 2019-01-01, ACS3): tasks
 * from DescribeSiteMonitorList; per task, the newest probe log of each
 * city/ISP from DescribeSiteMonitorLog (MetricName ProbeLog, the last
 * 10 minutes). The success rule is not documented: no errorCode (or 0) and
 * an HTTP status below 400 is up; TotalTime is the latency in ms.
 */
export const aliyunSiteMonitor: ProbeSourceAdapter = {
  provider: "aliyun_site_monitor",
  async listMonitors(ctx): Promise<Monitor[]> {
    const out: Monitor[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const json = await call(ctx, "DescribeSiteMonitorList", {
        Page: String(page),
        PageSize: String(PAGE),
      });
      const holder = isRecord(json.SiteMonitors) ? json.SiteMonitors : {};
      const list = asArray(holder.SiteMonitor).filter(isRecord);
      for (const m of list)
        out.push({ id: str(m.TaskId), name: str(m.TaskName), target: str(m.Address) });
      if (list.length < PAGE || out.length >= Number(json.TotalCount ?? 0)) break;
    }
    return out;
  },
  async poll(ctx): Promise<Observation[]> {
    const ids = ctx.monitorIds.filter((id) => /^[\w-]{1,64}$/.test(id));
    const out: Observation[] = [];
    const end = ctx.now.getTime();
    for (let i = 0; i < ids.length; i += TASKS_PER_LOG) {
      const json = await call(ctx, "DescribeSiteMonitorLog", {
        TaskIds: ids.slice(i, i + TASKS_PER_LOG).join(","),
        MetricName: "ProbeLog",
        StartTime: String(end - 600_000),
        EndTime: String(end),
        Length: "1440",
      });
      let logs: unknown = json.Data;
      if (typeof logs === "string") {
        try {
          logs = JSON.parse(logs);
        } catch {
          throw new ProbeSourceError("bad_response");
        }
      }
      const newest = new Map<string, Record<string, unknown>>();
      for (const log of asArray(logs).filter(isRecord)) {
        const location = [str(log.cityEN) || str(log.city), str(log.ispEN) || str(log.isp)]
          .filter(Boolean)
          .join("/")
          .slice(0, 64);
        const key = `${str(log.taskId)}\n${location}`;
        const prev = newest.get(key);
        if (
          !prev ||
          (dateOf(log.timestamp)?.getTime() ?? 0) > (dateOf(prev.timestamp)?.getTime() ?? 0)
        )
          newest.set(key, { ...log, location });
      }
      for (const log of newest.values()) {
        const up = upOf(log);
        out.push({
          monitorId: str(log.taskId),
          location: str(log.location),
          up,
          rttMs: up ? millis(log.TotalTime) : null,
          lossPercent: null,
          error: up ? "" : errorCode(str(log.errorCode) || `http_${str(log.HTTPResponseCode)}`),
          checkedAt: dateOf(log.timestamp),
        });
      }
    }
    return out;
  },
};
