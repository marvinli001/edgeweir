import { randomUUID, X509Certificate } from "node:crypto";
import {
  type AlertChannelConfig,
  type AlertChannelInput,
  type AlertKind,
  type AlertPolicy,
  alertEventKind,
  alertKind,
  alertPolicy,
  type SmtpInput,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, desc, eq, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
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
import { elevatedSites, raiseCcAlert } from "./security";
import { findSite } from "./sites";

const POLICY_KEY = "alert_policy";
/** Notifications a sweep sends at most, and for how long it keeps starting new ones. */
const DELIVERY_BATCH = 200;
const DELIVERY_BUDGET_MS = 40_000;
type Channel = typeof schema.alertChannel.$inferSelect;
type Event = typeof schema.alertEvent.$inferSelect;
const dto = (c: Channel) => ({
  id: c.id,
  name: c.name,
  kind: c.kind,
  enabled: c.enabled,
  platform: c.platform,
  locale: c.locale === "en" ? ("en" as const) : ("zh-CN" as const),
  lastError: c.lastError,
});
export interface AlertContext {
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
      metadata: { kind: row.kind, platform: row.platform },
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
  return { ...safe, caFile: !!app.env.EDGEWEIR_SMTP_CA_FILE };
}
/** Every PEM block must be a certificate; an empty bundle means the system store. */
function assertCaBundle(pem: string) {
  if (!pem) return;
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  const rest = pem.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, "");
  try {
    if (!blocks.length || rest.trim()) throw new Error("not a certificate bundle");
    for (const block of blocks) new X509Certificate(block);
  } catch {
    fail("SMTP_CA_INVALID", "the CA bundle must contain only PEM certificates");
  }
}
export async function setSmtpConfig(app: AppContext, input: SmtpInput, actor: Actor) {
  assertCaBundle(input.ca);
  const old = await loadSmtp(app);
  // A new trust anchor could hand the stored password to another server, so
  // it counts as a destination change.
  if (
    !input.password &&
    (!old?.password ||
      old.host !== input.host ||
      old.port !== input.port ||
      old.secure !== input.secure ||
      old.username !== input.username ||
      old.ca !== input.ca)
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
      metadata: { host: input.host, credentialsRotated: !!input.password, customCa: !!input.ca },
    });
    return { ok: true as const };
  });
}
type Subscription = typeof schema.alertSubscription.$inferSelect;
const knownKinds = (kinds: string[]) =>
  kinds.filter((k): k is AlertKind => alertKind.safeParse(k).success);
