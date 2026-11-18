import { apiSecurityEnabled } from "@edgeweir/config-compiler";
import {
  API_SECURITY_FEATURE,
  API_SECURITY_LIMITS,
  type ApiSecurityResults,
  type ApiSecuritySettings,
  type ApiSecurityState,
  apiMethod,
  apiSecurityLog,
  nodeSupportsFeature,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, asc, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { readApiSecurity, validateApiSecurity } from "../lib/api-security";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { assertNodeFeatures } from "../lib/node-features";
import { assertUpdatedAt, nextUpdatedAt } from "../lib/updated-at";
import { type Actor, recordAudit } from "./audit";
import { queryClickHouseApiSecurityEvents } from "./clickhouse";
import type { Executor, Tx } from "./revisions";
import { publishSiteChange } from "./site-change";
import { findSite } from "./sites";

export { importOpenApi } from "./api-security-openapi";
export type ApiSecurityDetail = NonNullable<import("@edgeweir/contract").LogEntry["apiSecurity"]>;
export const API_SECURITY_TTL_MS = API_SECURITY_LIMITS.retentionDays * 86400000;
const TRAFFIC_WORDS = new Set(
  "api v1 v2 v3 v4 graphql query users user accounts account profile profiles auth login logout token tokens oauth sessions session orders order products product items item posts post comments comment search health status metrics events event files file upload uploads download downloads admin public private internal webhooks webhook me settings billing payments payment organizations organization teams team projects project resources resource reports report notifications notification assets static content data rest rpc".split(
    " ",
  ),
);
const ISSUE_CODES = new Set(
  "path-ambiguous check-deadline check-invalid policy-unavailable check-unavailable check-overloaded request-budget headers-budget header-duplicate header-invalid body-budget endpoint-unknown query-budget query-invalid query-duplicate parameter-type parameter-required body-required body-media-type json-invalid json-budget json-duplicate-key number-budget schema-type schema-enum schema-length schema-range schema-required schema-additional schema-items jwt-authorization jwt-budget jwt-invalid jwt-header jwt-unknown-kid jwt-algorithm graphql-media-type graphql-method graphql-envelope graphql-query-missing graphql-operation graphql-variables graphql-batch graphql-document-budget graphql-invalid graphql-token-budget graphql-parser-depth graphql-fragment-duplicate graphql-get-mutation graphql-fragment-budget graphql-fragment-unknown graphql-fragment-cycle graphql-expansion-budget graphql-fields graphql-depth graphql-aliases graphql-introspection".split(
    " ",
  ),
);

async function unsupportedNodes(db: Executor, clusterId: string) {
  const nodes = await db
    .select({ features: schema.node.supportedFeatures })
    .from(schema.node)
    .where(and(eq(schema.node.clusterId, clusterId), eq(schema.node.status, "active")));
  return nodes.filter((node) => !nodeSupportsFeature(node.features, API_SECURITY_FEATURE)).length;
}

export async function getApiSecurity(db: Database, id: string): Promise<ApiSecurityState> {
  const site = await findSite(db, id);
  return {
    settings: readApiSecurity(site.apiSecurity),
    updatedAt: site.updatedAt.toISOString(),
    unsupportedNodes: await unsupportedNodes(db, site.clusterId),
  };
}

export async function updateApiSecurity(
  db: Database,
  input: { id: string; settings: ApiSecuritySettings; expectedUpdatedAt?: string },
  actor: Actor,
): Promise<ApiSecurityState> {
  const settings = validateApiSecurity(input.settings);
  return db.transaction(async (tx) => {
    const site = await findSite(tx, input.id, true);
    assertUpdatedAt(site.updatedAt, input.expectedUpdatedAt);
    if (apiSecurityEnabled(settings))
      await assertNodeFeatures(
        tx,
        [site.clusterId],
        [API_SECURITY_FEATURE],
        "cluster nodes do not support API security",
      );
    const before = readApiSecurity(site.apiSecurity);
    const updatedAt = nextUpdatedAt(site.updatedAt);
    await tx
      .update(schema.site)
      .set({ apiSecurity: settings, updatedAt })
      .where(eq(schema.site.id, site.id));
    await publishSiteChange(tx, actor, site, {
      reason: "site_updated",
      action: "site.api_security_update",
      metadata: {
        discovery: settings.discovery.enabled,
        schemaMode: settings.schema.mode,
        jwtMode: settings.jwt.mode,
        graphqlMode: settings.graphql.mode,
        endpoints: settings.schema.endpoints.length,
        exceptions: settings.exceptions.length,
        enabledExceptions: settings.exceptions.filter((entry) => entry.enabled).length,
        exceptionIds: settings.exceptions.map((entry) => entry.id),
        removedExceptionIds: before.exceptions
          .filter((entry) => !settings.exceptions.some((next) => next.id === entry.id))
          .map((entry) => entry.id),
      },
    });
    return {
      settings,
      updatedAt: updatedAt.toISOString(),
      unsupportedNodes: await unsupportedNodes(tx, site.clusterId),
    };
  });
}

function endpointDto(
  row: typeof schema.siteApiEndpoint.$inferSelect,
): ApiSecurityResults["endpoints"][number] {
  return {
    id: row.id,
    method: apiMethod.parse(row.method),
    path: row.path,
    source: row.source as "traffic" | "schema" | "manual",
    confirmed: row.confirmed,
    firstSeen: row.firstSeen.toISOString(),
    lastSeen: row.lastSeen.toISOString(),
    sampledRequests: row.sampledRequests,
    violations: row.violations,
  };
}

export async function apiSecurityResults(
  app: AppContext,
  id: string,
  now = Date.now(),
): Promise<ApiSecurityResults> {
  const site = await findSite(app.db, id);
  const settings = readApiSecurity(site.apiSecurity);
  const from = new Date(now - API_SECURITY_TTL_MS);
  const endpoints = await app.db
    .select()
    .from(schema.siteApiEndpoint)
    .where(and(eq(schema.siteApiEndpoint.siteId, id), gte(schema.siteApiEndpoint.lastSeen, from)))
    .orderBy(
      desc(schema.siteApiEndpoint.confirmed),
      desc(schema.siteApiEndpoint.lastSeen),
      asc(schema.siteApiEndpoint.id),
    )
    .limit(API_SECURITY_LIMITS.candidates);
  const events =
    app.env.EDGEWEIR_ANALYTICS === "clickhouse"
      ? await queryClickHouseApiSecurityEvents(app.env, id, from.getTime(), now + 300000)
      : (
          await app.db
            .select({
              time: schema.accessLog.time,
              requestId: schema.accessLog.requestId,
              method: schema.accessLog.method,
              status: schema.accessLog.status,
              detail: schema.accessLog.apiSecurity,
            })
            .from(schema.accessLog)
            .where(
              and(
                eq(schema.accessLog.siteId, id),
                gte(schema.accessLog.time, from),
                isNotNull(schema.accessLog.apiSecurity),
              ),
            )
            .orderBy(desc(schema.accessLog.time), desc(schema.accessLog.id))
            .limit(100)
        ).flatMap((row) => {
          const detail = apiSecurityLog.safeParse(row.detail);
          return detail.success
            ? [{ ...row, time: row.time.toISOString(), detail: detail.data }]
            : [];
        });
  return {
    endpoints: endpoints.map(endpointDto),
    events,
    sampleRate: settings.discovery.sampleRate,
    retentionDays: API_SECURITY_LIMITS.retentionDays,
    unsupportedNodes: await unsupportedNodes(app.db, site.clusterId),
  };
}

export async function confirmApiEndpoint(
  db: Database,
  input: { id: string; endpointId: string; path: string },
  actor: Actor,
) {
  return db.transaction(async (tx) => {
    await lockDiscovery(tx, input.id);
    const site = await findSite(tx, input.id, true);
    const [row] = await tx
      .update(schema.siteApiEndpoint)
      .set({ path: input.path, confirmed: true, source: "manual" })
      .where(
        and(
          eq(schema.siteApiEndpoint.id, input.endpointId),
          eq(schema.siteApiEndpoint.siteId, site.id),
          gte(schema.siteApiEndpoint.lastSeen, new Date(Date.now() - API_SECURITY_TTL_MS)),
        ),
      )
      .returning();
    if (!row) fail("API_ENDPOINT_NOT_FOUND", "discovered endpoint not found");
    await recordAudit(tx, actor, {
      action: "site.api_endpoint_confirm",
      targetType: "site",
      targetId: site.id,
      targetName: site.name,
      metadata: { endpointId: row.id, count: 1 },
    });
    return endpointDto(row);
  });
}

export function parseApiSecurityLog(
  raw: string,
  settings: ApiSecuritySettings,
): ApiSecurityDetail | null {
  if (!raw || Buffer.byteLength(raw) > 4096 || !apiSecurityEnabled(settings)) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = apiSecurityLog.safeParse(value);
  if (!parsed.success) return null;
  const detail = parsed.data;
  const known = settings.schema.endpoints.some((endpoint) => endpoint.path === detail.template);
  if (!known) {
    const parts = detail.template.split("/").slice(1);
    detail.template =
      parts.length > 20
        ? "/{segment1}"
        : `/${parts
            .map((part, index) =>
              !part || TRAFFIC_WORDS.has(part) ? part : `{segment${index + 1}}`,
            )
            .join("/")}`;
    detail.source = "traffic";
  }
  detail.issues = detail.issues
    .filter((issue) => settings[issue.check].mode !== "off")
    .map((issue) => ({
      ...issue,
      code: ISSUE_CODES.has(issue.code) ? issue.code : "check-invalid",
    }));
  const allowed = new Set(
    settings.exceptions.filter((entry) => entry.enabled).map((entry) => entry.id),
  );
  detail.exceptionIds = detail.exceptionIds.filter((id) => allowed.has(id));
  return detail;
}

async function lockDiscovery(tx: Tx, siteId: string) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('api-discovery'), hashtext(${siteId}))`,
  );
}

export async function pruneApiEndpoints(tx: Tx, now = Date.now()) {
  const table = schema.siteApiEndpoint;
  const cutoff = new Date(now - API_SECURITY_TTL_MS);
  const sites = await tx
    .selectDistinct({ id: table.siteId })
    .from(table)
    .where(lt(table.lastSeen, cutoff))
    .orderBy(asc(table.siteId));
  for (const { id } of sites) {
    await lockDiscovery(tx, id);
    await tx.delete(table).where(and(eq(table.siteId, id), lt(table.lastSeen, cutoff)));
  }
}

export async function ingestApiEndpoints(
  tx: Tx,
  entries: {
    siteId: string;
    method: string;
    time: string;
    apiSecurity?: ApiSecurityDetail | null;
  }[],
  discoverySites: ReadonlySet<string>,
  now: number,
) {
  const table = schema.siteApiEndpoint;
  const groups = new Map<
    string,
    {
      method: string;
      detail: ApiSecurityDetail;
      first: Date;
      last: Date;
      requests: number;
      violations: number;
    }[]
  >();
  for (const entry of entries) {
    if (
      !entry.apiSecurity ||
      !discoverySites.has(entry.siteId) ||
      !apiMethod.safeParse(entry.method).success ||
      Date.parse(entry.time) < now - API_SECURITY_TTL_MS
    )
      continue;
    const list = groups.get(entry.siteId) ?? [];
    const time = new Date(entry.time);
    const before = list.find(
      (row) => row.method === entry.method && row.detail.template === entry.apiSecurity?.template,
    );
    if (before) {
      before.requests++;
      before.violations += entry.apiSecurity.issues.length ? 1 : 0;
      if (time < before.first) before.first = time;
      if (time > before.last) before.last = time;
    } else
      list.push({
        method: entry.method,
        detail: entry.apiSecurity,
        first: time,
        last: time,
        requests: 1,
        violations: entry.apiSecurity.issues.length ? 1 : 0,
      });
    groups.set(entry.siteId, list);
  }
  for (const [siteId, list] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    await lockDiscovery(tx, siteId);
    await tx
      .delete(table)
      .where(
        and(eq(table.siteId, siteId), lt(table.lastSeen, new Date(now - API_SECURITY_TTL_MS))),
      );
    const existing = await tx
      .select({ method: table.method, template: table.template })
      .from(table)
      .where(eq(table.siteId, siteId));
    const keys = new Set(existing.map((row) => `${row.method} ${row.template}`));
    for (const row of list) {
      const key = `${row.method} ${row.detail.template}`;
      if (!keys.has(key) && keys.size >= API_SECURITY_LIMITS.candidates) continue;
      await tx
        .insert(table)
        .values({
          siteId,
          method: row.method,
          template: row.detail.template,
          path: row.detail.template,
          source: row.detail.source,
          firstSeen: row.first,
          lastSeen: row.last,
          sampledRequests: row.requests,
          violations: row.violations,
        })
        .onConflictDoUpdate({
          target: [table.siteId, table.method, table.template],
          set: {
            sampledRequests: sql`${table.sampledRequests} + excluded.sampled_requests`,
            violations: sql`${table.violations} + excluded.violations`,
            firstSeen: sql`least(${table.firstSeen}, excluded.first_seen)`,
            lastSeen: sql`greatest(${table.lastSeen}, excluded.last_seen)`,
          },
        });
      keys.add(key);
    }
  }
}
