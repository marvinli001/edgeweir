import { randomInt } from "node:crypto";
import { CNAME_PREFIX_RE, CNAME_RETIRE_HOURS, type CnamePrefixState } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, asc, eq, gt, inArray, lte, or } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { lockCnamePrefixes } from "../lib/locks";
import { type Actor, recordAudit } from "./audit";
import { cnameClaimed, publishClusterDns } from "./dns";
import type { Executor, Tx } from "./revisions";

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const ALPHANUMERIC = `${LETTERS}0123456789`;
const RETIRE_MS = CNAME_RETIRE_HOURS * 3600_000;
/** Record names DNS bindings use beside the prefixes: the all-lines record and its migrated forms. */
const RESERVED_RE = /^all(?:-\d+)?$/;

/** 8 random characters, a lowercase letter first, then letters and digits. */
export function randomCnamePrefix(): string {
  let prefix = LETTERS[randomInt(LETTERS.length)] ?? "a";
  while (prefix.length < 8) prefix += ALPHANUMERIC[randomInt(ALPHANUMERIC.length)] ?? "0";
  return prefix;
}

type Owner = { site: string } | { app: string };

/**
 * Whether `prefix` is free for `owner` (null: a new site or application):
 * no other site or application has it, no other one still resolves it
 * (retired), it is not `all` / `all-<n>` and no DNS binding uses it as its
 * all-lines record or a line name. The caller holds lockCnamePrefixes.
 */
async function prefixFree(tx: Executor, prefix: string, owner: Owner | null) {
  if (RESERVED_RE.test(prefix)) return false;
  const [site] = await tx
    .select({ id: schema.site.id })
    .from(schema.site)
    .where(eq(schema.site.cnamePrefix, prefix));
  if (site && !(owner && "site" in owner && owner.site === site.id)) return false;
  const [app] = await tx
    .select({ id: schema.l4App.id })
    .from(schema.l4App)
    .where(eq(schema.l4App.cnamePrefix, prefix));
  if (app && !(owner && "app" in owner && owner.app === app.id)) return false;
  const [retired] = await tx
    .select({ siteId: schema.cnameRetired.siteId, appId: schema.cnameRetired.l4AppId })
    .from(schema.cnameRetired)
    .where(eq(schema.cnameRetired.prefix, prefix));
  if (
    retired &&
    !(owner && "site" in owner && retired.siteId === owner.site) &&
    !(owner && "app" in owner && retired.appId === owner.app)
  )
    return false;
  const bindings = await tx
    .select({ allLabel: schema.dnsBinding.allLabel, lines: schema.dnsBinding.lines })
    .from(schema.dnsBinding);
  return !bindings.some(
    (b) => b.allLabel === prefix || b.lines.some((line) => line.name === prefix),
  );
}

/** A random prefix nobody uses, for a new site or application (takes lockCnamePrefixes). */
export async function newCnamePrefix(tx: Tx): Promise<string> {
  await lockCnamePrefixes(tx);
  for (let attempt = 0; attempt < 16; attempt++) {
    const prefix = randomCnamePrefix();
    if (await prefixFree(tx, prefix, null)) return prefix;
  }
  throw new Error("no free CNAME prefix");
}

/**
 * Every prefix in use or still resolving, for checks of DNS binding line
 * names (DNS_BINDING_CONFLICT). The caller holds lockCnamePrefixes.
 */
export async function usedCnamePrefixes(tx: Executor): Promise<Set<string>> {
  const sites = await tx.select({ prefix: schema.site.cnamePrefix }).from(schema.site);
  const apps = await tx.select({ prefix: schema.l4App.cnamePrefix }).from(schema.l4App);
  const retired = await tx.select({ prefix: schema.cnameRetired.prefix }).from(schema.cnameRetired);
  return new Set([...sites, ...apps, ...retired].map((r) => r.prefix));
}

/** Replaced prefixes of a site or application that still resolve, earliest expiry first. */
export async function retiredPrefixes(db: Executor, owner: Owner, now = new Date()) {
  const rows = await db
    .select({ prefix: schema.cnameRetired.prefix, expiresAt: schema.cnameRetired.expiresAt })
    .from(schema.cnameRetired)
    .where(
      and(
        "site" in owner
          ? eq(schema.cnameRetired.siteId, owner.site)
          : eq(schema.cnameRetired.l4AppId, owner.app),
        gt(schema.cnameRetired.expiresAt, now),
      ),
    )
    .orderBy(asc(schema.cnameRetired.expiresAt), asc(schema.cnameRetired.prefix));
  return rows;
}

/** Replaced prefixes of many owners that still resolve, by site or application id. */
export async function retiredPrefixesOf(db: Executor, ids: string[], now = new Date()) {
  const out = new Map<string, { prefix: string; expiresAt: Date }[]>();
  if (!ids.length) return out;
  const rows = await db
    .select()
    .from(schema.cnameRetired)
    .where(
      and(
        or(inArray(schema.cnameRetired.siteId, ids), inArray(schema.cnameRetired.l4AppId, ids)),
        gt(schema.cnameRetired.expiresAt, now),
      ),
    )
    .orderBy(asc(schema.cnameRetired.expiresAt), asc(schema.cnameRetired.prefix));
  for (const row of rows) {
    const id = row.siteId ?? row.l4AppId ?? "";
    out.set(id, [...(out.get(id) ?? []), { prefix: row.prefix, expiresAt: row.expiresAt }]);
  }
  return out;
}

