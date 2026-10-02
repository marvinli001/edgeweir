import { randomUUID } from "node:crypto";
import {
  type IpListDto,
  type IpListInput,
  type RuleDto,
  type RuleInput,
  ruleDto,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import {
  type Expression,
  ExpressionError,
  listReferences,
  type Phase,
  parseExpression,
  parseValueExpression,
} from "@edgeweir/rule-engine";
import { asc, eq, isNull, sql } from "drizzle-orm";
import { parseCacheCondition } from "../lib/cache-conditions";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { lockIpLists, lockPlatformRules } from "../lib/locks";
import { type Actor, recordAudit } from "./audit";
import { listBindings } from "./config-input";
import { type Executor, publishClusters } from "./revisions";
import { findSite } from "./sites";

const ruleScope = (siteId: string | null) =>
  siteId ? eq(schema.edgeRule.siteId, siteId) : isNull(schema.edgeRule.siteId);
const dto = (row: typeof schema.ipList.$inferSelect): IpListDto => ({
  id: row.id,
  name: row.name,
  entries: row.entries,
  kind: row.kind as IpListDto["kind"],
});

/** Every IP list (rules of any site may use them), share-locked on request. */
export async function availableLists(db: Executor, lock = false) {
  const query = db.select().from(schema.ipList);
  return lock ? query.for("share") : query;
}

/** The origin groups of a site ("" is the default group). */
export async function siteOriginGroups(db: Executor, siteId: string): Promise<Set<string>> {
  const rows = await db
    .selectDistinct({ group: schema.origin.groupName })
    .from(schema.origin)
    .innerJoin(schema.originPool, eq(schema.originPool.id, schema.origin.poolId))
    .where(eq(schema.originPool.siteId, siteId));
  return new Set(rows.map((row) => row.group));
}

/** The origin group an origin action names, or "" (the default group, or another kind). */
export const actionOriginGroup = (action: unknown): string => {
  const a = action as { kind?: unknown; originGroup?: unknown };
  return a.kind === "origin" && typeof a.originGroup === "string" ? a.originGroup : "";
};
export async function getRules(app: AppContext, siteId: string | null): Promise<RuleDto[]> {
  if (siteId) await findSite(app.db, siteId);
  const rows = await app.db
    .select()
    .from(schema.edgeRule)
    .where(ruleScope(siteId))
    .orderBy(asc(schema.edgeRule.priority));
  return rows.map((row) => ruleDto.parse(row));
}
export async function saveRules(
  app: AppContext,
  siteId: string | null,
  rules: RuleInput[],
  ctx: { actor: Actor },
): Promise<RuleDto[]> {
  return app.db.transaction(async (tx) => {
    if (!siteId) await lockPlatformRules(tx);
    const site = siteId ? await findSite(tx, siteId, true) : null;
    const bindings = listBindings(await availableLists(tx, true));
    // Origin rules choose among the site's origin groups; the platform has no origins.
    const groups = siteId ? await siteOriginGroups(tx, siteId) : new Set<string>();
    for (const rule of rules) {
      const group = actionOriginGroup(rule.action);
      if (group && !siteId)
        fail("RULE_INVALID", `rule ${rule.name}: platform rules cannot choose an origin group`);
      if (group && !groups.has(group))
        fail("RULE_INVALID", `rule ${rule.name}: the site has no origin group ${group}`);
    }
    const ids = rules.flatMap((rule) => (rule.id ? [rule.id] : []));
    if (new Set(ids).size !== ids.length) fail("RULE_INVALID", "duplicate rule ID");
    // Ids of this scope's rules are kept; any other id (e.g. rules copied
    // from another site) gets a new one, since ids are unique platform-wide.
    const owned = new Set(
      (
        await tx.select({ id: schema.edgeRule.id }).from(schema.edgeRule).where(ruleScope(siteId))
      ).map((row) => row.id),
    );
    const rows = rules.map((rule, priority) => {
      const expression = parseExpression(rule.expression, rule.phase);
      const names = listReferences(expression);
      failUnknownLists(names.filter((name) => !bindings[name]));
      return {
        id: rule.id && owned.has(rule.id) ? rule.id : randomUUID(),
        siteId,
        name: rule.name,
        phase: rule.phase,
        expression: rule.expression,
        enabled: rule.enabled,
        priority,
        action: rule.action as Record<string, unknown>,
        listIds: names.map((name) => bindings[name] as string),
      };
    });
    await tx.delete(schema.edgeRule).where(ruleScope(siteId));
    if (rows.length) await tx.insert(schema.edgeRule).values(rows);
    const clusters = site
      ? [{ id: site.clusterId }]
      : await tx.select({ id: schema.cluster.id }).from(schema.cluster);
    await publishClusters(
      tx,
      clusters.map((c) => c.id),
      {
        reason: { code: "rules_updated", params: {} },
        actor: ctx.actor,
        site: site?.id,
      },
    );
    await recordAudit(tx, ctx.actor, {
      action: siteId ? "site.rules_update" : "platform.rules_update",
      targetType: siteId ? "site" : "platform",
      targetId: siteId ?? "",
      targetName: site?.name ?? "",
      metadata: { count: rows.length },
    });
    return rows.map((row) => ruleDto.parse(row));
  });
}
/**
 * Checks a rule condition (kind condition), a redirect target or rewrite path
 * (kind value) of `phase`, or a cache rule condition (kind cacheRule).
 */
export function validateExpression(
  expression: string,
  phase: Phase,
  kind: "condition" | "value" | "cacheRule" = "condition",
) {
  try {
    if (kind === "value") parseValueExpression(expression, phase);
    else if (kind === "cacheRule") parseCacheCondition(expression);
    else parseExpression(expression, phase);
    return { valid: true, position: 0, message: "" };
  } catch (error) {
    if (!(error instanceof ExpressionError))
      return { valid: false, position: 0, message: "invalid expression" };
    return {
      valid: false,
      position: error.position,
      message: error.message,
      code: error.code,
      params: { ...error.params },
    };
  }
}
export async function listIpLists(app: AppContext) {
  return (await app.db.select().from(schema.ipList).orderBy(schema.ipList.name)).map(dto);
}
/** At most 128 lists and 50000 entries in all; a change that does not grow them always fits. */
async function checkListQuota(
  tx: Executor,
  entries: number,
  replace?: { id: string; entries: number },
) {
  const rows = await tx
    .select({ id: schema.ipList.id, entries: schema.ipList.entries })
    .from(schema.ipList);
  const others = rows
    .filter((row) => row.id !== replace?.id)
    .reduce((count, row) => count + row.entries.length, 0);
  if (
    (!replace && rows.length >= 128) ||
    (others + entries > 50000 && entries > (replace?.entries ?? 0))
  )
    fail("IP_LIST_LIMIT", "IP list quota reached");
}
/** Lists reach every cluster: rules of any site, and allow and block lists, use them. */
async function publishListChange(tx: Executor, actor: Actor) {
  const clusters = await tx.select({ id: schema.cluster.id }).from(schema.cluster);
  await publishClusters(
    tx as Parameters<typeof publishClusters>[0],
    clusters.map((c) => c.id),
    { reason: { code: "rules_updated", params: {} }, actor },
  );
}
/** Refuses expressions that reference lists no one created (IP_LIST_REFERENCE_UNKNOWN). */
export function failUnknownLists(names: string[]): void {
  if (!names.length) return;
  const lists = [...new Set(names)].slice(0, 5).join(", ");
  fail("IP_LIST_REFERENCE_UNKNOWN", `unknown IP lists: ${lists}`, { lists });
}
/**
 * What uses a list, the first five: rules ("name (site)" for site rules), sites whose cache
 * rules reference it, and L4 applications.
 */
async function listUsers(tx: Executor, id: string): Promise<string[]> {
  const uses = (column: unknown) => sql`${id}::uuid = any(${column})`;
  const rules = await tx
    .select({ name: schema.edgeRule.name, site: schema.site.name })
    .from(schema.edgeRule)
    .leftJoin(schema.site, eq(schema.site.id, schema.edgeRule.siteId))
    .where(uses(schema.edgeRule.listIds))
    .orderBy(sql`${schema.site.name} nulls first`, asc(schema.edgeRule.priority))
    .limit(5);
  const sites = await tx
    .selectDistinct({ name: schema.site.name })
    .from(schema.cacheRule)
    .innerJoin(schema.site, eq(schema.site.id, schema.cacheRule.siteId))
    .where(uses(schema.cacheRule.listIds))
    .orderBy(asc(schema.site.name))
    .limit(5);
  const apps = await tx
    .select({ name: schema.l4App.name })
    .from(schema.l4App)
    .where(sql`${uses(schema.l4App.allowListIds)} or ${uses(schema.l4App.blockListIds)}`)
    .orderBy(asc(schema.l4App.name))
    .limit(5);
  return [
    ...new Set([
      ...rules.map((rule) => (rule.site ? `${rule.name} (${rule.site})` : rule.name)),
      ...sites.map((site) => site.name),
      ...apps.map((app) => app.name),
    ]),
  ].slice(0, 5);
}
export async function createIpList(app: AppContext, input: IpListInput, actor: Actor) {
  return app.db.transaction(async (tx) => {
    await lockIpLists(tx);
    await checkListQuota(tx, input.entries.length);
    const existing = await tx
      .select({ id: schema.ipList.id })
      .from(schema.ipList)
      .where(eq(schema.ipList.name, input.name))
      .limit(1);
    if (existing.length) fail("IP_LIST_NAME_TAKEN", "IP list name already exists");
    const [row] = await tx.insert(schema.ipList).values(input).returning();
    if (!row) throw new Error("IP list insert failed");
    await publishListChange(tx, actor);
    await recordAudit(tx, actor, {
      action: "ip_list.create",
      targetType: "ip_list",
      targetId: row.id,
      targetName: row.name,
      metadata: { entries: row.entries.length, kind: row.kind },
    });
    return dto(row);
  });
}
export async function updateIpList(
  app: AppContext,
  id: string,
  entries: string[],
  kind: IpListDto["kind"],
  actor: Actor,
) {
  return app.db.transaction(async (tx) => {
    await lockIpLists(tx);
    const [row] = await tx
      .select()
      .from(schema.ipList)
      .where(eq(schema.ipList.id, id))
      .for("update");
    if (!row) fail("IP_LIST_NOT_FOUND", "IP list not found");
    await checkListQuota(tx, entries.length, { id, entries: row.entries.length });
    const [updated] = await tx
      .update(schema.ipList)
      .set({ entries, kind })
      .where(eq(schema.ipList.id, id))
      .returning();
    if (!updated) throw new Error("IP list disappeared");
    await publishListChange(tx, actor);
    await recordAudit(tx, actor, {
      action: "ip_list.update",
      targetType: "ip_list",
      targetId: id,
      targetName: row.name,
      metadata: { entries: entries.length, kind },
    });
    return dto(updated);
  });
}
export async function deleteIpList(app: AppContext, id: string, actor: Actor) {
  return app.db.transaction(async (tx) => {
    await lockIpLists(tx);
    const [row] = await tx
      .select()
      .from(schema.ipList)
      .where(eq(schema.ipList.id, id))
      .for("update");
    if (!row) fail("IP_LIST_NOT_FOUND", "IP list not found");
    const users = (await listUsers(tx, id)).join(", ");
    if (users) fail("IP_LIST_IN_USE", `IP list is used by ${users}`, { users });
    await tx.delete(schema.ipList).where(eq(schema.ipList.id, id));
    await publishListChange(tx, actor);
    await recordAudit(tx, actor, {
      action: "ip_list.delete",
      targetType: "ip_list",
      targetId: id,
      targetName: row.name,
    });
    return { ok: true as const };
  });
}

export function expressionFields(expression: Expression): string[] {
  return [expression.field, ...expression.children.flatMap(expressionFields)];
}
