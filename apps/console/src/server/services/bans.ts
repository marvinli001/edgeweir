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
  MAX_AUTO_BANS_PER_CLUSTER,
  parseBanCidr,
  protectedBanOverlap,
  protectedBanRanges,
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
import { ONLINE_WINDOW_SECONDS } from "../lib/node-online";
import { deleteInBatches } from "../lib/retention";
import { type Actor, recordAudit } from "./audit";
import type { Executor } from "./revisions";
import { findSite } from "./sites";

type BanRow = typeof schema.ipBan.$inferSelect;

const LOCK_KEY = "edgeweir.bans";
const SETTINGS_KEY = "ban_settings";
/** Expired rows are deleted this long after they expire (nodes drop them at expiry). */
export const BAN_RETENTION_MS = 3600_000;

/**
 * Serializes every ban write for the rest of the transaction. Writers take it
 * before `nextval('ip_ban_seq')`, so changes commit in sequence order.
 */
async function lockBans(tx: Executor) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${LOCK_KEY}))`);
}

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

export async function getBanSettings(db: Executor): Promise<BanSettings> {
  const [row] = await db
    .select()
    .from(schema.systemSetting)
    .where(eq(schema.systemSetting.key, SETTINGS_KEY));
  const parsed = banSettings.safeParse({ ...BAN_SETTINGS_DEFAULTS, ...(row?.value ?? {}) });
  return parsed.success ? parsed.data : BAN_SETTINGS_DEFAULTS;
}

export async function setBanSettings(db: Database, input: BanSettings, actor: Actor) {
  return db.transaction(async (tx) => {
    const before = await getBanSettings(tx);
    await tx
      .insert(schema.systemSetting)
      .values({ key: SETTINGS_KEY, value: input })
      .onConflictDoUpdate({ target: schema.systemSetting.key, set: { value: input } });
    await recordAudit(tx, actor, {
      action: "system.bans_update",
      targetType: "system_setting",
      targetId: SETTINGS_KEY,
      metadata: { from: before, to: input },
    });
    return input;
  });
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
      createdBy: ban.createdBy ?? null,
      createdAt: ban.createdAt.toISOString(),
      expiresAt: ban.expiresAt.toISOString(),
      seq: ban.seq.toString(),
      distributed: ban.distributed,
      unappliedNodes: unapplied.get(ban.id) ?? 0,
    }),
  );
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
 * ban counts against the platform total.
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
    await lockBans(tx);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.durationSeconds * 1000);
    const [existing] = await tx
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
    const renewal = !!existing && existing.expiresAt > now;
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
          // An expired entry that is banned again starts over.
          ...(renewal ? {} : { createdAt: now, createdBy }),
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
    await lockBans(tx);
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
  /** The node's own automatic bans, never distributed, lifted on this page. */
  liftedOwn: BanRow[];
  sequence: bigint;
  more: boolean;
}

/**
 * One page of the ban changes a node sees: bans of its cluster and platform
 * bans that are distributed, and its own automatic bans that were never
 * distributed once they are lifted (only the node holds them). From 0, or
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
    await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtext(${LOCK_KEY}))`);
    const current = await currentBanSequence(tx);
    const reset = afterSequence === 0n || afterSequence > current;
    const distributed = and(
      or(isNull(schema.ipBan.clusterId), eq(schema.ipBan.clusterId, node.clusterId)),
      eq(schema.ipBan.distributed, true),
    );
    const ownLifted = and(
      eq(schema.ipBan.source, "auto"),
      eq(schema.ipBan.nodeId, node.id),
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
      // Expired ones are gone from the node already.
      liftedOwn: page.filter(
        (row) => row.removedAt !== null && !row.distributed && row.expiresAt > now,
      ),
      sequence: more ? (page.at(-1)?.seq ?? current) : current,
      more,
    };
  });
}

