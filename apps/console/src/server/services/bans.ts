import {
  AUTO_BAN_REASONS,
  BAN_MAX_SECONDS,
  BAN_MIN_SECONDS,
  BAN_PAGE_DEFAULT,
  BAN_PAGE_MAX,
  BAN_SETTINGS_DEFAULTS,
  type Ban,
  type BanCreateInput,
  type BanList,
  type BanListInput,
  type BanReason,
  type BanSettings,
  banLookupCidr,
  banSettings,
  isAutoBanPrefix,
  isRuleBanPrefix,
  MAX_AUTO_BANS_PER_CLUSTER,
  nodeSupportsFeature,
  parseBanCidr,
  protectedBanOverlap,
  protectedBanRanges,
  RULE_BAN_REASONS,
  UNKNOWN_HOST_FEATURE,
  unicastAddress,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { fail } from "../lib/errors";
import { BANS_CHANNEL } from "../lib/events";
import { lockBans } from "../lib/locks";
import { ONLINE_WINDOW_SECONDS } from "../lib/node-online";
import { deleteInBatches } from "../lib/retention";
import { type Actor, recordAudit } from "./audit";
import type { Executor } from "./revisions";
import { defineSetting } from "./settings";
import { findSite, shareSites } from "./sites";

type BanRow = typeof schema.ipBan.$inferSelect;

/** Sources of the bans nodes make and report: automatic mitigation and rules (waf-v2). */
const NODE_SOURCES = ["auto", "rule"] as const;
const fromNodes = () => inArray(schema.ipBan.source, [...NODE_SOURCES]);

const SETTINGS_KEY = "ban_settings";
/** Expired rows are deleted this long after they expire (nodes drop them at expiry). */
export const BAN_RETENTION_MS = 3600_000;

/** Next `n` values of ip_ban_seq, ascending. Call with the ban lock held. */
async function nextSeqs(tx: Executor, n: number): Promise<bigint[]> {
  if (n <= 0) return [];
  const result = await tx.execute<{ seq: string }>(
    sql`select nextval('ip_ban_seq')::text as seq from generate_series(1, ${n})`,
  );
  return result.rows.map((row) => BigInt(row.seq)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

async function nextSeq(tx: Executor): Promise<bigint> {
  const [seq] = await nextSeqs(tx, 1);
  if (seq === undefined) throw new Error("ip_ban_seq returned nothing");
  return seq;
}

/**
 * The sequence's current value (the last value handed out, 0 before the
 * first), independent of which rows still exist.
 */
export async function currentBanSequence(db: Executor): Promise<bigint> {
  const result = await db.execute<{ last_value: string; is_called: boolean }>(
    sql`select last_value::text as last_value, is_called from ip_ban_seq`,
  );
  const row = result.rows[0];
  if (!row) return 0n;
  const last = BigInt(row.last_value);
  return row.is_called ? last : last - 1n;
}

/** Wakes the watch streams of the affected clusters once the transaction commits. */
async function notifyBans(tx: Executor, clusterIds: string[] | null) {
  await tx.execute(sql`select pg_notify(${BANS_CHANNEL}, ${JSON.stringify({ clusterIds })})`);
}

const banSetting = defineSetting({
  key: SETTINGS_KEY,
  schema: banSettings,
  defaults: BAN_SETTINGS_DEFAULTS,
  auditAction: "system.bans_update",
});

export const getBanSettings = banSetting.read;

export function setBanSettings(db: Database, input: BanSettings, actor: Actor) {
  return db.transaction((tx) => banSetting.write(tx, actor, input));
}

/**
 * Node addresses and the allow lists: no ban may cover them. A site
 * ban is held back only by the addresses of nodes in the site's cluster, a
 * platform ban by those of every node. A node reports single addresses; rows
 * stored before that was checked are skipped unless they are one.
 */
async function protectedAddresses(tx: Executor, clusterId: string | null): Promise<string[]> {
  const ips = await tx
    .selectDistinct({ address: schema.nodeIp.address })
    .from(schema.nodeIp)
    .innerJoin(schema.node, eq(schema.node.id, schema.nodeIp.nodeId))
    .where(clusterId ? eq(schema.node.clusterId, clusterId) : undefined);
  const allow = await tx
    .select({ entries: schema.ipList.entries })
    .from(schema.ipList)
    .where(eq(schema.ipList.kind, "allow"));
  return [
    ...ips.flatMap((row) => unicastAddress(row.address) ?? []),
    ...allow.flatMap((row) => row.entries),
  ];
}

/** The trusted proxies of every cluster's client address setting (client-ip-v1). */
async function trustedProxies(tx: Executor): Promise<string[]> {
  const rows = await tx.select({ clientIp: schema.cluster.clientIp }).from(schema.cluster);
  return rows.flatMap((row) => row.clientIp?.trustedCidrs ?? []);
}

const active = (now: Date) =>
  and(isNull(schema.ipBan.removedAt), gt(schema.ipBan.expiresAt, now)) as ReturnType<typeof and>;

/** Online nodes that report each of these bans as not applied. */
async function unappliedCounts(db: Executor, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const since = new Date(Date.now() - ONLINE_WINDOW_SECONDS * 1000);
  const result = await db.execute<{ id: string; nodes: number }>(sql`
    select u.id, count(*)::int as nodes
    from ${schema.node} n, jsonb_array_elements_text(n.ban_status -> 'unappliedIds') as u(id)
    where n.ban_status is not null and n.status = 'active' and n.last_seen_at > ${since.toISOString()}::timestamptz
      and u.id in (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )})
    group by u.id`);
  return new Map(result.rows.map((row) => [row.id, Number(row.nodes)]));
}

async function toBans(db: Executor, where: ReturnType<typeof and>, page?: [number, number]) {
  const query = db
    .select({
      ban: schema.ipBan,
      siteName: schema.site.name,
      nodeName: schema.node.name,
    })
    .from(schema.ipBan)
    .leftJoin(schema.site, eq(schema.site.id, schema.ipBan.siteId))
    .leftJoin(schema.node, eq(schema.node.id, schema.ipBan.nodeId))
    .where(where)
    .orderBy(desc(schema.ipBan.createdAt), desc(schema.ipBan.seq));
  const rows = page ? await query.limit(page[1]).offset((page[0] - 1) * page[1]) : await query;
  const unapplied = await unappliedCounts(
    db,
    rows.map((r) => r.ban.id),
  );
  const rules = await banRules(
    db,
    rows.flatMap((r) => (r.ban.trigger?.ruleId ? [r.ban.trigger.ruleId] : [])),
  );
  return rows.map(
    ({ ban, siteName, nodeName }): Ban => ({
      id: ban.id,
      scope: ban.scope as Ban["scope"],
      cidr: ban.cidr,
      reason: ban.reason as BanReason,
      source: ban.source as Ban["source"],
      siteId: ban.siteId,
      siteName: siteName ?? null,
      node: ban.nodeId ? { id: ban.nodeId, name: nodeName ?? "" } : null,
      trigger: ban.trigger ?? null,
      rule: ban.trigger?.ruleId
        ? {
            id: ban.trigger.ruleId,
            name: rules.get(ban.trigger.ruleId)?.name ?? null,
            platform: rules.get(ban.trigger.ruleId)?.platform ?? ban.scope === "platform",
          }
        : null,
      createdBy: ban.createdBy ?? null,
      createdAt: ban.createdAt.toISOString(),
      expiresAt: ban.expiresAt.toISOString(),
      seq: ban.seq.toString(),
      distributed: ban.distributed,
      unappliedNodes: unapplied.get(ban.id) ?? 0,
    }),
  );
}

/** Names of the rules that made bans (deleted rules are absent). */
async function banRules(
  db: Executor,
  ids: string[],
): Promise<Map<string, { name: string; platform: boolean }>> {
  const unique = [...new Set(ids.filter((id) => UUID_RE.test(id)))];
  if (!unique.length) return new Map();
  const rows = await db
    .select({ id: schema.edgeRule.id, name: schema.edgeRule.name, siteId: schema.edgeRule.siteId })
    .from(schema.edgeRule)
    .where(inArray(schema.edgeRule.id, unique));
  return new Map(rows.map((row) => [row.id, { name: row.name, platform: row.siteId === null }]));
}

async function banById(db: Executor, id: string): Promise<Ban> {
  const [dto] = await toBans(db, eq(schema.ipBan.id, id));
  if (!dto) fail("BAN_NOT_FOUND", "ban not found");
  return dto;
}

/** Active bans, newest first. */
export async function listBans(
  db: Database,
  input: BanListInput,
  now = new Date(),
): Promise<BanList> {
  const filters = [active(now)];
  if (input.siteId) filters.push(eq(schema.ipBan.siteId, input.siteId));
  if (input.source) filters.push(eq(schema.ipBan.source, input.source));
  if (input.scope) filters.push(eq(schema.ipBan.scope, input.scope));
  if (input.address !== undefined) {
    const address = banLookupCidr(input.address);
    if (!address) fail("BAN_INVALID_CIDR", "invalid IP address or CIDR");
    // Stored CIDRs are canonical (parseBanCidr, reported bans): inet's && is "contains or is
    // contained by".
    filters.push(sql`${schema.ipBan.cidr}::inet && ${address}::inet`);
  }
  const where = and(...filters);
  const [total] = await db.select({ n: count() }).from(schema.ipBan).where(where);
  return {
    items: await toBans(db, where, [input.page, input.pageSize]),
    total: total?.n ?? 0,
  };
}

function checkDuration(seconds: number) {
  if (!Number.isInteger(seconds) || seconds < BAN_MIN_SECONDS || seconds > BAN_MAX_SECONDS)
    fail("BAN_EXPIRY_OUT_OF_RANGE", "a ban lasts from 1 minute to 7 days");
}

function banTarget(text: string) {
  const parsed = parseBanCidr(text);
  if (!parsed.ok) {
    if (parsed.code === "BAN_PREFIX_TOO_SHORT")
      fail("BAN_PREFIX_TOO_SHORT", `prefix must be at least /${parsed.min}`, { min: parsed.min });
    fail("BAN_INVALID_CIDR", "invalid IP address or CIDR");
  }
  return parsed;
}

/**
 * Creates a manual ban, or bans the same (scope, site, CIDR) again: that sets
 * the new reason and expiry and takes a new sequence number. Every manual
 * ban counts against the platform total. An expired entry, and the
 * automatic entry of a platform address (scan protection), start over as a
 * new manual ban: checked against the limit, audited as created and sent to
 * the nodes like one; an active one never shared is lifted and the manual
 * ban added as a new entry.
 */
export async function createBan(
  db: Database,
  input: BanCreateInput,
  ctx: { actor: Actor },
): Promise<Ban> {
  const target = banTarget(input.cidr);
  checkDuration(input.durationSeconds);
  const id = await db.transaction(async (tx) => {
    const site = input.scope === "site" ? await findSite(tx, input.siteId ?? "") : undefined;
    // Checked before the ban lock: other ban writers need not wait for it.
    const covered = protectedBanOverlap(
      target.cidr,
      await protectedAddresses(tx, site?.clusterId ?? null),
    );
    if (covered)
      fail("BAN_PROTECTED_ADDRESS", `the ban covers the protected address ${covered}`, {
        address: covered,
      });
    await lockBans(tx, "exclusive");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.durationSeconds * 1000);
    let [existing] = await tx
      .select()
      .from(schema.ipBan)
      .where(
        and(
          eq(schema.ipBan.cidr, target.text),
          isNull(schema.ipBan.removedAt),
          site
            ? and(
                eq(schema.ipBan.scope, "site"),
                eq(schema.ipBan.source, "manual"),
                eq(schema.ipBan.siteId, site.id),
              )
            : eq(schema.ipBan.scope, "platform"),
        ),
      )
      .for("update");
    // An active automatic platform ban never shared lives on the nodes as
    // their own bans: it is lifted (each node releases its own on its next
    // sync, however late; ownReleases) and the manual ban is a new entry.
    if (
      existing &&
      existing.source !== "manual" &&
      !existing.distributed &&
      existing.expiresAt > now
    ) {
      await tx
        .update(schema.ipBan)
        .set({ removedAt: now, seq: await nextSeq(tx) })
        .where(eq(schema.ipBan.id, existing.id));
      existing = undefined;
    }
    // Only an active manual ban is banned again; an automatic platform one
    // (scan protection, possibly never shared) becomes a manual ban.
    const renewal = !!existing && existing.source === "manual" && existing.expiresAt > now;
    if (!renewal) {
      const { maxTotal } = await getBanSettings(tx);
      const [total] = await tx
        .select({ n: count() })
        .from(schema.ipBan)
        .where(and(eq(schema.ipBan.source, "manual"), active(now)));
      if ((total?.n ?? 0) >= maxTotal)
        fail("BAN_PLATFORM_LIMIT", `the platform holds at most ${maxTotal} bans`, {
          limit: maxTotal,
        });
    }
    const seq = await nextSeq(tx);
    const createdBy = { type: ctx.actor.type, id: ctx.actor.id, name: ctx.actor.name ?? "" };
    let row: BanRow | undefined;
    if (existing) {
      [row] = await tx
        .update(schema.ipBan)
        .set({
          reason: input.reason,
          expiresAt,
          seq,
          // An expired or automatic entry starts over as a new manual ban.
          ...(renewal
            ? {}
            : {
                source: "manual",
                nodeId: null,
                trigger: null,
                createdAt: now,
                createdBy,
                distributed: true,
              }),
        })
        .where(eq(schema.ipBan.id, existing.id))
        .returning();
    } else {
      [row] = await tx
        .insert(schema.ipBan)
        .values({
          scope: site ? "site" : "platform",
          siteId: site?.id ?? null,
          clusterId: site?.clusterId ?? null,
          cidr: target.text,
          reason: input.reason,
          source: "manual",
          createdBy,
          createdAt: now,
          expiresAt,
          seq,
          distributed: true,
        })
        .returning();
    }
    if (!row) throw new Error("ban write failed");
    await notifyBans(tx, site ? [site.clusterId] : null);
    await recordAudit(tx, ctx.actor, {
      action: renewal ? "ban.update" : "ban.create",
      targetType: "ban",
      targetId: row.id,
      targetName: row.cidr,
      metadata: {
        scope: row.scope,
        siteId: row.siteId,
        siteName: site?.name ?? "",
        cidr: row.cidr,
        reason: row.reason,
        expiresAt: row.expiresAt.toISOString(),
        seq: row.seq.toString(),
        ...(renewal && existing
          ? { previousReason: existing.reason, previousExpiresAt: existing.expiresAt.toISOString() }
          : {}),
      },
    });
    return row.id;
  });
  return banById(db, id);
}

/**
 * Lifts an active ban (manual or automatic, of a site or every site) before
 * it expires.
 */
export async function deleteBan(db: Database, id: string, ctx: { actor: Actor }) {
  await db.transaction(async (tx) => {
    await lockBans(tx, "exclusive");
    const now = new Date();
    const [row] = await tx
      .select()
      .from(schema.ipBan)
      .where(and(eq(schema.ipBan.id, id), active(now)))
      .for("update");
    if (!row) fail("BAN_NOT_FOUND", "ban not found");
    const seq = await nextSeq(tx);
    await tx.update(schema.ipBan).set({ removedAt: now, seq }).where(eq(schema.ipBan.id, id));
    // A ban never distributed is lifted on the node that created it.
    await notifyBans(tx, row.clusterId ? [row.clusterId] : null);
    const [site] = row.siteId
      ? await tx
          .select({ name: schema.site.name })
          .from(schema.site)
          .where(eq(schema.site.id, row.siteId))
      : [];
    await recordAudit(tx, ctx.actor, {
      action: "ban.delete",
      targetType: "ban",
      targetId: row.id,
      targetName: row.cidr,
      metadata: {
        scope: row.scope,
        siteId: row.siteId,
        siteName: site?.name ?? "",
        cidr: row.cidr,
        reason: row.reason,
        source: row.source,
        seq: seq.toString(),
      },
    });
  });
  return { ok: true as const };
}

export interface BanPage {
  reset: boolean;
  bans: BanRow[];
  removedIds: string[];
  /**
   * Automatic bans never distributed, lifted on this page, that the node may
   * hold on its own: its site bans, and when the node has scan protection
   * (unknown-host-v1) the platform ones lifted in the console (several nodes
   * can have banned the address, the row names the first) and those its
   * cluster must not ban (storeLiftedPlatformBans). A platform one's
   * expiresAt is this node's release guard (ownReleases).
   */
  liftedOwn: BanRow[];
  sequence: bigint;
  more: boolean;
}

/**
 * One page of the ban changes a node sees: bans of its cluster and platform
 * bans that are distributed, and automatic bans that were never distributed
 * once they are lifted (only nodes hold them): its own site bans, the
 * platform ones lifted in the console and those lifted for its cluster
 * (ownReleases). From 0, or
 * from a sequence ahead of the console's (a restored database), it is a
 * snapshot of the active distributed bans (`reset`). Otherwise it holds the
 * active bans and the lifted ones changed after `afterSequence`; expired
 * bans are left out (nodes drop them at expiry). `sequence` is the highest
 * sequence of the page, or the current sequence value on the last page.
 */
export async function banChanges(
  db: Database,
  node: { id: string; clusterId: string },
  afterSequence: bigint,
  limit: number,
  now = new Date(),
): Promise<BanPage> {
  const size = Math.min(limit > 0 ? limit : BAN_PAGE_DEFAULT, BAN_PAGE_MAX);
  return db.transaction(async (tx) => {
    // Waits for writers in flight: the current value then only covers committed changes.
    await lockBans(tx, "shared");
    const current = await currentBanSequence(tx);
    const reset = afterSequence === 0n || afterSequence > current;
    const distributed = and(
      or(isNull(schema.ipBan.clusterId), eq(schema.ipBan.clusterId, node.clusterId)),
      eq(schema.ipBan.distributed, true),
    );
    const ownLifted = and(
      fromNodes(),
      or(
        and(eq(schema.ipBan.scope, "site"), eq(schema.ipBan.nodeId, node.id)),
        // A platform row with a cluster was lifted for that cluster's nodes only.
        and(
          eq(schema.ipBan.scope, "platform"),
          or(isNull(schema.ipBan.clusterId), eq(schema.ipBan.clusterId, node.clusterId)),
        ),
      ),
      eq(schema.ipBan.distributed, false),
      isNotNull(schema.ipBan.removedAt),
    );
    const rows = await tx
      .select()
      .from(schema.ipBan)
      .where(
        and(
          lte(schema.ipBan.seq, current),
          reset
            ? and(distributed, active(now))
            : and(
                or(distributed, ownLifted),
                gt(schema.ipBan.seq, afterSequence),
                or(isNotNull(schema.ipBan.removedAt), gt(schema.ipBan.expiresAt, now)),
              ),
        ),
      )
      .orderBy(schema.ipBan.seq)
      .limit(size + 1);
    const more = rows.length > size;
    const page = rows.slice(0, size);
    return {
      reset,
      bans: page.filter((row) => row.removedAt === null),
      removedIds: page
        .filter((row) => row.removedAt !== null && row.distributed)
        .map((row) => row.id),
      liftedOwn: await ownReleases(
        tx,
        node,
        page.filter((row) => row.removedAt !== null && !row.distributed),
        now,
      ),
      sequence: more ? (page.at(-1)?.seq ?? current) : current,
      more,
    };
  });
}

/**
 * The lifted, never distributed automatic bans of a page as `node` gets
 * them. Its own site bans as they are. Platform ones (scan protection) only
 * with unknown-host-v1: older nodes hold no platform bans of their own and
 * refuse such rows. The node deletes an own ban of the address that expires
 * no later than the expiry it is sent (plus a second). One lifted for the
 * node's cluster (storeLiftedPlatformBans) goes as it is: no node of the
 * cluster may ban the address. One lifted in the console gets as expiry
 * the lift plus the longest scan ban time the node's cluster has had
 * (longestScanBanSeconds; an own ban made before the lift expires by then,
 * one made after it with that time later), at most the row's own expiry:
 * clusters ban for different times, and the row keeps the longest one
 * reported. Ones expired (for this node) are left out: the node dropped
 * those bans already.
 */
async function ownReleases(
  tx: Executor,
  node: { id: string; clusterId: string },
  rows: BanRow[],
  now: Date,
): Promise<BanRow[]> {
  let capable = false;
  let banSeconds = 0;
  if (rows.some((row) => row.scope === "platform")) {
    const [self] = await tx
      .select({ features: schema.node.supportedFeatures })
      .from(schema.node)
      .where(eq(schema.node.id, node.id));
    capable = !!self && nodeSupportsFeature(self.features, UNKNOWN_HOST_FEATURE);
    if (capable && rows.some((row) => row.scope === "platform" && row.clusterId === null))
      banSeconds = await longestScanBanSeconds(tx, node.clusterId);
  }
  return rows.flatMap((row) => {
    let expiresAt = row.expiresAt;
    if (row.scope === "platform") {
      if (!capable || !row.removedAt) return [];
      // Scan bans: the cluster's longest scan ban time; a rule's ban keeps its own expiry.
      if (row.clusterId === null && row.source === "auto")
        expiresAt = new Date(
          Math.min(row.expiresAt.getTime(), row.removedAt.getTime() + banSeconds * 1000),
        );
    }
    return expiresAt > now ? [{ ...row, expiresAt }] : [];
  });
}

/**
 * The longest scan ban time a node of the cluster may hold a ban with: the
 * current one and every one a change replaced (the audit log keeps the
 * setting before each change), each while scan protection was on; 0 if it
 * never was. A node's ban keeps the time it was made with, and a node can
 * run an older setting for a while (not applied yet, a canary rollout), so
 * a shortened ban time does not bound the bans made before.
 */
async function longestScanBanSeconds(tx: Executor, clusterId: string): Promise<number> {
  const [cluster] = await tx
    .select({ unknownHosts: schema.cluster.unknownHosts })
    .from(schema.cluster)
    .where(eq(schema.cluster.id, clusterId));
  const scan = cluster?.unknownHosts?.scan;
  const banSeconds = sql`${schema.auditLog.metadata} #> '{from,scan,banSeconds}'`;
  const [earlier] = await tx
    .select({
      seconds: sql<
        string | null
      >`max(case when jsonb_typeof(${banSeconds}) = 'number' then (${banSeconds})::text::numeric end)::text`,
    })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.action, "cluster.unknown_hosts_update"),
        eq(schema.auditLog.targetId, clusterId),
        sql`${schema.auditLog.metadata} #> '{from,scan,enabled}' = 'true'::jsonb`,
      ),
    );
  return Math.max(scan?.enabled ? scan.banSeconds : 0, Number(earlier?.seconds ?? 0) || 0);
}