async function subscriptionDtos(db: Executor, subs: Subscription[]) {
  if (!subs.length) return [];
  const member = schema.alertSubscriptionSite;
  const sites = await db
    .select({ subscriptionId: member.subscriptionId, id: schema.site.id, name: schema.site.name })
    .from(member)
    .innerJoin(schema.site, eq(schema.site.id, member.siteId))
    .where(
      inArray(
        member.subscriptionId,
        subs.map((s) => s.id),
      ),
    )
    .orderBy(schema.site.name, schema.site.id);
  const channels = await db
    .select({ id: schema.alertChannel.id, name: schema.alertChannel.name })
    .from(schema.alertChannel)
    .where(
      inArray(
        schema.alertChannel.id,
        subs.map((s) => s.channelId),
      ),
    );
  return subs.map((sub) => ({
    id: sub.id,
    channelId: sub.channelId,
    channelName: channels.find((c) => c.id === sub.channelId)?.name ?? "",
    kinds: knownKinds(sub.kinds),
    enabled: sub.enabled,
    allSites: sub.allSites,
    sites: sites.filter((s) => s.subscriptionId === sub.id).map(({ id, name }) => ({ id, name })),
  }));
}
export async function listAlertSubscriptions(app: AppContext, ctx: AlertContext) {
  const rows = await app.db
    .select({ sub: schema.alertSubscription })
    .from(schema.alertSubscription)
    .innerJoin(schema.alertChannel, eq(schema.alertChannel.id, schema.alertSubscription.channelId))
    .where(eq(schema.alertSubscription.userId, ctx.userId))
    .orderBy(schema.alertChannel.name, schema.alertChannel.id);
  return subscriptionDtos(
    app.db,
    rows.map((r) => r.sub),
  );
}
interface SubscriptionFields {
  kinds: AlertKind[];
  allSites: boolean;
  siteIds: string[];
  enabled: boolean;
}
/** Points a subscription at its sites; every site listed must exist. */
async function setSubscriptionSites(tx: Executor, sub: Subscription, input: SubscriptionFields) {
  const ids = input.allSites ? [] : [...new Set(input.siteIds)];
  if (ids.length) {
    const found = await tx
      .select({ id: schema.site.id })
      .from(schema.site)
      .where(inArray(schema.site.id, ids));
    if (found.length !== ids.length) fail("SITE_NOT_FOUND", "site not found");
  }
  const member = schema.alertSubscriptionSite;
  await tx.delete(member).where(eq(member.subscriptionId, sub.id));
  if (ids.length)
    await tx.insert(member).values(ids.map((siteId) => ({ subscriptionId: sub.id, siteId })));
}
const subscriptionAudit = (sub: Subscription, input: SubscriptionFields, channelName: string) => ({
  targetType: "alert_subscription",
  targetId: sub.id,
  targetName: channelName,
  metadata: {
    channelId: sub.channelId,
    kinds: sub.kinds,
    allSites: sub.allSites,
    siteIds: sub.allSites ? [] : [...new Set(input.siteIds)],
    enabled: sub.enabled,
  },
});
/** Creates the subscription of a channel, or replaces the one it has. */
export async function subscribeAlerts(
  app: AppContext,
  input: SubscriptionFields & { channelId: string },
  ctx: AlertContext,
) {
  return app.db.transaction(async (tx) => {
    const c = await channel(tx, input.channelId);
    if (!c.enabled) fail("ALERT_CHANNEL_NOT_FOUND", "channel is unavailable");
    const fields = {
      kinds: [...new Set(input.kinds)],
      allSites: input.allSites,
      enabled: input.enabled,
    };
    const [sub] = await tx
      .insert(schema.alertSubscription)
      .values({ ...fields, userId: ctx.userId, channelId: c.id })
      .onConflictDoUpdate({
        target: [schema.alertSubscription.userId, schema.alertSubscription.channelId],
        set: fields,
      })
      .returning();
    if (!sub) throw new Error("subscription insert failed");
    await setSubscriptionSites(tx, sub, input);
    await recordAudit(tx, ctx.actor, {
      action: "alert.subscribe",
      ...subscriptionAudit(sub, input, c.name),
    });
    const [dto] = await subscriptionDtos(tx, [sub]);
    if (!dto) throw new Error("subscription not readable");
    return dto;
  });
}
async function ownSubscription(tx: Executor, id: string, ctx: AlertContext) {
  const [sub] = await tx
    .select()
    .from(schema.alertSubscription)
    .where(
      and(eq(schema.alertSubscription.id, id), eq(schema.alertSubscription.userId, ctx.userId)),
    )
    .for("update");
  if (!sub) fail("ALERT_SUBSCRIPTION_NOT_FOUND", "subscription not found");
  return sub;
}
export async function updateAlertSubscription(
  app: AppContext,
  input: SubscriptionFields & { id: string },
  ctx: AlertContext,
) {
  return app.db.transaction(async (tx) => {
    await ownSubscription(tx, input.id, ctx);
    const [sub] = await tx
      .update(schema.alertSubscription)
      .set({ kinds: [...new Set(input.kinds)], allSites: input.allSites, enabled: input.enabled })
      .where(eq(schema.alertSubscription.id, input.id))
      .returning();
    if (!sub) throw new Error("subscription update failed");
    await setSubscriptionSites(tx, sub, input);
    const c = await channel(tx, sub.channelId);
    await recordAudit(tx, ctx.actor, {
      action: "alert.subscription_update",
      ...subscriptionAudit(sub, input, c.name),
    });
    const [dto] = await subscriptionDtos(tx, [sub]);
    if (!dto) throw new Error("subscription not readable");
    return dto;
  });
}
export async function unsubscribeAlerts(app: AppContext, id: string, ctx: AlertContext) {
  return app.db.transaction(async (tx) => {
    const sub = await ownSubscription(tx, id, ctx);
    const c = await channel(tx, sub.channelId);
    await tx.delete(schema.alertSubscription).where(eq(schema.alertSubscription.id, id));
    await recordAudit(tx, ctx.actor, {
      action: "alert.unsubscribe",
      targetType: "alert_subscription",
      targetId: id,
      targetName: c.name,
    });
    return { ok: true as const };
  });
}
export async function listAlertEvents(app: AppContext, siteId?: string) {
  if (siteId) await findSite(app.db, siteId);
  const rows = await app.db
    .select({ event: schema.alertEvent, siteName: schema.site.name })
    .from(schema.alertEvent)
    .leftJoin(schema.site, eq(schema.site.id, schema.alertEvent.siteId))
    .where(
      siteId
        ? or(
            eq(schema.site.id, siteId),
            // Nodes that serve the site.
            and(
              eq(schema.alertEvent.kind, "node_offline"),
              isNull(schema.alertEvent.siteId),
              sql`${schema.alertEvent.resourceId} in (select n.id::text from node n join site s on s.cluster_id = n.cluster_id where s.id = ${siteId}::uuid)`,
            ),
          )
        : // Platform alerts have no site; alerts of deleted sites are gone with them.
          or(isNull(schema.alertEvent.siteId), isNotNull(schema.site.id)),
    )
    .orderBy(desc(schema.alertEvent.occurredAt), desc(schema.alertEvent.ordinal))
    .limit(100);
  return rows.map(({ event, siteName }) => ({
    id: event.id,
    siteId: event.siteId,
    kind: alertEventKind.parse(event.kind),
    status: event.status === "resolved" ? ("resolved" as const) : ("firing" as const),
    occurredAt: event.occurredAt.toISOString(),
    siteName: siteName ?? event.payload.siteName,
  }));
}

