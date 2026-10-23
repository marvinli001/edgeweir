import { createHash, createHmac, randomUUID } from "node:crypto";
import type { AlertChannelConfig } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { outboundPost } from "../lib/outbound";

export type SmsConfig = Extract<AlertChannelConfig, { kind: "aliyun_sms" | "tencent_sms" }>;
/** Template variables: Aliyun ${site} ${alert} ${status}, Tencent {1} {2} {3}. */
export type SmsParams = { site: string; alert: string; status: string };

const HOUR = 3600_000,
  DAY = 24 * HOUR;
const ALIYUN_HOST = "dysmsapi.aliyuncs.com";
const TENCENT_HOST = "sms.tencentcloudapi.com";

/** The channel used up its hourly or daily sends; the message waits until retryAt. */
export class SmsRateLimitedError extends Error {
  constructor(readonly retryAt: Date) {
    super("SMS channel send limit reached");
  }
}
/**
 * The provider refused the message. `code` is its error code; `reason` is
 * "limited" for its own frequency controls and "url" when a variable looked
 * like a link.
 */
export class SmsRejectedError extends Error {
  constructor(
    readonly code: string,
    readonly reason: "limited" | "url" | "other",
  ) {
    super(`SMS provider rejected message: ${code}`);
  }
}
const LIMITED =
  /^(isv\.(BUSINESS|DAY|MONTH)_LIMIT_CONTROL|Throttling(\..+)?|LimitExceeded\..+|RequestLimitExceeded(\..+)?)$/;
const URL_REFUSED =
  /^(isv\.PARAM_NOT_SUPPORT_URL|InvalidParameterValue\.ProhibitedUseUrlInTemplateParameter)$/;
function rejected(code: unknown, status: number) {
  const clean =
    (typeof code === "string" ? code.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) : "") ||
    `http_${status}`;
  return new SmsRejectedError(
    clean,
    LIMITED.test(clean) ? "limited" : URL_REFUSED.test(clean) ? "url" : "other",
  );
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
/** RFC 3986: only A-Z a-z 0-9 - _ . ~ stay as they are. */
const percent = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * Alibaba Cloud signature V3 (ACS3-HMAC-SHA256). `headers` are lower-case and
 * include host and the x-acs-* headers (x-acs-content-sha256 among them); host,
 * content-type and x-acs-* are signed. Returns the canonical query string the
 * request must use and the Authorization header.
 */
export function acs3Sign(input: {
  method: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  accessKeyId: string;
  accessKeySecret: string;
}) {
  const query = Object.keys(input.query)
    .sort()
    .map((key) => `${percent(key)}=${percent(input.query[key] ?? "")}`)
    .join("&");
  const signed = Object.keys(input.headers)
    .filter((name) => name === "host" || name === "content-type" || name.startsWith("x-acs-"))
    .sort();
  const canonical = [
    input.method,
    "/",
    query,
    signed.map((name) => `${name}:${input.headers[name]?.trim()}\n`).join(""),
    signed.join(";"),
    input.headers["x-acs-content-sha256"] ?? "",
  ].join("\n");
  const signature = createHmac("sha256", input.accessKeySecret)
    .update(`ACS3-HMAC-SHA256\n${sha256(canonical)}`)
    .digest("hex");
  return {
    query,
    canonical,
    authorization: `ACS3-HMAC-SHA256 Credential=${input.accessKeyId},SignedHeaders=${signed.join(";")},Signature=${signature}`,
  };
}

/**
 * Tencent Cloud signature v3 (TC3-HMAC-SHA256) of a POST to "/" without a
 * query. `headers` are the signed ones (lower-case names; content-type and
 * host at least); their values are lower-cased as the canonical form wants.
 */
export function tc3Sign(input: {
  secretId: string;
  secretKey: string;
  service: string;
  timestamp: number;
  headers: Record<string, string>;
  payload: string;
}) {
  const names = Object.keys(input.headers).sort();
  const canonical = [
    "POST",
    "/",
    "",
    names.map((name) => `${name}:${input.headers[name]?.trim().toLowerCase()}\n`).join(""),
    names.join(";"),
    sha256(input.payload),
  ].join("\n");
  const date = new Date(input.timestamp * 1000).toISOString().slice(0, 10);
  const scope = `${date}/${input.service}/tc3_request`;
  const hmac = (key: string | Buffer, data: string) =>
    createHmac("sha256", key).update(data).digest();
  const key = hmac(hmac(hmac(`TC3${input.secretKey}`, date), input.service), "tc3_request");
  const signature = createHmac("sha256", key)
    .update(`TC3-HMAC-SHA256\n${input.timestamp}\n${scope}\n${sha256(canonical)}`)
    .digest("hex");
  return {
    canonical,
    authorization: `TC3-HMAC-SHA256 Credential=${input.secretId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`,
  };
}

/**
 * A template variable: no links, brackets, control characters or emoji
 * (providers refuse them), at most `max` characters, never empty.
 */