/**
 * Sets the CNAME prefix of a site or layer-4 application (a new random one
 * without `prefix`). The replaced prefix keeps resolving for 24 hours
 * (cname_retired) unless the cluster's automatic DNS never published it;
 * taking back a prefix of the same owner still resolving ends that, and
 * is how an object from before CNAME prefixes gets its id back (the only
 * prefix outside CNAME_PREFIX_RE it may take, CNAME_PREFIX_INVALID
 * otherwise). Publishes the cluster's DNS (reason cname) and audits
 * site.cname_update / l4.cname_update.
 */
export async function setCnamePrefix(
  app: AppContext,
  owner: Owner,
  prefix: string | undefined,
  actor: Actor,
  now = new Date(),
): Promise<CnamePrefixState> {
  return app.db.transaction(async (tx) => {
    // The object's row first, then the prefixes (the order of site create
    // and update, which lock domains before prefixes).
    const row =
      "site" in owner
        ? (
            await tx
              .select({
                id: schema.site.id,
                name: schema.site.name,
                clusterId: schema.site.clusterId,
                prefix: schema.site.cnamePrefix,
              })
              .from(schema.site)
              .where(eq(schema.site.id, owner.site))
              .for("update")
          )[0]
        : (
            await tx
              .select({
                id: schema.l4App.id,
                name: schema.l4App.name,
                clusterId: schema.l4App.clusterId,
                prefix: schema.l4App.cnamePrefix,
              })
              .from(schema.l4App)
              .where(eq(schema.l4App.id, owner.app))
              .for("update")
          )[0];
    if (!row) {
      if ("site" in owner) fail("SITE_NOT_FOUND", "site not found");
      fail("L4_APP_NOT_FOUND", "layer-4 application not found");
    }
    await lockCnamePrefixes(tx);
    if (prefix !== undefined && !CNAME_PREFIX_RE.test(prefix)) {
      const own =
        prefix === row.id ||
        (await retiredPrefixes(tx, owner, now)).some((retired) => retired.prefix === prefix);
      if (!own) fail("CNAME_PREFIX_INVALID", `invalid CNAME prefix ${prefix}`, { prefix });
    }
    let next = prefix;
    if (next === undefined) {
      for (let attempt = 0; next === undefined && attempt < 16; attempt++) {
        const candidate = randomCnamePrefix();
        if (await prefixFree(tx, candidate, null)) next = candidate;
      }
      if (next === undefined) throw new Error("no free CNAME prefix");
    } else if (next !== row.prefix && !(await prefixFree(tx, next, owner))) {
      fail("CNAME_PREFIX_CONFLICT", `CNAME prefix ${next} is not available`, { prefix: next });
    }
    if (next !== row.prefix) {
      // Taking a still-resolving prefix back ends its retirement.
      await tx
        .delete(schema.cnameRetired)
        .where(
          and(
            eq(schema.cnameRetired.prefix, next),
            "site" in owner
              ? eq(schema.cnameRetired.siteId, owner.site)
              : eq(schema.cnameRetired.l4AppId, owner.app),
          ),
        );
      // A name the cluster's automatic DNS never published resolves
      // nowhere: nothing depends on it, and one that collides with a record
      // of the zone must not hold up the cluster's DNS for 24 hours.
      if ((await cnameClaimed(tx, row.clusterId, row.prefix)) !== false)
        await tx
          .insert(schema.cnameRetired)
          .values({
            clusterId: row.clusterId,
            ...("site" in owner ? { siteId: owner.site } : { l4AppId: owner.app }),
            prefix: row.prefix,
            expiresAt: new Date(now.getTime() + RETIRE_MS),
          })
          .onConflictDoUpdate({
            target: schema.cnameRetired.prefix,
            set: { expiresAt: new Date(now.getTime() + RETIRE_MS) },
          });
      if ("site" in owner)
        await tx.update(schema.site).set({ cnamePrefix: next }).where(eq(schema.site.id, row.id));
      else
        await tx.update(schema.l4App).set({ cnamePrefix: next }).where(eq(schema.l4App.id, row.id));
      await recordAudit(tx, actor, {
        action: "site" in owner ? "site.cname_update" : "l4.cname_update",
        targetType: "site" in owner ? "site" : "l4_app",
        targetId: row.id,
        targetName: row.name,
        metadata: { from: row.prefix, to: next, generated: prefix === undefined },
      });
      await publishClusterDns(tx, row.clusterId, "cname", { name: row.name });
    }
    return {
      prefix: next,
      retired: (await retiredPrefixes(tx, owner, now)).map((r) => ({
        prefix: r.prefix,
        expiresAt: r.expiresAt.toISOString(),
      })),
    };
  });
}

/**
 * Deletes replaced prefixes whose 24 hours are over and publishes the DNS
 * of their clusters (reason cname_expired), which drops their records: one
 * cluster at a time, so a cluster whose DNS cannot be published keeps its
 * rows (and retries) without holding up the others. Returns the clusters
 * republished.
 */
export async function expireCnamePrefixes(app: AppContext, now = new Date()): Promise<string[]> {
  const due = await app.db
    .selectDistinct({ clusterId: schema.cnameRetired.clusterId })
    .from(schema.cnameRetired)
    .where(lte(schema.cnameRetired.expiresAt, now));
  const done: string[] = [];
  for (const clusterId of due.map((r) => r.clusterId).sort()) {
    try {
      await app.db.transaction(async (tx) => {
        await tx
          .delete(schema.cnameRetired)
          .where(
            and(
              eq(schema.cnameRetired.clusterId, clusterId),
              lte(schema.cnameRetired.expiresAt, now),
            ),
          );
        await publishClusterDns(tx, clusterId, "cname_expired");
      });
      done.push(clusterId);
    } catch (error) {
      app.log.warn("cannot drop the replaced CNAME prefixes of a cluster", {
        clusterId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return done;
}