/** Site alerts are keyed by site; platform alerts (no site) by "platform". */
const keyOf = (kind: string, siteId: string | null, resourceId: string) =>
  `${kind}/${siteId ?? "platform"}/${resourceId}`;
interface Condition {
  /** Null for node_offline: one alert per node, whatever sites it serves. */
  siteId: string | null;
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
    .where(eq(schema.site.enabled, true));
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
  const elevated = await elevatedSites(app.db, now);
  const active = new Map<string, Condition>();
  // A node counts once its enrollment is older than the threshold.
  const watched = nodes.filter(
    (n) =>
      n.status === "active" &&
      n.enrolledAt &&
      n.enrolledAt.getTime() <= now - policy.nodeOfflineSeconds * 1000,
  );
  for (const node of watched) {
    const receipt = receipts.find((r) => r.nodeId === node.id);
    if (
      !node.lastSeenAt ||
      node.lastSeenAt.getTime() < now - policy.nodeOfflineSeconds * 1000 ||
      receipt?.dataPlaneHealthy === false
    )
      active.set(keyOf("node_offline", null, node.id), {
        siteId: null,
        kind: "node_offline",
        resourceId: node.id,
        siteName: node.name,
        domain: "",
      });
  }
  for (const site of sites) {
    const base = {
      siteId: site.id,
      siteName: site.name,
      domain: domains.find((d) => d.siteId === site.id)?.name ?? "",
    };
    const add = (kind: AlertKind, resourceId: string) =>
      active.set(keyOf(kind, site.id, resourceId), { ...base, kind, resourceId });
    const members = watched.filter((n) => n.clusterId === site.clusterId);
    const cert = certificates.find((c) => c.id === site.certificateId);
    if (cert?.notAfter && cert.notAfter.getTime() <= now + policy.certificateHours * 3600000)
      add("certificate_expiring", cert.id);
    const originIds = origins.filter((o) => o.siteId === site.id).map((o) => o.id);
    // Unavailable on a node: a recent entry of either check (passive or active)
    // marks the origin down. The alert holds while some member node has every
    // origin of the site unavailable.
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
    // Fired by the nodes' events (reportSecurityEvents); held while a node reports the site above normal.
    if (elevated.has(site.id)) add("cc_mitigation", site.id);
  }
  return { active, sites, nodes };
}
/**
 * A platform channel gets every alert; others the site alerts of the sites
 * their subscription covers (all sites, or its set), and node_offline of a
 * node in the cluster of such a site.
 */
async function eligible(app: AppContext, c: Channel, event: Event) {
  if (!c.enabled) return false;
  if (c.platform) return true;
  // Platform alerts have no subscribers: platform channels only.
  if (event.siteId === null && event.kind !== "node_offline") return false;
  const sub = schema.alertSubscription,
    member = schema.alertSubscriptionSite;
  // The sites the alert concerns: its own, or those the offline node serves.
  const concerned =
    event.siteId !== null
      ? sql`select ${event.siteId}::uuid`
      : sql`select s.id from site s join node n on n.cluster_id = s.cluster_id where n.id::text = ${event.resourceId}`;
  const rows = await app.db
    .select({ kinds: sub.kinds })
    .from(sub)
    .where(
      and(
        eq(sub.channelId, c.id),
        eq(sub.enabled, true),
        sql`((${sub.allSites} and exists (${concerned})) or exists (select 1 from ${member} m where m.subscription_id = ${sub.id} and m.site_id in (${concerned})))`,
      ),
    );
  return rows.some((r) => r.kinds.includes(event.kind));
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
        // At most once per site in 15 minutes: a raise held back fires here once they are over.
        if (c.kind === "cc_mitigation" && c.siteId) {
          await raiseCcAlert(tx, { id: c.siteId, name: c.siteName }, new Date(now));
          continue;
        }
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
      // Platform alerts (no site) are raised and resolved where they happen,
      // not here; node_offline is the exception.
      for (const old of previous.filter(
        (s) =>
          s.active &&
          (s.siteId !== null || s.kind === "node_offline") &&
          !snapshot.active.has(s.key),
      )) {
        await tx
          .update(schema.alertState)
          .set({ active: false, updatedAt: new Date(now) })
          .where(eq(schema.alertState.key, old.key));
        // Nothing is announced for a deleted site or node.
        const name =
          old.siteId === null
            ? snapshot.nodes.find((n) => n.id === old.resourceId)?.name
            : snapshot.sites.find((s) => s.id === old.siteId)?.name;
        if (name !== undefined)
          await tx.insert(schema.alertEvent).values({
            siteId: old.siteId,
            kind: old.kind,
            resourceId: old.resourceId,
            status: "resolved",
            payload: { siteName: name, domain: "" },
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
      .limit(DELIVERY_BATCH);
    const started = Date.now();
    for (const delivery of pending) {
      // The rest waits for the next minute's sweep.
      if (Date.now() - started > DELIVERY_BUDGET_MS) break;
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
          kind: alertEventKind.parse(event.kind),
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
