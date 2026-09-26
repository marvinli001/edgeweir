import { randomUUID } from "node:crypto";
import {
  type AlertChannelConfig,
  type AlertChannelInput,
  type AlertKind,
  type AlertPolicy,
  alertKind,
  alertPolicy,
  type SmtpInput,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, desc, eq, lt, lte, sql } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import {
  channelBinding,
  deliverNotification,
  loadSmtp,
  SMTP_KEY,
  smtpBinding,
} from "./notification-delivery";
import type { Executor } from "./revisions";
import { findSite, type SiteScope } from "./sites";
import { isAdminRole } from "./users";

const POLICY_KEY = "alert_policy";
type Channel = typeof schema.alertChannel.$inferSelect;
type Event = typeof schema.alertEvent.$inferSelect;
const dto = (c: Channel) => ({
  id: c.id,
  name: c.name,
  kind: c.kind,
  enabled: c.enabled,
  availableToTenants: c.availableToTenants,
  platform: c.platform,
  locale: c.locale === "en" ? ("en" as const) : ("zh-CN" as const),
  lastError: c.lastError,
});
export interface AlertContext {
  scope: SiteScope;
  actor: Actor;
  userId: string;
}
async function channel(db: Executor, id: string) {
  const [row] = await db.select().from(schema.alertChannel).where(eq(schema.alertChannel.id, id));
  if (!row) fail("ALERT_CHANNEL_NOT_FOUND", "alert channel not found");
  return row;
}
export async function listAlertChannels(app: AppContext) {
  return (await app.db.select().from(schema.alertChannel).orderBy(schema.alertChannel.name)).map(
    dto,
  );
}
export async function createAlertChannel(app: AppContext, input: AlertChannelInput, actor: Actor) {
  return app.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('edgeweir.alert-channels'))`);
    const count = await tx.select({ id: schema.alertChannel.id }).from(schema.alertChannel);
    if (count.length >= 32) fail("ALERT_CHANNEL_LIMIT", "channel limit reached");
    const id = randomUUID(),
      configEnvelope = JSON.stringify(
        app.masterKey.seal(JSON.stringify(input.config), channelBinding(id)),
      );
    const [row] = await tx
      .insert(schema.alertChannel)
      .values({
        id,
        name: input.name,
        kind: input.config.kind,
        enabled: input.enabled,
        availableToTenants: input.availableToTenants,
        platform: input.platform,
        locale: input.locale,
        configEnvelope,
      })
      .returning();
    if (!row) throw new Error("channel insert failed");
    await recordAudit(tx, actor, {
      action: "alert.channel_create",
      targetType: "alert_channel",
      targetId: id,
      targetName: row.name,
      metadata: {
        kind: row.kind,
        platform: row.platform,
        availableToTenants: row.availableToTenants,
      },
    });
    return dto(row);
  });
}
export async function updateAlertChannel(
  app: AppContext,
  input: {
    id: string;
    name?: string;
    enabled?: boolean;
    availableToTenants?: boolean;
    platform?: boolean;
    locale?: "en" | "zh-CN";
    config?: AlertChannelConfig;
  },
  actor: Actor,
) {
  return app.db.transaction(async (tx) => {
    const before = await channel(tx, input.id);
    const { id, config, ...fields } = input;
    const [row] = await tx
      .update(schema.alertChannel)
      .set({
        ...fields,
        ...(config
          ? {
              kind: config.kind,
              configEnvelope: JSON.stringify(
                app.masterKey.seal(JSON.stringify(config), channelBinding(id)),
              ),
              lastError: "",
            }
          : {}),
      })
      .where(eq(schema.alertChannel.id, id))
      .returning();
    if (!row) throw new Error("channel update failed");
    if (config)
      await tx
        .update(schema.alertDelivery)
        .set({ status: "pending", attempts: 0, nextAttemptAt: new Date() })
        .where(
          and(eq(schema.alertDelivery.channelId, id), eq(schema.alertDelivery.status, "failed")),
        );
    await recordAudit(tx, actor, {
      action: "alert.channel_update",
      targetType: "alert_channel",
      targetId: id,
      targetName: row.name,
      metadata: { credentialsRotated: !!config, previousKind: before.kind },
    });
    return dto(row);
  });
}
export async function deleteAlertChannel(app: AppContext, id: string, actor: Actor) {
  return app.db.transaction(async (tx) => {
    const row = await channel(tx, id);
    await tx.delete(schema.alertChannel).where(eq(schema.alertChannel.id, id));
    await recordAudit(tx, actor, {
      action: "alert.channel_delete",
      targetType: "alert_channel",
      targetId: id,
      targetName: row.name,
    });
    return { ok: true as const };
  });
}
export async function testAlertChannel(app: AppContext, id: string, actor: Actor) {
  const row = await channel(app.db, id);
  await recordAudit(app.db, actor, {
    action: "alert.channel_test_request",
    targetType: "alert_channel",
    targetId: id,
    targetName: row.name,
  });
  try {
    await deliverNotification(app, row, {
      id: randomUUID(),
      siteId: null,
      siteName: "Edgeweir",
      kind: "test",
      status: "firing",
      occurredAt: new Date().toISOString(),
    });
  } catch {
    fail("ALERT_SEND_FAILED", "notification test failed");
  }
  await recordAudit(app.db, actor, {
    action: "alert.channel_test",
    targetType: "alert_channel",
    targetId: id,
    targetName: row.name,
  });
  return { ok: true as const };
}
export async function getAlertPolicy(app: AppContext): Promise<AlertPolicy> {
  const [row] = await app.db
    .select()
    .from(schema.systemSetting)
    .where(eq(schema.systemSetting.key, POLICY_KEY));
  return alertPolicy.parse(row?.value ?? {});
}
export async function setAlertPolicy(app: AppContext, input: AlertPolicy, actor: Actor) {
  return app.db.transaction(async (tx) => {
    await tx
      .insert(schema.systemSetting)
      .values({ key: POLICY_KEY, value: input })
      .onConflictDoUpdate({ target: schema.systemSetting.key, set: { value: input } });
    await recordAudit(tx, actor, {
      action: "alert.policy_update",
      targetType: "system_setting",
      targetId: POLICY_KEY,
      metadata: input,
    });
    return input;
  });
}
export async function getSmtpConfig(app: AppContext) {
  const config = await loadSmtp(app);
  if (!config) return null;
  const { password: _password, ...safe } = config;
  return safe;
}
export async function setSmtpConfig(app: AppContext, input: SmtpInput, actor: Actor) {
  const old = await loadSmtp(app);
  if (
    !input.password &&
    (!old?.password ||
      old.host !== input.host ||
      old.port !== input.port ||
      old.secure !== input.secure ||
      old.username !== input.username)
  )
    fail("SMTP_PASSWORD_REQUIRED", "supply a new password when changing SMTP destination");
  const config = { ...input, password: input.password ?? old?.password };
  const value = {
    envelope: JSON.stringify(app.masterKey.seal(JSON.stringify(config), smtpBinding)),
  };
  return app.db.transaction(async (tx) => {
    await tx
      .insert(schema.systemSetting)
      .values({ key: SMTP_KEY, value })
      .onConflictDoUpdate({ target: schema.systemSetting.key, set: { value } });
    await recordAudit(tx, actor, {
      action: "alert.smtp_update",
      targetType: "system_setting",
      targetId: SMTP_KEY,
      metadata: { host: input.host, credentialsRotated: !!input.password },
    });
    return { ok: true as const };
  });
}
export async function availableAlertChannels(app: AppContext, scope: SiteScope) {
  return (
    await app.db
      .select()
      .from(schema.alertChannel)
      .where(
        and(
          eq(schema.alertChannel.enabled, true),
          scope.all ? undefined : eq(schema.alertChannel.availableToTenants, true),
        ),
      )
      .orderBy(schema.alertChannel.name)
  ).map((c) => ({ id: c.id, name: c.name, kind: c.kind }));
}
export async function listAlertSubscriptions(app: AppContext, ctx: AlertContext) {
  const rows = await app.db
    .select({
      sub: schema.alertSubscription,
      siteName: schema.site.name,
      channelName: schema.alertChannel.name,
    })
    .from(schema.alertSubscription)
    .innerJoin(schema.site, eq(schema.site.id, schema.alertSubscription.siteId))
    .innerJoin(schema.alertChannel, eq(schema.alertChannel.id, schema.alertSubscription.channelId))
    .where(
      and(
        eq(schema.alertSubscription.userId, ctx.userId),
        ctx.scope.all ? undefined : eq(schema.site.organizationId, ctx.scope.organizationId),
      ),
    );
  return rows.map(({ sub, siteName, channelName }) => ({
    id: sub.id,
    siteId: sub.siteId,
    channelId: sub.channelId,
    kinds: sub.kinds.map((k) => alertKind.parse(k)),
    enabled: sub.enabled,
    siteName,
    channelName,
  }));
}
export async function subscribeAlerts(
  app: AppContext,
  input: { siteId: string; channelId: string; kinds: AlertKind[]; enabled: boolean },
  ctx: AlertContext,
) {
  return app.db.transaction(async (tx) => {
    const site = await findSite(tx, input.siteId, ctx.scope);
    const c = await channel(tx, input.channelId);
    if (!c.enabled || (!ctx.scope.all && !c.availableToTenants))
      fail("ALERT_CHANNEL_NOT_FOUND", "channel is unavailable");
    const [sub] = await tx
      .insert(schema.alertSubscription)
      .values({
        ...input,
        kinds: [...new Set(input.kinds)],
        userId: ctx.userId,
        organizationId: site.organizationId,
      })
      .onConflictDoUpdate({
        target: [
          schema.alertSubscription.userId,
          schema.alertSubscription.siteId,
          schema.alertSubscription.channelId,
        ],
        set: { kinds: [...new Set(input.kinds)], enabled: input.enabled },
      })
      .returning();
    if (!sub) throw new Error("subscription insert failed");
    await recordAudit(tx, ctx.actor, {
      action: "alert.subscribe",
      organizationId: site.organizationId,
      targetType: "site",
      targetId: site.id,
      targetName: site.name,
      metadata: { channelId: c.id, kinds: input.kinds },
    });
    return {
      id: sub.id,
      siteId: site.id,
      siteName: site.name,
      channelId: c.id,
      channelName: c.name,
      kinds: input.kinds,
      enabled: sub.enabled,
    };
  });
}
export async function unsubscribeAlerts(app: AppContext, id: string, ctx: AlertContext) {
  return app.db.transaction(async (tx) => {
    const [sub] = await tx
      .select()
      .from(schema.alertSubscription)
      .where(
        and(eq(schema.alertSubscription.id, id), eq(schema.alertSubscription.userId, ctx.userId)),
      );
    if (!sub) fail("ALERT_SUBSCRIPTION_NOT_FOUND", "subscription not found");
    await findSite(tx, sub.siteId, ctx.scope);
    await tx.delete(schema.alertSubscription).where(eq(schema.alertSubscription.id, id));
    await recordAudit(tx, ctx.actor, {
      action: "alert.unsubscribe",
      organizationId: sub.organizationId,
      targetType: "alert_subscription",
      targetId: id,
    });
    return { ok: true as const };
  });
}
export async function listAlertEvents(app: AppContext, scope: SiteScope, siteId?: string) {
  if (siteId) await findSite(app.db, siteId, scope);
  const rows = await app.db
    .select({ event: schema.alertEvent, siteName: schema.site.name })
    .from(schema.alertEvent)
    .innerJoin(schema.site, eq(schema.site.id, schema.alertEvent.siteId))
    .where(
      and(
        scope.all ? undefined : eq(schema.site.organizationId, scope.organizationId),
        siteId ? eq(schema.site.id, siteId) : undefined,
      ),
    )
    .orderBy(desc(schema.alertEvent.occurredAt), desc(schema.alertEvent.ordinal))
    .limit(100);
  return rows.map(({ event, siteName }) => ({
    id: event.id,
    siteId: event.siteId,
    kind: alertKind.parse(event.kind),
    status: event.status === "resolved" ? ("resolved" as const) : ("firing" as const),
    occurredAt: event.occurredAt.toISOString(),
    siteName,
  }));
}

const keyOf = (kind: string, siteId: string, resourceId: string) =>
  `${kind}/${siteId}/${resourceId}`;
interface Condition {
  siteId: string;
  kind: AlertKind;
  resourceId: string;
  siteName: string;
  domain: string;
}
async function conditions(app: AppContext, policy: AlertPolicy, now: number) {
  const sites = await app.db
    .selectDistinct({
      id: schema.site.id,
      name: schema.site.name,
      clusterId: schema.site.clusterId,
      certificateId: schema.site.certificateId,
    })
    .from(schema.site)
    .innerJoin(schema.siteDomain, eq(schema.siteDomain.siteId, schema.site.id))
    .where(and(eq(schema.site.enabled, true), eq(schema.siteDomain.verified, true)));
  const nodes = await app.db.select().from(schema.node),
    receipts = await app.db.select().from(schema.nodeConfigStatus),
    certificates = await app.db.select().from(schema.certificate),
    domains = await app.db.select().from(schema.siteDomain);
  const health = await app.db.select().from(schema.originHealth);
  const origins = await app.db
    .select({ id: schema.origin.id, siteId: schema.originPool.siteId })
    .from(schema.origin)
    .innerJoin(schema.originPool, eq(schema.originPool.id, schema.origin.poolId));
  const traffic = await app.db.execute<{
    site_id: string;
    requests: string | number;
    errors: string | number;
  }>(
    sql`select site_id,sum(requests) as requests,sum((select coalesce(sum(value::bigint),0) from jsonb_each_text(status_codes) where key like '5%')) as errors from node_minute_stats where minute>=${new Date(now - policy.windowMinutes * 60000).toISOString()}::timestamptz and minute<=${new Date(now).toISOString()}::timestamptz group by site_id`,
  );
  const active = new Map<string, Condition>();
  for (const site of sites) {
    const base = {
      siteId: site.id,
      siteName: site.name,
      domain: domains.find((d) => d.siteId === site.id && d.verified)?.name ?? "",
    };
    const add = (kind: AlertKind, resourceId: string) =>
      active.set(keyOf(kind, site.id, resourceId), { ...base, kind, resourceId });
    const members = nodes.filter(
      (n) =>
        n.clusterId === site.clusterId &&
        n.status === "active" &&
        n.enrolledAt &&
        n.enrolledAt.getTime() <= now - policy.nodeOfflineSeconds * 1000,
    );
    for (const node of members) {
      const receipt = receipts.find((r) => r.nodeId === node.id);
      if (
        !node.lastSeenAt ||
        node.lastSeenAt.getTime() < now - policy.nodeOfflineSeconds * 1000 ||
        receipt?.dataPlaneHealthy === false
      )
        add("node_offline", node.id);
    }
    const cert = certificates.find((c) => c.id === site.certificateId);
    if (cert?.notAfter && cert.notAfter.getTime() <= now + policy.certificateHours * 3600000)
      add("certificate_expiring", cert.id);
    const originIds = origins.filter((o) => o.siteId === site.id).map((o) => o.id);
    if (
      originIds.length &&
      members.some((n) =>
        originIds.every((id) =>
          health.some(
            (h) =>
              h.nodeId === n.id &&
              h.originId === id &&
              !h.healthy &&
              h.reportedAt.getTime() > now - policy.nodeOfflineSeconds * 1000,
          ),
        ),
      )
    )
      add("origin_unavailable", site.id);
    const metric = traffic.rows.find((r) => r.site_id === site.id);
    if (
      metric &&
      Number(metric.requests) >= policy.minimumRequests &&
      Number(metric.errors) / Number(metric.requests) >= policy.errorRatio
    )
      add("high_5xx", site.id);
  }
  return { active, sites };
}
/** Recheck memberships, bans, MFA and channel visibility at delivery, not only at subscription. */
async function eligible(app: AppContext, c: Channel, event: Event) {
  if (!c.enabled) return false;
  if (c.platform) return true;
  const rows = await app.db
    .select({
      sub: schema.alertSubscription,
      user: schema.user,
      memberId: schema.member.id,
      requireTwoFactor: schema.organizationSettings.requireTwoFactor,
    })
    .from(schema.alertSubscription)
    .innerJoin(schema.user, eq(schema.user.id, schema.alertSubscription.userId))
    .leftJoin(
      schema.member,
      and(
        eq(schema.member.userId, schema.user.id),
        eq(schema.member.organizationId, schema.alertSubscription.organizationId),
      ),
    )
    .leftJoin(
      schema.organizationSettings,
      eq(schema.organizationSettings.organizationId, schema.alertSubscription.organizationId),
    )
    .where(
      and(
        eq(schema.alertSubscription.siteId, event.siteId),
        eq(schema.alertSubscription.channelId, c.id),
        eq(schema.alertSubscription.enabled, true),
      ),
    );
  return rows.some((r) => {
    const admin = isAdminRole(r.user.role),
      banned = r.user.banned && (!r.user.banExpires || r.user.banExpires.getTime() > Date.now());
    return (
      !banned &&
      r.sub.kinds.includes(event.kind) &&
      (admin ||
        (!!r.memberId && c.availableToTenants && (!r.requireTwoFactor || r.user.twoFactorEnabled)))
    );
  });
}
export async function sweepAlerts(app: AppContext, now = Date.now()) {
  const connection = await app.pool.connect();
  let locked = false;
  try {
    const result = await connection.query("select pg_try_advisory_lock(550075, 6) as locked");
    locked = result.rows[0]?.locked === true;
    if (!locked) return;
    const policy = await getAlertPolicy(app),
      snapshot = await conditions(app, policy, now);
    await app.db.transaction(async (tx) => {
      const previous = await tx.select().from(schema.alertState);
      for (const [key, c] of snapshot.active) {
        if (previous.find((s) => s.key === key)?.active) continue;
        await tx
          .insert(schema.alertState)
          .values({
            key,
            siteId: c.siteId,
            kind: c.kind,
            resourceId: c.resourceId,
            active: true,
            updatedAt: new Date(now),
          })
          .onConflictDoUpdate({
            target: schema.alertState.key,
            set: { active: true, updatedAt: new Date(now) },
          });
        await tx.insert(schema.alertEvent).values({
          siteId: c.siteId,
          kind: c.kind,
          resourceId: c.resourceId,
          status: "firing",
          payload: { siteName: c.siteName, domain: c.domain },
          occurredAt: new Date(now),
        });
      }
      for (const old of previous.filter((s) => s.active && !snapshot.active.has(s.key))) {
        await tx
          .update(schema.alertState)
          .set({ active: false, updatedAt: new Date(now) })
          .where(eq(schema.alertState.key, old.key));
        const site = snapshot.sites.find((s) => s.id === old.siteId);
        if (site)
          await tx.insert(schema.alertEvent).values({
            siteId: site.id,
            kind: old.kind,
            resourceId: old.resourceId,
            status: "resolved",
            payload: { siteName: site.name, domain: "" },
            occurredAt: new Date(now),
          });
      }
    });
    const latest = await app.db
      .selectDistinctOn([
        schema.alertEvent.siteId,
        schema.alertEvent.kind,
        schema.alertEvent.resourceId,
      ])
      .from(schema.alertEvent)
      .orderBy(
        schema.alertEvent.siteId,
        schema.alertEvent.kind,
        schema.alertEvent.resourceId,
        desc(schema.alertEvent.ordinal),
      );
    const currentStates = await app.db.select().from(schema.alertState);
    const currentEvent = (event: Event) =>
      currentStates.some(
        (s) =>
          s.key === keyOf(event.kind, event.siteId, event.resourceId) &&
          s.active === (event.status === "firing"),
      );
    const channels = await app.db
      .select()
      .from(schema.alertChannel)
      .where(eq(schema.alertChannel.enabled, true));
    for (const event of latest) {
      if (!currentEvent(event) || event.occurredAt.getTime() < now - 86400000) continue;
      for (const c of channels)
        if (await eligible(app, c, event))
          await app.db
            .insert(schema.alertDelivery)
            .values({ eventId: event.id, channelId: c.id, nextAttemptAt: new Date(now) })
            .onConflictDoUpdate({
              target: [schema.alertDelivery.eventId, schema.alertDelivery.channelId],
              set: { status: "pending", nextAttemptAt: new Date(now) },
              setWhere: eq(schema.alertDelivery.status, "cancelled"),
            });
    }
    const pending = await app.db
      .select()
      .from(schema.alertDelivery)
      .where(
        and(
          eq(schema.alertDelivery.status, "pending"),
          lte(schema.alertDelivery.nextAttemptAt, new Date(now)),
        ),
      )
      .orderBy(schema.alertDelivery.nextAttemptAt)
      .limit(20);
    for (const delivery of pending) {
      const [c] = await app.db
        .select()
        .from(schema.alertChannel)
        .where(eq(schema.alertChannel.id, delivery.channelId));
      const event = latest.find((e) => e.id === delivery.eventId);
      if (!c || !event || !currentEvent(event) || !(await eligible(app, c, event))) {
        await app.db
          .update(schema.alertDelivery)
          .set({ status: "cancelled" })
          .where(eq(schema.alertDelivery.id, delivery.id));
        continue;
      }
      try {
        await deliverNotification(app, c, {
          id: event.id,
          siteId: event.siteId,
          siteName: event.payload.siteName,
          kind: alertKind.parse(event.kind),
          status: event.status === "resolved" ? "resolved" : "firing",
          occurredAt: event.occurredAt.toISOString(),
          resourceId: event.resourceId,
        });
        await app.db
          .update(schema.alertDelivery)
          .set({
            status: "sent",
            sentAt: new Date(now),
            attempts: delivery.attempts + 1,
            lastError: "",
          })
          .where(eq(schema.alertDelivery.id, delivery.id));
        await app.db
          .update(schema.alertChannel)
          .set({ lastError: "" })
          .where(eq(schema.alertChannel.id, c.id));
      } catch {
        const attempts = delivery.attempts + 1;
        await app.db
          .update(schema.alertDelivery)
          .set({
            status: attempts >= 5 ? "failed" : "pending",
            attempts,
            nextAttemptAt: new Date(now + Math.min(3600000, 60000 * 2 ** attempts)),
            lastError: "alert_send_failed",
          })
          .where(eq(schema.alertDelivery.id, delivery.id));
        await app.db
          .update(schema.alertChannel)
          .set({ lastError: "alert_send_failed" })
          .where(eq(schema.alertChannel.id, c.id));
        app.log.warn("notification delivery failed", { channelId: c.id, eventId: event.id });
      }
    }
    await app.db
      .delete(schema.alertEvent)
      .where(lt(schema.alertEvent.occurredAt, new Date(now - 90 * 86400000)));
    await app.db
      .delete(schema.alertState)
      .where(
        and(
          eq(schema.alertState.active, false),
          lt(schema.alertState.updatedAt, new Date(now - 90 * 86400000)),
        ),
      );
  } finally {
    if (locked) await connection.query("select pg_advisory_unlock(550075, 6)");
    connection.release();
  }
}
