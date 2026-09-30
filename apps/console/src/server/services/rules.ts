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
} from "@edgeweir/rule-engine";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import { assertOrgLimit } from "./organization-limits";
import { type Executor, publishRevision } from "./revisions";
import { findSite, type SiteScope } from "./sites";

export interface RuleContext {
  scope: SiteScope;
  actor: Actor;
  organizationId: string | null;
}
const ruleScope = (siteId: string | null) =>
  siteId ? eq(schema.edgeRule.siteId, siteId) : isNull(schema.edgeRule.siteId);
const listScope = (orgId: string | null) =>
  orgId ? eq(schema.ipList.organizationId, orgId) : isNull(schema.ipList.organizationId);
const dto = (row: typeof schema.ipList.$inferSelect): IpListDto => ({
  id: row.id,
  name: row.name,
  entries: row.entries,
  kind: row.kind as IpListDto["kind"],
  platform: row.organizationId === null,
});

export async function availableLists(db: Executor, organizationId: string | null, lock = false) {
  const query = db
    .select()
    .from(schema.ipList)
    .where(
      organizationId
        ? or(eq(schema.ipList.organizationId, organizationId), isNull(schema.ipList.organizationId))
        : isNull(schema.ipList.organizationId),
    );
  return lock ? query.for("share") : query;
}
export async function getRules(
  app: AppContext,
  siteId: string | null,
  ctx: RuleContext,
): Promise<RuleDto[]> {
  if (siteId) await findSite(app.db, siteId, ctx.scope);
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
  ctx: RuleContext,
): Promise<RuleDto[]> {
  return app.db.transaction(async (tx) => {
    if (!siteId)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('edgeweir.platform-rules'))`);
    const site = siteId ? await findSite(tx, siteId, ctx.scope, true) : null;
    const lists = await availableLists(tx, site?.organizationId ?? null, true);
    const bindings: Record<string, string> = Object.create(null);
    for (const list of lists.filter((l) => !l.organizationId)) bindings[list.name] = list.id;
    for (const list of lists.filter((l) => l.organizationId)) bindings[list.name] = list.id;
    const rows = rules.map((rule, priority) => {
      const expression = parseExpression(rule.expression, rule.phase);
      const names = listReferences(expression);
      if (names.some((name) => !bindings[name]))
        fail("IP_LIST_NOT_FOUND", "expression references an unavailable IP list");
      return {
        id: rule.id ?? randomUUID(),
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
    if (new Set(rows.map((r) => r.id)).size !== rows.length)
      fail("RULE_INVALID", "duplicate rule ID");
    await tx.delete(schema.edgeRule).where(ruleScope(siteId));
    if (rows.length) await tx.insert(schema.edgeRule).values(rows);
    const clusters = site
      ? [{ id: site.clusterId }]
      : await tx.select({ id: schema.cluster.id }).from(schema.cluster).orderBy(schema.cluster.id);
    for (const cluster of clusters)
      await publishRevision(tx, {
        clusterId: cluster.id,
        reason: { code: "rules_updated", params: {} },
        userId: ctx.actor.id,
      });
    await recordAudit(tx, ctx.actor, {
      action: siteId ? "site.rules_update" : "platform.rules_update",
      organizationId: site?.organizationId,
      targetType: siteId ? "site" : "platform",
      targetId: siteId ?? "",
      targetName: site?.name ?? "",
      metadata: { count: rows.length },
    });
    return rows.map((row) => ruleDto.parse(row));
  });
}
export function validateExpression(expression: string, phase: Phase) {
  try {
    parseExpression(expression, phase);
    return { valid: true, position: 0, message: "" };
  } catch (error) {
    return {
      valid: false,
      position: error instanceof ExpressionError ? error.position : 0,
      message: "invalid_expression",
    };
  }
}
export async function listIpLists(app: AppContext, organizationId: string | null) {
  return (
    await app.db
      .select()
      .from(schema.ipList)
      .where(listScope(organizationId))
      .orderBy(schema.ipList.name)
  ).map(dto);
}
async function checkListQuota(
  tx: Executor,
  organizationId: string | null,
  entries: number,
  replaceId?: string,
) {
  const rows = await tx
    .select({ id: schema.ipList.id, entries: schema.ipList.entries })
    .from(schema.ipList)
    .where(listScope(organizationId));
  if (
    (!replaceId && rows.length >= 128) ||
    rows
      .filter((row) => row.id !== replaceId)
      .reduce((count, row) => count + row.entries.length, entries) > 50000
  )
    fail("IP_LIST_LIMIT", "IP list quota reached");
}
async function publishListChange(tx: Executor, userId: string, organizationId: string | null) {
  const clusters = organizationId
    ? await tx
        .selectDistinct({ id: schema.site.clusterId })
        .from(schema.site)
        .where(eq(schema.site.organizationId, organizationId))
        .orderBy(schema.site.clusterId)
    : await tx.select({ id: schema.cluster.id }).from(schema.cluster).orderBy(schema.cluster.id);
  for (const cluster of clusters)
    await publishRevision(tx as Parameters<typeof publishRevision>[0], {
      clusterId: cluster.id,
      reason: { code: "rules_updated", params: {} },
      userId,
    });
}
export async function createIpList(
  app: AppContext,
  input: IpListInput,
  organizationId: string | null,
  actor: Actor,
) {
  return app.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`edgeweir.ip-lists.${organizationId ?? "platform"}`}))`,
    );
    await checkListQuota(tx, organizationId, input.entries.length);
    if (organizationId)
      await assertOrgLimit(tx, organizationId, "ipListEntries", input.entries.length);
    const existing = await tx
      .select({ id: schema.ipList.id })
      .from(schema.ipList)
      .where(and(listScope(organizationId), eq(schema.ipList.name, input.name)))
      .limit(1);
    if (existing.length) fail("IP_LIST_NAME_TAKEN", "IP list name already exists");
    const [row] = await tx
      .insert(schema.ipList)
      .values({ ...input, organizationId })
      .returning();
    if (!row) throw new Error("IP list insert failed");
    await publishListChange(tx, actor.id, organizationId);
    await recordAudit(tx, actor, {
      action: "ip_list.create",
      organizationId,
      targetType: "ip_list",
      targetId: row.id,
      targetName: row.name,
      metadata: { entries: row.entries.length, platform: organizationId === null },
    });
    return dto(row);
  });
}
export async function updateIpList(
  app: AppContext,
  id: string,
  entries: string[],
  kind: IpListDto["kind"],
  organizationId: string | null,
  actor: Actor,
) {
  return app.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`edgeweir.ip-lists.${organizationId ?? "platform"}`}))`,
    );
    const [row] = await tx
      .select()
      .from(schema.ipList)
      .where(and(eq(schema.ipList.id, id), listScope(organizationId)))
      .for("update");
    if (!row) fail("IP_LIST_NOT_FOUND", "IP list not found");
    await checkListQuota(tx, organizationId, entries.length, id);
    if (organizationId)
      await assertOrgLimit(
        tx,
        organizationId,
        "ipListEntries",
        entries.length - row.entries.length,
      );
    const [updated] = await tx
      .update(schema.ipList)
      .set({ entries, kind })
      .where(eq(schema.ipList.id, id))
      .returning();
    if (!updated) throw new Error("IP list disappeared");
    await publishListChange(tx, actor.id, organizationId);
    await recordAudit(tx, actor, {
      action: "ip_list.update",
      organizationId,
      targetType: "ip_list",
      targetId: id,
      targetName: row.name,
      metadata: { entries: entries.length },
    });
    return dto(updated);
  });
}
export async function deleteIpList(
  app: AppContext,
  id: string,
  organizationId: string | null,
  actor: Actor,
) {
  return app.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${`edgeweir.ip-lists.${organizationId ?? "platform"}`}))`,
    );
    const [row] = await tx
      .select()
      .from(schema.ipList)
      .where(and(eq(schema.ipList.id, id), listScope(organizationId)))
      .for("update");
    if (!row) fail("IP_LIST_NOT_FOUND", "IP list not found");
    const refs = await tx
      .select({ id: schema.edgeRule.id })
      .from(schema.edgeRule)
      .where(sql`${id}::uuid = any(${schema.edgeRule.listIds})`)
      .limit(1);
    if (refs.length) fail("IP_LIST_IN_USE", "IP list is referenced by a rule");
    await tx.delete(schema.ipList).where(eq(schema.ipList.id, id));
    await publishListChange(tx, actor.id, organizationId);
    await recordAudit(tx, actor, {
      action: "ip_list.delete",
      organizationId,
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