export function smsParam(value: string, max: number) {
  const clean = value
    .replace(/[a-z][a-z0-9+.-]*:\/\//gi, "")
    .replace(/[\p{Cc}\p{Cf}\p{Extended_Pictographic}【】[\]{}<>$\\]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(clean).slice(0, max).join("").trim() || "-";
}

function json(body: Buffer): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(body.toString());
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function sendAliyun(
  app: AppContext,
  config: Extract<SmsConfig, { kind: "aliyun_sms" }>,
  params: SmsParams,
) {
  const headers = {
    host: ALIYUN_HOST,
    "x-acs-action": "SendSms",
    "x-acs-version": "2017-05-25",
    "x-acs-date": new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    "x-acs-signature-nonce": randomUUID().replaceAll("-", ""),
    "x-acs-content-sha256": sha256(""),
  };
  const { query, authorization } = acs3Sign({
    method: "POST",
    query: {
      PhoneNumbers: config.phoneNumbers.join(","),
      SignName: config.signName,
      TemplateCode: config.templateCode,
      TemplateParam: JSON.stringify(params),
    },
    headers,
    accessKeyId: config.accessKeyId,
    accessKeySecret: config.accessKeySecret,
  });
  const response = await outboundPost(app, `https://${ALIYUN_HOST}/?${query}`, Buffer.alloc(0), {
    ...headers,
    authorization,
  });
  const reply = json(response.body);
  if (response.status >= 200 && response.status < 300 && reply?.Code === "OK") return;
  throw rejected(reply?.Code, response.status);
}

async function sendTencent(
  app: AppContext,
  config: Extract<SmsConfig, { kind: "tencent_sms" }>,
  params: SmsParams,
) {
  const payload = JSON.stringify({
    PhoneNumberSet: config.phoneNumbers,
    SmsSdkAppId: config.sdkAppId,
    SignName: config.signName,
    TemplateId: config.templateId,
    TemplateParamSet: [params.site, params.alert, params.status],
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = {
    "content-type": "application/json; charset=utf-8",
    host: TENCENT_HOST,
    "x-tc-action": "SendSms",
  };
  const { authorization } = tc3Sign({
    secretId: config.secretId,
    secretKey: config.secretKey,
    service: "sms",
    timestamp,
    headers,
    payload,
  });
  const response = await outboundPost(app, `https://${TENCENT_HOST}/`, Buffer.from(payload), {
    ...headers,
    "x-tc-timestamp": String(timestamp),
    "x-tc-version": "2021-01-11",
    "x-tc-region": config.region,
    authorization,
  });
  const reply = json(response.body)?.Response as
    | { Error?: { Code?: unknown }; SendStatusSet?: { Code?: unknown }[] }
    | undefined;
  const statuses = Array.isArray(reply?.SendStatusSet) ? reply.SendStatusSet : [];
  // Some numbers received it: sending again would repeat it to them.
  if (response.status === 200 && !reply?.Error && statuses.some((s) => s?.Code === "Ok")) return;
  throw rejected(
    reply?.Error?.Code ?? statuses.find((s) => s?.Code !== "Ok")?.Code,
    response.status,
  );
}

/**
 * Counts a send against the channel's sliding hour and day (tests included),
 * or throws SmsRateLimitedError with the time the next one fits.
 */
export async function reserveSmsSend(
  app: AppContext,
  channelId: string,
  limits: { hourlyLimit: number; dailyLimit: number },
  now = Date.now(),
) {
  await app.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ sendTimes: schema.alertChannel.sendTimes })
      .from(schema.alertChannel)
      .where(eq(schema.alertChannel.id, channelId))
      .for("update");
    if (!row) throw new Error("alert channel not found");
    const day = row.sendTimes
      .map((t) => new Date(t).getTime())
      .filter((t) => t > now - DAY && t <= now)
      .sort((a, b) => a - b);
    const hour = day.filter((t) => t > now - HOUR);
    // The oldest send that has to drop out of the window before the next fits.
    const blocker =
      hour.length >= limits.hourlyLimit
        ? (hour[hour.length - limits.hourlyLimit] ?? now) + HOUR
        : day.length >= limits.dailyLimit
          ? (day[day.length - limits.dailyLimit] ?? now) + DAY
          : null;
    if (blocker !== null) throw new SmsRateLimitedError(new Date(blocker));
    await tx
      .update(schema.alertChannel)
      .set({ sendTimes: [...day, now].map((t) => new Date(t)) })
      .where(eq(schema.alertChannel.id, channelId));
  });
}

/**
 * Sends one SMS through the channel's provider. A refusal because a variable
 * looked like a link (a site named like a domain) is retried once with the
 * dots of the site replaced by spaces.
 */
export async function sendSms(app: AppContext, config: SmsConfig, params: SmsParams) {
  const fitted = (p: SmsParams): SmsParams => ({
    site: smsParam(p.site, config.maxParamLength),
    alert: smsParam(p.alert, config.maxParamLength),
    status: smsParam(p.status, config.maxParamLength),
  });
  const send = (p: SmsParams) =>
    config.kind === "aliyun_sms"
      ? sendAliyun(app, config, fitted(p))
      : sendTencent(app, config, fitted(p));
  try {
    await send(params);
  } catch (error) {
    if (!(error instanceof SmsRejectedError) || error.reason !== "url") throw error;
    await send({ ...params, site: params.site.replaceAll(".", " ") });
  }
}
