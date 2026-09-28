import { oc } from "@orpc/contract";
import * as z from "zod";
import { uuid } from "./schemas";
export const alertKind = z.enum([
  "node_offline",
  "certificate_expiring",
  "origin_unavailable",
  "high_5xx",
]);
const endpoint = z
  .url()
  .max(4096)
  .refine((s) => {
    const u = new URL(s);
    return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !u.hash;
  });
export const alertChannelConfig = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("webhook"), url: endpoint, bearer: z.string().max(4096).optional() }),
  z.object({ kind: z.literal("email"), to: z.array(z.email()).min(1).max(20) }),
  z.object({
    kind: z.literal("dingtalk"),
    url: endpoint.refine((s) => new URL(s).hostname === "oapi.dingtalk.com"),
    secret: z.string().max(4096).optional(),
  }),
  z.object({
    kind: z.literal("wecom"),
    url: endpoint.refine((s) => new URL(s).hostname === "qyapi.weixin.qq.com"),
  }),
  z.object({
    kind: z.literal("telegram"),
    token: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,200}$/),
    chatId: z.string().regex(/^-?\d{1,24}$|^@[A-Za-z][A-Za-z0-9_]{4,31}$/),
  }),
]);
export const alertChannelInput = z.object({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  availableToTenants: z.boolean().default(false),
  platform: z.boolean().default(false),
  locale: z.enum(["zh-CN", "en"]).default("zh-CN"),
  config: alertChannelConfig,
});
const channel = z.object({
  id: uuid,
  name: z.string(),
  kind: z.string(),
  enabled: z.boolean(),
  availableToTenants: z.boolean(),
  platform: z.boolean(),
  locale: z.enum(["zh-CN", "en"]),
  lastError: z.string(),
});
export const alertPolicy = z.object({
  nodeOfflineSeconds: z.number().int().min(45).max(3600).default(90),
  certificateHours: z.number().int().min(1).max(720).default(72),
  errorRatio: z.number().min(0.01).max(1).default(0.2),
  minimumRequests: z.number().int().min(1).max(1000000).default(100),
  windowMinutes: z.number().int().min(1).max(60).default(5),
});
export const smtpInput = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(465),
  secure: z.boolean().default(true),
  from: z.email(),
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(4096).optional(),
  /** PEM certificates that replace the system trust store for this server's TLS. */
  ca: z.string().trim().max(65536).default(""),
});
const subscription = z.object({
  id: uuid,
  siteId: uuid,
  siteName: z.string(),
  channelId: uuid,
  channelName: z.string(),
  kinds: z.array(alertKind),
  enabled: z.boolean(),
});
export const alertsContract = {
  channels: oc
    .route({ method: "GET", path: "/alerts/channels", tags: ["alerts"] })
    .output(z.array(channel)),
  createChannel: oc
    .route({ method: "POST", path: "/alerts/channels", tags: ["alerts"] })
    .input(alertChannelInput)
    .output(channel),
  updateChannel: oc
    .route({ method: "PUT", path: "/alerts/channels/{id}", tags: ["alerts"] })
    .input(
      z.object({
        id: uuid,
        name: z.string().trim().min(1).max(100).optional(),
        enabled: z.boolean().optional(),
        availableToTenants: z.boolean().optional(),
        platform: z.boolean().optional(),
        locale: z.enum(["zh-CN", "en"]).optional(),
        config: alertChannelConfig.optional(),
      }),
    )
    .output(channel),
  deleteChannel: oc
    .route({ method: "DELETE", path: "/alerts/channels/{id}", tags: ["alerts"] })
    .input(z.object({ id: uuid }))
    .output(z.object({ ok: z.literal(true) })),
  testChannel: oc
    .route({ method: "POST", path: "/alerts/channels/{id}/test", tags: ["alerts"] })
    .input(z.object({ id: uuid }))
    .output(z.object({ ok: z.literal(true) })),
  policy: oc.route({ method: "GET", path: "/alerts/policy", tags: ["alerts"] }).output(alertPolicy),
  setPolicy: oc
    .route({ method: "PUT", path: "/alerts/policy", tags: ["alerts"] })
    .input(alertPolicy)
    .output(alertPolicy),
  smtp: oc.route({ method: "GET", path: "/alerts/smtp", tags: ["alerts"] }).output(
    smtpInput
      .omit({ password: true })
      .extend({ caFile: z.boolean().describe("EDGEWEIR_SMTP_CA_FILE is set") })
      .nullable(),
  ),
  setSmtp: oc
    .route({ method: "PUT", path: "/alerts/smtp", tags: ["alerts"] })
    .input(smtpInput)
    .output(z.object({ ok: z.literal(true) })),
  availableChannels: oc
    .route({ method: "GET", path: "/alerts/available-channels", tags: ["alerts"] })
    .output(z.array(channel.pick({ id: true, name: true, kind: true }))),
  subscriptions: oc
    .route({ method: "GET", path: "/alerts/subscriptions", tags: ["alerts"] })
    .output(z.array(subscription)),
  subscribe: oc
    .route({ method: "POST", path: "/alerts/subscriptions", tags: ["alerts"] })
    .input(
      z.object({
        siteId: uuid,
        channelId: uuid,
        kinds: z.array(alertKind).min(1).max(4),
        enabled: z.boolean().default(true),
      }),
    )
    .output(subscription),
  unsubscribe: oc
    .route({ method: "DELETE", path: "/alerts/subscriptions/{id}", tags: ["alerts"] })
    .input(z.object({ id: uuid }))
    .output(z.object({ ok: z.literal(true) })),
  events: oc
    .route({ method: "GET", path: "/alerts/events", tags: ["alerts"] })
    .input(z.object({ siteId: uuid.optional() }))
    .output(
      z.array(
        z.object({
          id: uuid,
          siteId: uuid,
          kind: alertKind,
          status: z.enum(["firing", "resolved"]),
          occurredAt: z.string(),
          siteName: z.string(),
        }),
      ),
    ),
};
export type AlertKind = z.infer<typeof alertKind>;
export type AlertPolicy = z.infer<typeof alertPolicy>;
export type AlertChannelInput = z.infer<typeof alertChannelInput>;
export type AlertChannelConfig = z.infer<typeof alertChannelConfig>;
export type SmtpInput = z.infer<typeof smtpInput>;