export interface ReportedAutoBan {
  /**
   * platform: scan protection (unknown_host_scan) or a platform rule's ban (waf_rule), no
   * site; site: CC (cc_ip_rate), challenge failures, a rule's ban or rate limit.
   */
  scope: "site" | "platform";
  siteId: string;
  cidr: string;
  createdAt: Date | null;
  expiresAt: Date | null;
  reason: string;
  metric: string;
  observed: number;
  threshold: number;
  windowSeconds: number;
  /** The rule of a ban a rule made (reasons waf_rule and rate_limit). */
  ruleId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METRIC_RE = /^[a-z0-9_]{1,32}$/;
const finite = (value: number) => (Number.isFinite(value) ? value : 0);

/**
 * Stores automatic bans a node reported, keyed by (node, site, CIDR): an
 * active entry keeps the later expiry. Bans of sites outside the node's
 * cluster, prefixes other than an IPv4 address or an IPv6 /64 (or /128 of
 * older nodes), unknown reasons, protected addresses (site bans) and
 * expired bans are skipped; expiry is capped at 7 days after creation.
 * Platform bans (scan protection, reason unknown_host_scan, no site) are
 * keyed by CIDR alone, like manual platform bans: an active one (manual or
 * from another node) stays, an automatic one keeps the later expiry; they
 * apply to every cluster when shared. One covering an address of another
 * cluster's node or any cluster's trusted proxy is never shared; one
 * covering an address of a node of the reporting node's cluster or an
 * allow list is stored lifted for that cluster (storeLiftedPlatformBans).
 * Returns how many bans were accepted.
 */
export async function reportAutoBans(
  db: Database,
  node: { id: string; clusterId: string },
  reported: ReportedAutoBan[],
  now = new Date(),
): Promise<number> {
  const maxExpiry = now.getTime() + BAN_MAX_SECONDS * 1000;
  const items = new Map<
    string,
    {
      scope: "site" | "platform";
      siteId: string;
      source: "auto" | "rule";
      cidr: ReturnType<typeof parseBanCidr> & { ok: true };
      createdAt: Date;
      expiresAt: Date;
      reason: string;
      trigger: NonNullable<BanRow["trigger"]>;
    }
  >();
  for (const ban of reported) {
    const byRule = (RULE_BAN_REASONS as readonly string[]).includes(ban.reason);
    if (!byRule && !(AUTO_BAN_REASONS as readonly string[]).includes(ban.reason)) continue;
    const platform = ban.scope === "platform";
    // Scan protection and platform rules' bans at platform scope only; the others per site.
    if (
      platform !== (ban.reason === "unknown_host_scan" || (ban.reason === "waf_rule" && platform))
    )
      continue;
    if (platform ? ban.siteId !== "" : !UUID_RE.test(ban.siteId)) continue;
    // A rule's ban names its rule; nothing else does.
    const ruleId = ban.ruleId ?? "";
    if (byRule !== UUID_RE.test(ruleId)) continue;
    const cidr = parseBanCidr(ban.cidr);
    if (!cidr.ok || !(byRule ? isRuleBanPrefix(cidr.cidr) : isAutoBanPrefix(cidr.cidr))) continue;
    const created =
      ban.createdAt &&
      ban.createdAt.getTime() <= now.getTime() &&
      ban.createdAt.getTime() > now.getTime() - BAN_MAX_SECONDS * 1000
        ? ban.createdAt
        : now;
    if (!ban.expiresAt) continue;
    const expiresAt = new Date(
      Math.min(ban.expiresAt.getTime(), created.getTime() + BAN_MAX_SECONDS * 1000, maxExpiry),
    );
    if (expiresAt.getTime() <= now.getTime()) continue;
    const source = byRule ? ("rule" as const) : ("auto" as const);
    // Platform bans are one per CIDR; site bans one per site, CIDR and source.
    const key = platform ? `*|${cidr.text}` : `${ban.siteId.toLowerCase()}|${cidr.text}|${source}`;
    const previous = items.get(key);
    if (previous && previous.expiresAt >= expiresAt) continue;
    items.set(key, {
      scope: platform ? "platform" : "site",
      siteId: ban.siteId.toLowerCase(),
      source,
      cidr,
      createdAt: created,
      expiresAt,
      reason: ban.reason,
      trigger: {
        metric: METRIC_RE.test(ban.metric) ? ban.metric : "",
        observed: finite(ban.observed),
        threshold: finite(ban.threshold),
        windowSeconds: Math.max(0, Math.min(Math.trunc(finite(ban.windowSeconds)), 86400)),
        ...(byRule ? { ruleId: ruleId.toLowerCase() } : {}),
      },
    });
  }
  // A rule's ban needs its rule: a platform rule for platform bans, the site's or a platform
  // rule for site bans (a rule deleted meanwhile drops its bans).
  const ruleIds = [...new Set([...items.values()].flatMap((i) => i.trigger.ruleId ?? []))];
  if (ruleIds.length) {
    const rules = await db
      .select({ id: schema.edgeRule.id, siteId: schema.edgeRule.siteId })
      .from(schema.edgeRule)
      .where(inArray(schema.edgeRule.id, ruleIds));
    const owner = new Map(rules.map((rule) => [rule.id, rule.siteId]));
    for (const [key, item] of items) {
      const ruleId = item.trigger.ruleId;
      if (ruleId === undefined) continue;
      const site = owner.get(ruleId);
      const ok =
        site !== undefined && (site === null || (item.scope === "site" && site === item.siteId));
      if (!ok) items.delete(key);
    }
  }
  if (items.size === 0) return 0;
  // The node and allow-list addresses are parsed once and checked outside
  // the ban lock: a report of many bans against a long allow list must not
  // hold up every other ban writer and reader.
  const isProtected = protectedBanRanges(await protectedAddresses(db, node.clusterId));
  const values = [...items.values()];
  const siteBans = values.filter((item) => item.scope === "site" && !isProtected(item.cidr.cidr));
  // A shared platform ban reaches every cluster (and their kernel bans):
  // the addresses of every node and every cluster's trusted proxies hold it
  // back. The reporting node holds it already, so it is stored all the
  // same: kept to that node (not shared, but listed and liftable), or lifted
  // at once when it covers an address that node must not ban either (a node
  // of its cluster, an allow list), so that the nodes of its cluster delete
  // it. Other clusters' nodes may hold a ban of it (listed, not shared).
  const platformItems = values.filter((item) => item.scope === "platform");
  const isProtectedElsewhere = platformItems.length
    ? protectedBanRanges([...(await protectedAddresses(db, null)), ...(await trustedProxies(db))])
    : isProtected;
  const builtIn = protectedBanRanges([]);
  const platform = platformItems
    .filter((item) => !builtIn(item.cidr.cidr))
    .map((item) => ({
      ...item,
      handling: isProtected(item.cidr.cidr)
        ? ("lift" as const)
        : isProtectedElsewhere(item.cidr.cidr)
          ? ("local" as const)
          : ("share" as const),
    }));
  if (siteBans.length === 0 && platform.length === 0) return 0;
  return db.transaction(async (tx) => {
    await lockBans(tx, "exclusive");
    const { shareAutoBans } = await getBanSettings(tx);
    const platformAccepted = await storePlatformAutoBans(tx, node, platform, shareAutoBans, now);
    const siteIds = [...new Set(siteBans.map((item) => item.siteId))];
    // Lock order with site deletion (shareSites): the sites before the
    // node's bans of them below; a site deleted while this waited is skipped.
    const sites = await shareSites(
      tx,
      tx
        .select({ id: schema.site.id })
        .from(schema.site)
        .where(and(inArray(schema.site.id, siteIds), eq(schema.site.clusterId, node.clusterId))),
    );
    const accepted = siteBans.filter((item) => sites.has(item.siteId));
    if (accepted.length === 0) return platformAccepted;
    const existing = new Map(
      (
        await tx
          .select()
          .from(schema.ipBan)
          .where(
            and(
              fromNodes(),
              eq(schema.ipBan.nodeId, node.id),
              isNull(schema.ipBan.removedAt),
              inArray(schema.ipBan.siteId, [...new Set(accepted.map((item) => item.siteId))]),
              inArray(schema.ipBan.cidr, [...new Set(accepted.map((item) => item.cidr.text))]),
            ),
          )
          .for("update")
      ).map((row) => [`${row.siteId}|${row.cidr}|${row.source}`, row]),
    );
    let changed = false;
    let added = false;
    const inserts: (typeof schema.ipBan.$inferInsert)[] = [];
    for (const item of accepted) {
      const row = existing.get(`${item.siteId}|${item.cidr.text}|${item.source}`);
      if (row && row.expiresAt > now) {
        // A retried or repeated report only ever extends the ban.
        if (item.expiresAt <= row.expiresAt) continue;
        await tx
          .update(schema.ipBan)
          .set({
            expiresAt: item.expiresAt,
            reason: item.reason,
            trigger: item.trigger,
            seq: await nextSeq(tx),
          })
          .where(eq(schema.ipBan.id, row.id));
        changed ||= row.distributed;
      } else if (row) {
        await tx
          .update(schema.ipBan)
          .set({
            createdAt: item.createdAt,
            expiresAt: item.expiresAt,
            reason: item.reason,
            trigger: item.trigger,
            seq: await nextSeq(tx),
            distributed: shareAutoBans,
          })
          .where(eq(schema.ipBan.id, row.id));
        changed ||= shareAutoBans;
        added = true;
      } else {
        inserts.push({
          scope: "site",
          siteId: item.siteId,
          clusterId: node.clusterId,
          cidr: item.cidr.text,
          reason: item.reason,
          source: item.source,
          nodeId: node.id,
          trigger: item.trigger,
          createdAt: item.createdAt,
          expiresAt: item.expiresAt,
          seq: 0n,
          distributed: shareAutoBans,
        });
      }
    }
    if (inserts.length) {
      const seqs = await nextSeqs(tx, inserts.length);
      await tx
        .insert(schema.ipBan)
        .values(inserts.map((row, i) => ({ ...row, seq: seqs[i] ?? 0n })));
      changed ||= shareAutoBans;
      added = true;
    }
    // Only new active entries can push the cluster over the cap.
    if (added) changed = (await capAutoBans(tx, node.clusterId, now)) || changed;
    if (changed) await notifyBans(tx, [node.clusterId]);
    return accepted.length + platformAccepted;
  });
}

/**
 * Stores platform-wide automatic bans (scan protection) inside
 * reportAutoBans' transaction: one row per CIDR (ip_ban_platform_uq). An
 * active manual platform ban or a later-expiring automatic one stays; an
 * expired row is reused. `handling` share follows the sharing setting;
 * local is never shared (an active shared one is not extended over it);
 * lift is stored as lifted at once for the node's cluster and never shared,
 * reusing the address's lifted row of that cluster, so that its nodes
 * delete their own ban of it (liftedOwn). Returns how many were accepted
 * (lifted ones are not).
 */
async function storePlatformAutoBans(
  tx: Executor,
  node: { id: string; clusterId: string },
  all: {
    cidr: ReturnType<typeof parseBanCidr> & { ok: true };
    source: "auto" | "rule";
    createdAt: Date;
    expiresAt: Date;
    reason: string;
    trigger: NonNullable<BanRow["trigger"]>;
    handling: "share" | "local" | "lift";
  }[],
  shareAutoBans: boolean,
  now: Date,
): Promise<number> {
  if (!all.length) return 0;
  const lifted = await storeLiftedPlatformBans(
    tx,
    node,
    all.filter((item) => item.handling === "lift"),
    now,
  );
  const items = all.filter((item) => item.handling !== "lift");
  if (!items.length) {
    if (lifted) await notifyBans(tx, [node.clusterId]);
    return 0;
  }
  const existing = new Map(
    (
      await tx
        .select()
        .from(schema.ipBan)
        .where(
          and(
            eq(schema.ipBan.scope, "platform"),
            isNull(schema.ipBan.removedAt),
            inArray(
              schema.ipBan.cidr,
              items.map((item) => item.cidr.text),
            ),
          ),
        )
        .for("update")
    ).map((row) => [row.cidr, row]),
  );
  let changed = false;
  let added = false;
  for (const item of items) {
    const row = existing.get(item.cidr.text);
    const share = shareAutoBans && item.handling === "share";
    if (row && row.expiresAt > now) {
      // Already banned on every site: a manual ban stays as it is, and a
      // shared one is not extended over a range other clusters protect.
      if (row.source === "manual" || item.expiresAt <= row.expiresAt) continue;
      if (row.distributed && item.handling === "local") continue;
      await tx
        .update(schema.ipBan)
        .set({
          reason: item.reason,
          source: item.source,
          trigger: item.trigger,
          seq: await nextSeq(tx),
          expiresAt: item.expiresAt,
        })
        .where(eq(schema.ipBan.id, row.id));
      changed ||= row.distributed;
    } else if (row) {
      await tx
        .update(schema.ipBan)
        .set({
          reason: item.reason,
          trigger: item.trigger,
          seq: await nextSeq(tx),
          source: item.source,
          nodeId: node.id,
          createdBy: null,
          createdAt: item.createdAt,
          expiresAt: item.expiresAt,
          distributed: share,
        })
        .where(eq(schema.ipBan.id, row.id));
      changed ||= share || row.distributed;
      added = true;
    } else {
      await tx.insert(schema.ipBan).values({
        scope: "platform",
        siteId: null,
        clusterId: null,
        cidr: item.cidr.text,
        source: item.source,
        nodeId: node.id,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
        distributed: share,
        reason: item.reason,
        trigger: item.trigger,
        seq: await nextSeq(tx),
      });
      changed ||= share;
      added = true;
    }
  }
  if (added) changed = (await capAutoBans(tx, null, now)) || changed;
  if (changed) await notifyBans(tx, null);
  else if (lifted) await notifyBans(tx, [node.clusterId]);
  return items.length;
}

/**
 * Stores reported platform bans that cover an address the reporting node
 * must not ban as lifted at once (never shared) for the node's cluster
 * (clusterId, null on every other platform row), so that liftedOwn tells
 * the nodes of that cluster holding one to delete it; a node of another
 * cluster may hold a ban of the address that stays. The address's latest
 * such row of the cluster is reused (a node banning it again gets the
 * release again, without a row per ban): lifted now, expiring with the
 * later of both. Returns whether anything was stored.
 */
async function storeLiftedPlatformBans(
  tx: Executor,
  node: { id: string; clusterId: string },
  items: {
    cidr: ReturnType<typeof parseBanCidr> & { ok: true };
    source: "auto" | "rule";
    createdAt: Date;
    expiresAt: Date;
    reason: string;
    trigger: NonNullable<BanRow["trigger"]>;
  }[],
  now: Date,
): Promise<boolean> {
  for (const item of items) {
    const [row] = await tx
      .select()
      .from(schema.ipBan)
      .where(
        and(
          eq(schema.ipBan.scope, "platform"),
          fromNodes(),
          eq(schema.ipBan.distributed, false),
          isNotNull(schema.ipBan.removedAt),
          eq(schema.ipBan.clusterId, node.clusterId),
          eq(schema.ipBan.cidr, item.cidr.text),
        ),
      )
      .orderBy(desc(schema.ipBan.seq))
      .limit(1)
      .for("update");
    const values = {
      nodeId: node.id,
      source: item.source,
      reason: item.reason,
      trigger: item.trigger,
      createdAt: item.createdAt,
      removedAt: now,
      seq: await nextSeq(tx),
    };
    if (row)
      await tx
        .update(schema.ipBan)
        .set({
          ...values,
          expiresAt: row.expiresAt > item.expiresAt ? row.expiresAt : item.expiresAt,
        })
        .where(eq(schema.ipBan.id, row.id));
    else
      await tx.insert(schema.ipBan).values({
        ...values,
        scope: "platform",
        siteId: null,
        clusterId: node.clusterId,
        cidr: item.cidr.text,
        expiresAt: item.expiresAt,
        distributed: false,
      });
  }
  return items.length > 0;
}

/**
 * Keeps at most MAX_AUTO_BANS_PER_CLUSTER active automatic bans in a
 * cluster (null: the platform-wide ones of scan protection): older ones are
 * lifted (distributed, so nodes learn it) or deleted (never sent). Returns
 * whether distributed bans were lifted.
 */
async function capAutoBans(tx: Executor, clusterId: string | null, now: Date): Promise<boolean> {
  const overflow = await tx
    .select({ id: schema.ipBan.id, distributed: schema.ipBan.distributed })
    .from(schema.ipBan)
    .where(
      and(
        clusterId === null ? isNull(schema.ipBan.clusterId) : eq(schema.ipBan.clusterId, clusterId),
        fromNodes(),
        active(now),
      ),
    )
    .orderBy(desc(schema.ipBan.createdAt), desc(schema.ipBan.seq))
    .offset(MAX_AUTO_BANS_PER_CLUSTER);
  if (overflow.length === 0) return false;
  const lifted = overflow.filter((row) => row.distributed).map((row) => row.id);
  const dropped = overflow.filter((row) => !row.distributed).map((row) => row.id);
  if (dropped.length) await tx.delete(schema.ipBan).where(inArray(schema.ipBan.id, dropped));
  const seqs = await nextSeqs(tx, lifted.length);
  for (let start = 0; start < lifted.length; start += 1000) {
    const values = sql.join(
      lifted
        .slice(start, start + 1000)
        .map((id, i) => sql`(${id}::uuid, ${String(seqs[start + i])}::bigint)`),
      sql`, `,
    );
    await tx.execute(sql`
      update ${schema.ipBan} set removed_at = ${now.toISOString()}::timestamptz, seq = v.seq
      from (values ${values}) as v(id, seq)
      where ${schema.ipBan.id} = v.id`);
  }
  return lifted.length > 0;
}

/** Deletes bans that expired more than an hour ago, lifted or not. */
export async function pruneBans(db: Database, now = new Date()): Promise<number> {
  return db.transaction(async (tx) => {
    await lockBans(tx, "exclusive");
    return deleteInBatches(
      tx,
      schema.ipBan,
      lt(schema.ipBan.expiresAt, new Date(now.getTime() - BAN_RETENTION_MS)),
    );
  });
}
