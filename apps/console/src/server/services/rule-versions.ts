import { isDeepStrictEqual } from "node:util";
import {
  DELETED_RULE_LIMIT,
  RULE_VERSION_LIMIT,
  type RuleVersion,
  type ruleVersionSources,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Actor } from "./audit";
import type { Executor } from "./revisions";
import { findSite } from "./sites";

export type RuleVersionSource = (typeof ruleVersionSources)[number];
type RuleState = Pick<
  typeof schema.edgeRule.$inferSelect,
  "id" | "name" | "phase" | "expression" | "enabled" | "action"
>;

const version = schema.edgeRuleVersion;
const versionScope = (siteId: string | null) =>
  siteId ? eq(version.siteId, siteId) : isNull(version.siteId);

/** What a version keeps of a rule (its id and position are not part of it). */
const stateOf = (rule: RuleState) =>
  JSON.parse(
    JSON.stringify({
      name: rule.name,
      phase: rule.phase,
      expression: rule.expression,
      enabled: rule.enabled,
      action: rule.action,
    }),
  ) as Record<string, unknown>;

/** Who saved: the console (a session) or the API (an AccessKey or a service account). */
export const sourceOf = (actor: Actor): RuleVersionSource => (actor.type === "user" ? "ui" : "api");

/**
 * Records the versions a write of a scope's rules made (ADR-0054): rules
 * that are new, changed (not only moved) or gone, numbered after each rule's
 * last version, then prunes the scope's history. `restored` marks the rule
 * a restore brought back and the version it came from.
 */
export async function recordRuleVersions(
  tx: Executor,
  siteId: string | null,
  before: readonly RuleState[],
  after: readonly RuleState[],
  ctx: {
    actor: Actor;
    source: RuleVersionSource;
    restored?: { ruleId: string; version: number };
  },
): Promise<void> {
  const previous = new Map(before.map((rule) => [rule.id, rule]));
  const kept = new Set(after.map((rule) => rule.id));
  const changes: { rule: RuleState; change: RuleVersion["change"] }[] = [];
  for (const rule of after) {
    const old = previous.get(rule.id);
    if (!old) changes.push({ rule, change: "created" });
    else if (!isDeepStrictEqual(stateOf(old), stateOf(rule)))
      changes.push({ rule, change: "updated" });
  }
  for (const rule of before) if (!kept.has(rule.id)) changes.push({ rule, change: "deleted" });
  if (!changes.length) return;
  const ids = changes.map(({ rule }) => rule.id);
  const tops = new Map(
    (
      await tx
        .select({ ruleId: version.ruleId, top: sql<number>`max(${version.version})::int` })
        .from(version)
        .where(inArray(version.ruleId, ids))
        .groupBy(version.ruleId)
    ).map((row) => [row.ruleId, row.top]),
  );
  await tx.insert(version).values(
    changes.map(({ rule, change }) => ({
      ruleId: rule.id,
      siteId,
      version: (tops.get(rule.id) ?? 0) + 1,
      change,
      source: ctx.source,
      restoredFrom: ctx.restored?.ruleId === rule.id ? ctx.restored.version : null,
      rule: stateOf(rule),
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      actorName: (ctx.actor.name ?? "").slice(0, 200),
    })),
  );
  await pruneRuleVersions(
    tx,
    siteId,
    ids,
    changes.some(({ change }) => change === "deleted"),
  );
}

/**
 * Keeps each rule's last RULE_VERSION_LIMIT versions and, after a deletion,
 * the scope's DELETED_RULE_LIMIT most recently deleted rules (older ones
 * lose their whole history).
 */
async function pruneRuleVersions(
  tx: Executor,
  siteId: string | null,
  ruleIds: string[],
  deleted: boolean,
) {
  await tx
    .delete(version)
    .where(
      and(
        inArray(version.ruleId, ruleIds),
        sql`${version.version} <= (select max(m.version) from edge_rule_version m where m.rule_id = "edge_rule_version"."rule_id") - ${RULE_VERSION_LIMIT}`,
      ),
    );
  if (!deleted) return;
  const gone = (await latestVersions(tx, siteId))
    .filter((row) => row.change === "deleted")
    .slice(DELETED_RULE_LIMIT)
    .map((row) => row.ruleId);
  if (gone.length) await tx.delete(version).where(inArray(version.ruleId, gone));
}

/** The last version of each rule of a scope that has versions, last saved first. */
async function latestVersions(db: Executor, siteId: string | null) {
  const rows = await db
    .selectDistinctOn([version.ruleId])
    .from(version)
    .where(versionScope(siteId))
    .orderBy(version.ruleId, desc(version.version));
  return rows.sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.ruleId < b.ruleId ? -1 : 1),
  );
}

const toDto = (row: typeof version.$inferSelect): RuleVersion => ({
  ruleId: row.ruleId,
  version: row.version,
  change: row.change as RuleVersion["change"],
  source: row.source as RuleVersion["source"],
  restoredFrom: row.restoredFrom,
  rule: row.rule as RuleVersion["rule"],
  actor: { type: row.actorType, id: row.actorId, name: row.actorName },
  createdAt: row.createdAt.toISOString(),
});

/** The kept versions of a rule of the scope, newest first (none for another scope's rule). */
export async function listRuleVersions(
  db: Executor,
  siteId: string | null,
  ruleId: string,
): Promise<RuleVersion[]> {
  if (siteId) await findSite(db, siteId);
  const rows = await db
    .select()
    .from(version)
    .where(and(versionScope(siteId), eq(version.ruleId, ruleId)))
    .orderBy(desc(version.version));
  return rows.map(toDto);
}

/** The scope's deleted rules as their last version, last deleted first. */
export async function listDeletedRules(
  db: Executor,
  siteId: string | null,
): Promise<RuleVersion[]> {
  if (siteId) await findSite(db, siteId);
  return (await latestVersions(db, siteId)).filter((row) => row.change === "deleted").map(toDto);
}

/** One kept version of a rule of the scope. */
export async function findRuleVersion(
  db: Executor,
  siteId: string | null,
  ruleId: string,
  number: number,
): Promise<RuleVersion | undefined> {
  const [row] = await db
    .select()
    .from(version)
    .where(and(versionScope(siteId), eq(version.ruleId, ruleId), eq(version.version, number)));
  return row ? toDto(row) : undefined;
}