export interface ReportedAutoBan {
  siteId: string;
  cidr: string;
  createdAt: Date | null;
  expiresAt: Date | null;
  reason: string;
  metric: string;
  observed: number;
  threshold: number;
  windowSeconds: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METRIC_RE = /^[a-z0-9_]{1,32}$/;
const finite = (value: number) => (Number.isFinite(value) ? value : 0);

/**
 * Stores automatic bans a node reported, keyed by (node, site, CIDR): an
 * active entry keeps the later expiry. Bans of sites outside the node's
 * cluster, prefixes other than an IPv4 address or an IPv6 /64 (or /128 of
 * older nodes), unknown reasons, protected addresses and
 * expired bans are skipped; expiry is capped at 7 days after creation.
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
      siteId: string;
      cidr: ReturnType<typeof parseBanCidr> & { ok: true };
      createdAt: Date;
      expiresAt: Date;
      reason: string;
      trigger: NonNullable<BanRow["trigger"]>;
    }
  >();
  for (const ban of reported) {
    if (!UUID_RE.test(ban.siteId)) continue;
    if (!(AUTO_BAN_REASONS as readonly string[]).includes(ban.reason)) continue;
    const cidr = parseBanCidr(ban.cidr);
    if (!cidr.ok || !isAutoBanPrefix(cidr.cidr)) continue;
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
    const key = `${ban.siteId.toLowerCase()}|${cidr.text}`;
    const previous = items.get(key);
    if (previous && previous.expiresAt >= expiresAt) continue;
    items.set(key, {
      siteId: ban.siteId.toLowerCase(),
      cidr,
      createdAt: created,
      expiresAt,
      reason: ban.reason,
      trigger: {
        metric: METRIC_RE.test(ban.metric) ? ban.metric : "",
        observed: finite(ban.observed),
        threshold: finite(ban.threshold),
        windowSeconds: Math.max(0, Math.min(Math.trunc(finite(ban.windowSeconds)), 86400)),
      },
    });
  }
  if (items.size === 0) return 0;
  // The node and allow-list addresses are parsed once and checked outside
  // the ban lock: a report of many bans against a long allow list must not
  // hold up every other ban writer and reader.
  const isProtected = protectedBanRanges(await protectedAddresses(db, node.clusterId));
  const candidates = [...items.values()].filter((item) => !isProtected(item.cidr.cidr));
  if (candidates.length === 0) return 0;
  return db.transaction(async (tx) => {
    await lockBans(tx);
    const { shareAutoBans } = await getBanSettings(tx);
    const siteIds = [...new Set(candidates.map((item) => item.siteId))];
    const sites = new Map(
      (
        await tx
          .select({ id: schema.site.id })
          .from(schema.site)
          .where(and(inArray(schema.site.id, siteIds), eq(schema.site.clusterId, node.clusterId)))
      ).map((site) => [site.id, site]),
    );
    const accepted = candidates.filter((item) => sites.has(item.siteId));
    if (accepted.length === 0) return 0;
    const existing = new Map(
      (
        await tx
          .select()
          .from(schema.ipBan)
          .where(
            and(
              eq(schema.ipBan.source, "auto"),
              eq(schema.ipBan.nodeId, node.id),
              isNull(schema.ipBan.removedAt),
              inArray(schema.ipBan.siteId, [...new Set(accepted.map((item) => item.siteId))]),
              inArray(schema.ipBan.cidr, [...new Set(accepted.map((item) => item.cidr.text))]),
            ),
          )
          .for("update")
      ).map((row) => [`${row.siteId}|${row.cidr}`, row]),
    );
    let changed = false;
    let added = false;
    const inserts: (typeof schema.ipBan.$inferInsert)[] = [];
    for (const item of accepted) {
      const row = existing.get(`${item.siteId}|${item.cidr.text}`);
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
          source: "auto",
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
    return accepted.length;
  });
}

/**
 * Keeps at most MAX_AUTO_BANS_PER_CLUSTER active automatic bans in a
 * cluster: older ones are lifted (distributed, so nodes learn it) or deleted
 * (never sent). Returns whether distributed bans were lifted.
 */
async function capAutoBans(tx: Executor, clusterId: string, now: Date): Promise<boolean> {
  const overflow = await tx
    .select({ id: schema.ipBan.id, distributed: schema.ipBan.distributed })
    .from(schema.ipBan)
    .where(and(eq(schema.ipBan.clusterId, clusterId), eq(schema.ipBan.source, "auto"), active(now)))
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
    await lockBans(tx);
    return deleteInBatches(
      tx,
      schema.ipBan,
      lt(schema.ipBan.expiresAt, new Date(now.getTime() - BAN_RETENTION_MS)),
    );
  });
}
