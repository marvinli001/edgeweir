import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { type AlertEventKind, alertChannelConfig, smtpInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import nodemailer from "nodemailer";
import { m } from "../../web/paraglide/messages.js";
import type { AppContext } from "../lib/context";
import { outboundAddress, postNotification, withinDeadline } from "../lib/outbound";

export const SMTP_KEY = "notification_smtp";
export const smtpBinding = { purpose: "system_setting.notification_smtp", recordId: SMTP_KEY };
export const channelBinding = (id: string) => ({
  purpose: "alert_channel.config_envelope",
  recordId: id,
});
/** An email channel delivers nothing until the SMTP settings are saved. */
export class SmtpNotConfiguredError extends Error {
  constructor() {
    super("SMTP not configured");
  }
}
export type Notification = {
  id: string;
  siteId: string | null;
  siteName: string;
  kind: AlertEventKind | "test";
  status: "firing" | "resolved";
  occurredAt: string;
  resourceId?: string;
};
export async function loadSmtp(app: AppContext) {
  const [row] = await app.db
    .select()
    .from(schema.systemSetting)
    .where(eq(schema.systemSetting.key, SMTP_KEY));
  if (!row) return null;
  return smtpInput.parse(
    JSON.parse(
      app.masterKey.open(JSON.parse(String(row.value.envelope)), smtpBinding).toString("utf8"),
    ),
  );
}
export async function deliverNotification(
  app: AppContext,
  channel: typeof schema.alertChannel.$inferSelect,
  event: Notification,
) {
  const config = alertChannelConfig.parse(
    JSON.parse(
      app.masterKey
        .open(JSON.parse(channel.configEnvelope), channelBinding(channel.id))
        .toString("utf8"),
    ),
  );
  if (config.kind !== channel.kind) throw new Error("channel envelope metadata mismatch");
  const locale = channel.locale === "en" ? "en" : "zh-CN";
  const kind = {
    node_offline: m.alert_kind_node_offline,
    certificate_expiring: m.alert_kind_certificate_expiring,
    origin_unavailable: m.alert_kind_origin_unavailable,
    high_5xx: m.alert_kind_high_5xx,
    cc_mitigation: m.alert_kind_cc_mitigation,
    config_rollout_failed: m.alert_kind_config_rollout_failed,
    config_rollout_no_canary: m.alert_kind_config_rollout_no_canary,
    config_rule_invalid: m.alert_kind_config_rule_invalid,
    dns_mass_removal_blocked: m.alert_kind_dns_mass_removal_blocked,
    scheduling_action: m.alert_kind_scheduling_action,
    test: m.alert_test_message,
  }[event.kind]({}, { locale });
  const status = event.status === "resolved" ? m.alert_recovered({}, { locale }) : kind;
  const site = event.siteName.replace(/[\r\n\0]/g, " ").slice(0, 100);
  const url = new URL(
    event.siteId
      ? `/sites/${event.siteId}`
      : event.kind === "dns_mass_removal_blocked"
        ? "/dns"
        : event.kind === "test"
          ? "/alerts"
          : "/clusters",
    app.env.EDGEWEIR_PUBLIC_URL,
  ).toString();
  const text = m.alert_notice_body(
    { site, event: status, time: event.occurredAt, url },
    { locale },
  );
  if (config.kind === "email") {
    const smtp = await loadSmtp(app);
    if (!smtp?.password) throw new SmtpNotConfiguredError();
    const signal = AbortSignal.timeout(10000);
    const address = await withinDeadline(outboundAddress(app, smtp.host), signal);
    const ca = smtp.ca
      ? smtp.ca
      : app.env.EDGEWEIR_SMTP_CA_FILE
        ? await withinDeadline(readFile(app.env.EDGEWEIR_SMTP_CA_FILE), signal)
        : undefined;
    signal.throwIfAborted();
    const transport = nodemailer.createTransport({
      host: address.address,
      port: smtp.port,
      secure: smtp.secure,
      requireTLS: !smtp.secure,
      name: "edgeweir",
      auth: { user: smtp.username, pass: smtp.password },
      tls: {
        servername: isIP(address.servername) ? undefined : address.servername,
        rejectUnauthorized: true,
        ...(ca ? { ca } : {}),
      },
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    try {
      await withinDeadline(
        transport.sendMail({
          from: smtp.from,
          to: config.to,
          subject: m.alert_notice_subject({ site, event: status }, { locale }),
          text,
          messageId: `<${event.id}@${new URL(app.env.EDGEWEIR_PUBLIC_URL).hostname}>`,
        }),
        signal,
      );
    } finally {
      transport.close();
    }
    return;
  }
  if (config.kind === "webhook") {
    await postNotification(app, config.url, { ...event, text, url }, config.bearer);
    return;
  }
  if (config.kind === "telegram") {
    const response = (await postNotification(
      app,
      `https://api.telegram.org/bot${config.token}/sendMessage`,
      { chat_id: config.chatId, text, link_preview_options: { is_disabled: true } },
    )) as { ok?: boolean } | null;
    if (!response?.ok) throw new Error("Telegram rejected notification");
    return;
  }
  const target = new URL(config.url);
  if (config.kind === "dingtalk" && config.secret) {
    const timestamp = String(Date.now());
    const signature = createHmac("sha256", config.secret)
      .update(`${timestamp}\n${config.secret}`)
      .digest("base64");
    target.searchParams.set("timestamp", timestamp);
    target.searchParams.set("sign", signature);
  }
  const response = (await postNotification(app, target.toString(), {
    msgtype: "text",
    text: { content: text },
  })) as { errcode?: number } | null;
  if (response?.errcode !== 0) throw new Error("notification provider rejected message");
}
