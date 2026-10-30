import { randomBytes, randomUUID } from "node:crypto";
import {
  checkProbeSourceFields,
  MAX_PROBE_SOURCE_MAPPINGS,
  type ProbeMode,
  type ProbeModes,
  type ProbeSource,
  type ProbeSourceCheckInput,
  type ProbeSourceInput,
  type ProbeSourceMapping,
  type ProbeSourceMappingInput,
  type ProbeSourceMonitor,
  type ProbeSourceResult,
  type ProbeSourceStatus,
  type ProbeSourceUpdate,
  probeSourceEntry,
  unicastAddress,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, eq, inArray, lt } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { OutboundRefusedError, outboundRequest } from "../lib/outbound";
import { type Actor, recordAudit } from "./audit";
import { nodeIpRows, type SchedulingAddress, schedulingAddressesOf } from "./node-addresses";
import { raisePlatformAlert, resolvePlatformAlert } from "./platform-alerts";
import { adapterOf } from "./probe-sources";
import {
  type Http,
  type Observation,
  ProbeSourceError,
  type ProbeSourceErrorCode,
  type PullContext,
} from "./probe-sources/types";
import { getProbeSettings } from "./probes";
import type { Executor } from "./revisions";

/** proberKind of the result rows external sources contribute (never stored in probe_result). */
export const EXTERNAL_PROBER_KIND = "external";
export const MAX_PROBE_SOURCES = 32;
/** Locations kept per monitor; more are dropped. */
const MAX_LOCATIONS = 64;
/** Monitors kept per source (mapped or seen in deliveries). */
const MAX_MONITORS = 5000;
/** Results not received again for this long are deleted. */
const OBSERVATION_RETENTION_MS = 24 * 3600 * 1000;
/** Lost attempts of a result: loss in percent of 100 attempts. */
const ATTEMPTS = 100;
/** Provider API answers are bounded. */
const API_LIMITS = { maxBytes: 8 * 1024 * 1024, timeoutMs: 15_000 };
const WEBHOOK_SECRET_PREFIX = "ewh_";
/** The public path a source's deliveries go to; the id names the source, the secret signs. */
export const PROBE_SOURCE_WEBHOOK_PATH = "/api/hooks/probe-sources";

type SourceRow = typeof schema.externalProbeSource.$inferSelect;
type ObservationRow = typeof schema.externalProbeObservation.$inferSelect;
type ResultRow = typeof schema.probeResult.$inferSelect;

export const credentialBinding = (id: string) => ({
  purpose: "external_probe_source.credential_envelope",
  recordId: id,
});
export const webhookSecretBinding = (id: string) => ({
  purpose: "external_probe_source.webhook_secret_envelope",
  recordId: id,
});

/** The source's state now; only "healthy" sources' results count. */
export function sourceStatus(row: SourceRow, now: Date): ProbeSourceStatus {
  if (!row.enabled) return "disabled";
  const success = row.lastSuccessAt?.getTime() ?? null;
  const error = row.lastErrorAt?.getTime() ?? null;
  // A failed poll stops the source's results from counting at once.
  if (error !== null && (success === null || error > success)) return "failing";
  if (success === null) return "waiting";
  return now.getTime() - success > row.staleAfterSeconds * 1000 ? "stale" : "healthy";
}

/** A result's loss in percent. */
const lossOf = (o: { sent: number; lost: number }) => (o.sent ? (100 * o.lost) / o.sent : 0);
/** Down by its location's majority: more than half of its locations lost every attempt. */
const monitorDown = (rows: readonly ObservationRow[]) =>
  rows.length > 0 && rows.filter((r) => r.lost >= r.sent).length * 2 > rows.length;

/**
 * The result rows the healthy external sources contribute for the nodes'
 * scheduling addresses: one per mapped monitor, location and address
 * (a mapping without an address covers each of the node's), as if a prober
 * "<source>:<location>" had measured it. A result counts while it was
 * received within the source's staleAfterSeconds.
 */
export async function externalProbeRows(
  db: Executor,
  addresses: ReadonlyMap<string, readonly SchedulingAddress[]>,
  now: Date,
): Promise<ResultRow[]> {
  const nodeIds = [...addresses.keys()];
  if (!nodeIds.length) return [];
  const mappings = await db
    .select()
    .from(schema.externalProbeMapping)
    .where(inArray(schema.externalProbeMapping.nodeId, nodeIds));
  if (!mappings.length) return [];
  const sourceIds = [...new Set(mappings.map((m) => m.sourceId))];
  const sources = (
    await db
      .select()
      .from(schema.externalProbeSource)
      .where(inArray(schema.externalProbeSource.id, sourceIds))
  ).filter((s) => sourceStatus(s, now) === "healthy");
  if (!sources.length) return [];
  const observations = await db
    .select()
    .from(schema.externalProbeObservation)
    .where(
      inArray(
        schema.externalProbeObservation.sourceId,
        sources.map((s) => s.id),
      ),
    );
  const rows: ResultRow[] = [];
  for (const source of sources) {
    const since = now.getTime() - source.staleAfterSeconds * 1000;
    for (const mapping of mappings.filter((m) => m.sourceId === source.id)) {
      const scheduled = (addresses.get(mapping.nodeId) ?? []).map((a) => a.address);
      const targets = mapping.address ? scheduled.filter((a) => a === mapping.address) : scheduled;
      for (const o of observations)
        if (
          o.sourceId === source.id &&
          o.monitorId === mapping.monitorId &&
          o.receivedAt.getTime() >= since
        )
          for (const address of targets)
            rows.push({
              proberKind: EXTERNAL_PROBER_KIND,
              proberId: `${source.id}:${o.location}`,
              regionId: null,
              nodeId: mapping.nodeId,
              address,
              port: 0,
              method: source.provider,
              sent: o.sent,
              lost: o.lost,
              rttMs: o.rttMs,
              error: o.error,
              checkedAt: o.receivedAt,
            });
    }
  }
  return rows;
}

/**
 * Stores a poll's or a delivery's results. A result older than the one
 * stored for its monitor and location is ignored (a replayed delivery
 * cannot bring back an old state); one at the same time only renews when
 * it was received. Returns the clusters of the mapped nodes it concerns.
 */
export async function recordObservations(
  db: Database,
  sourceId: string,
  observations: readonly Observation[],
  now: Date,
  via: "poll" | "webhook",
): Promise<string[]> {
  const byKey = new Map<string, typeof schema.externalProbeObservation.$inferInsert>();
  const locations = new Map<string, number>();
  for (const o of observations) {
    const monitorId = o.monitorId.trim().slice(0, 200);
    if (!monitorId) continue;
    const location = o.location.trim().slice(0, 64);
    const key = `${monitorId}\u0000${location}`;
    if (!byKey.has(key)) {
      const count = locations.get(monitorId) ?? 0;
      if (count >= MAX_LOCATIONS) continue;
      locations.set(monitorId, count + 1);
    }
    const loss = o.up
      ? Math.min(100, Math.max(0, Math.round(o.lossPercent ?? 0)))
      : Math.max(Math.round(o.lossPercent ?? 100), 100);
    const checkedAt =
      o.checkedAt && o.checkedAt.getTime() <= now.getTime() ? o.checkedAt : new Date(now);
    byKey.set(key, {
      sourceId,
      monitorId,
      location,
      sent: ATTEMPTS,
      lost: Math.min(ATTEMPTS, loss),
      rttMs: o.up && o.rttMs !== null ? Math.min(60_000, Math.max(0, Math.round(o.rttMs))) : 0,
      error: o.up ? "" : o.error.slice(0, 32),
      checkedAt,
      receivedAt: now,
    });
  }
  const values = [...byKey.values()];
  await db.transaction(async (tx) => {
    const [source] = await tx
      .select({ id: schema.externalProbeSource.id })
      .from(schema.externalProbeSource)
      .where(eq(schema.externalProbeSource.id, sourceId))
      .for("update");
    if (!source) return;
    const existing = await tx
      .select()
      .from(schema.externalProbeObservation)
      .where(eq(schema.externalProbeObservation.sourceId, sourceId));
    const stored = new Map(existing.map((e) => [`${e.monitorId}\u0000${e.location}`, e]));
    const monitors = new Set(existing.map((e) => e.monitorId));
    for (const value of values) {
      const key = `${value.monitorId}\u0000${value.location}`;
      const prev = stored.get(key);
      if (prev && prev.checkedAt.getTime() > (value.checkedAt as Date).getTime()) continue;
      if (!prev && !monitors.has(value.monitorId)) {
        if (monitors.size >= MAX_MONITORS) continue;
        monitors.add(value.monitorId);
      }
      await tx
        .insert(schema.externalProbeObservation)
        .values(value)
        .onConflictDoUpdate({
          target: [
            schema.externalProbeObservation.sourceId,
            schema.externalProbeObservation.monitorId,
            schema.externalProbeObservation.location,
          ],
          set: {
            sent: value.sent,
            lost: value.lost,
            rttMs: value.rttMs,
            error: value.error,
            checkedAt: value.checkedAt,
            receivedAt: now,
          },
        });
    }
    await tx
      .update(schema.externalProbeSource)
      .set({
        lastSuccessAt: now,
        ...(via === "webhook" ? { lastDeliveryAt: now } : { lastPollAt: now }),
        ...(via === "poll" ? { lastError: "", lastErrorAt: null } : {}),
      })
      .where(eq(schema.externalProbeSource.id, sourceId));
    await tx
      .delete(schema.externalProbeObservation)
      .where(
        and(
          eq(schema.externalProbeObservation.sourceId, sourceId),
          lt(
            schema.externalProbeObservation.receivedAt,
            new Date(now.getTime() - OBSERVATION_RETENTION_MS),
          ),
        ),
      );
  });
  return clustersOfSource(db, sourceId);
}

/** Clusters of the nodes a source's mappings name. */
async function clustersOfSource(db: Executor, sourceId: string) {
  const rows = await db
    .selectDistinct({ clusterId: schema.node.clusterId })
    .from(schema.externalProbeMapping)
    .innerJoin(schema.node, eq(schema.node.id, schema.externalProbeMapping.nodeId))
    .where(eq(schema.externalProbeMapping.sourceId, sourceId));
  return rows.map((r) => r.clusterId);
}

// ---- sources ----

async function findSource(db: Executor, id: string): Promise<SourceRow> {
  const [row] = await db
    .select()
    .from(schema.externalProbeSource)
    .where(eq(schema.externalProbeSource.id, id));
  if (!row) fail("PROBE_SOURCE_NOT_FOUND", "probe source not found");
  return row;
}

const webhookUrlOf = (app: Pick<AppContext, "env">, row: SourceRow) =>
  row.webhookSecretEnvelope
    ? `${app.env.EDGEWEIR_PUBLIC_URL.replace(/\/$/, "")}${PROBE_SOURCE_WEBHOOK_PATH}/${row.id}`
    : null;

function openSecrets(app: Pick<AppContext, "masterKey">, row: SourceRow): Record<string, string> {
  if (!row.credentialEnvelope) return {};
  return JSON.parse(
    app.masterKey
      .open(JSON.parse(row.credentialEnvelope), credentialBinding(row.id))
      .toString("utf8"),
  );
}

export function openWebhookSecret(app: Pick<AppContext, "masterKey">, row: SourceRow) {
  return row.webhookSecretEnvelope
    ? app.masterKey
        .open(JSON.parse(row.webhookSecretEnvelope), webhookSecretBinding(row.id))
        .toString("utf8")
    : null;
}

async function toSourceDtos(
  app: Pick<AppContext, "env" | "masterKey">,
  db: Executor,
  rows: SourceRow[],
  now: Date,
): Promise<ProbeSource[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const mappings = await db
    .select()
    .from(schema.externalProbeMapping)
    .where(inArray(schema.externalProbeMapping.sourceId, ids));
  const observations = await db
    .select()
    .from(schema.externalProbeObservation)
    .where(inArray(schema.externalProbeObservation.sourceId, ids));
  return rows.map((row) => {
    const own = mappings.filter((m) => m.sourceId === row.id);
    const since = now.getTime() - row.staleAfterSeconds * 1000;
    const down = own.filter((m) =>
      monitorDown(
        observations.filter(
          (o) =>
            o.sourceId === row.id && o.monitorId === m.monitorId && o.receivedAt.getTime() >= since,
        ),
      ),
    ).length;
    const entry = probeSourceEntry(row.provider);
    return {
      id: row.id,
      name: row.name,
      provider: (entry?.id ?? "generic_webhook") as ProbeSource["provider"],
      enabled: row.enabled,
      options: row.options,
      secretsSet: Object.keys(openSecrets(app, row)).sort(),
      webhookUrl: webhookUrlOf(app, row),
      pollIntervalSeconds: row.pollIntervalSeconds,
      staleAfterSeconds: row.staleAfterSeconds,
      status: sourceStatus(row, now),
      lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
      lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
      lastPollAt: row.lastPollAt?.toISOString() ?? null,
      lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
      lastError: row.lastError,
      mappings: own.length,
      down,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

async function sourceDto(app: Pick<AppContext, "env" | "masterKey">, db: Executor, id: string) {
  const [dto] = await toSourceDtos(app, db, [await findSource(db, id)], new Date());
  if (!dto) fail("PROBE_SOURCE_NOT_FOUND", "probe source not found");
  return dto;
}

export async function listProbeSources(app: AppContext, now = new Date()) {
  const rows = await app.db
    .select()
    .from(schema.externalProbeSource)
    .orderBy(schema.externalProbeSource.createdAt, schema.externalProbeSource.id);
  return toSourceDtos(app, app.db, rows, now);
}

/** The catalog's fields, split into sealed secrets and plain options; PROBE_SOURCE_FIELD_INVALID otherwise. */
function checkedFields(provider: string, fields: Record<string, string>, keepSecrets = false) {
  const checked = checkProbeSourceFields(provider, fields, { keepSecrets });
  if (!checked.ok)
    fail("PROBE_SOURCE_FIELD_INVALID", `probe source field: ${checked.problem}`, {
      field: checked.field ?? "",
    });
  return checked;
}

function checkPollInterval(provider: string, seconds: number) {
  const min = probeSourceEntry(provider)?.minPollSeconds ?? 30;
  if (seconds < min)
    fail("PROBE_SOURCE_POLL_TOO_FAST", "poll interval below the provider's minimum", {
      min: String(min),
    });
}

const newWebhookSecret = () => `${WEBHOOK_SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;

export async function createProbeSource(
  app: AppContext,
  input: ProbeSourceInput,
  actor: Actor,
): Promise<{ source: ProbeSource; webhookSecret: string | null }> {
  const entry = probeSourceEntry(input.provider);
  if (!entry) fail("PROBE_SOURCE_FIELD_INVALID", "unknown provider", { field: "provider" });
  const fields = checkedFields(input.provider, input.fields);
  if (entry.pull) checkPollInterval(input.provider, input.pollIntervalSeconds);
  if (input.webhookSecret !== undefined && entry.webhook !== "entered")
    fail("PROBE_SOURCE_WEBHOOK_UNSUPPORTED", "the console makes this provider's webhook secret");
  if (entry.webhook === "entered" && !input.webhookSecret && !entry.pull)
    fail("PROBE_SOURCE_FIELD_INVALID", "webhook secret required", { field: "webhook_secret" });
  const id = randomUUID();
  const made = entry.webhook === "generated" ? newWebhookSecret() : null;
  const webhookSecret = made ?? input.webhookSecret ?? null;
  const row = await app.db.transaction(async (tx) => {
    const count = await tx
      .select({ id: schema.externalProbeSource.id })
      .from(schema.externalProbeSource);
    if (count.length >= MAX_PROBE_SOURCES)
      fail("PROBE_SOURCE_LIMIT", "too many probe sources", { limit: String(MAX_PROBE_SOURCES) });
    const [inserted] = await tx
      .insert(schema.externalProbeSource)
      .values({
        id,
        name: input.name,
        provider: input.provider,
        enabled: input.enabled,
        options: fields.options,
        credentialEnvelope: Object.keys(fields.secrets).length
          ? JSON.stringify(
              app.masterKey.seal(JSON.stringify(fields.secrets), credentialBinding(id)),
            )
          : null,
        webhookSecretEnvelope: webhookSecret
          ? JSON.stringify(app.masterKey.seal(webhookSecret, webhookSecretBinding(id)))
          : null,
        pollIntervalSeconds: input.pollIntervalSeconds,
        staleAfterSeconds: input.staleAfterSeconds,
      })
      .returning();
    if (!inserted) throw new Error("probe source insert failed");
    await recordAudit(tx, actor, {
      action: "probe_source.create",
      targetType: "probe_source",
      targetId: id,
      targetName: input.name,
      metadata: {
        provider: input.provider,
        options: fields.options,
        webhook: !!webhookSecret,
        pollIntervalSeconds: input.pollIntervalSeconds,
        staleAfterSeconds: input.staleAfterSeconds,
      },
    });
    return inserted;
  });
  return { source: await sourceDto(app, app.db, row.id), webhookSecret: made };
}

export async function updateProbeSource(
  app: AppContext,
  input: ProbeSourceUpdate,
  actor: Actor,
): Promise<ProbeSource> {
  await app.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.externalProbeSource)
      .where(eq(schema.externalProbeSource.id, input.id))
      .for("update");
    if (!row) fail("PROBE_SOURCE_NOT_FOUND", "probe source not found");
    const entry = probeSourceEntry(row.provider);
    if (input.webhookSecret !== undefined && entry?.webhook !== "entered")
      fail("PROBE_SOURCE_WEBHOOK_UNSUPPORTED", "the console makes this provider's webhook secret");
    const fields = input.fields ? checkedFields(row.provider, input.fields, true) : null;
    const secrets = fields ? { ...openSecrets(app, row), ...fields.secrets } : null;
    const interval = input.pollIntervalSeconds ?? row.pollIntervalSeconds;
    if (entry?.pull && input.pollIntervalSeconds !== undefined)
      checkPollInterval(row.provider, interval);
    await tx
      .update(schema.externalProbeSource)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(fields ? { options: fields.options } : {}),
        ...(secrets && Object.keys(fields?.secrets ?? {}).length
          ? {
              credentialEnvelope: JSON.stringify(
                app.masterKey.seal(JSON.stringify(secrets), credentialBinding(row.id)),
              ),
              // New credentials: the next poll decides again.
              lastError: "",
              lastErrorAt: null,
              lastPollAt: null,
            }
          : {}),
        ...(input.webhookSecret
          ? {
              webhookSecretEnvelope: JSON.stringify(
                app.masterKey.seal(input.webhookSecret, webhookSecretBinding(row.id)),
              ),
            }
          : {}),
        ...(input.pollIntervalSeconds !== undefined ? { pollIntervalSeconds: interval } : {}),
        ...(input.staleAfterSeconds !== undefined
          ? { staleAfterSeconds: input.staleAfterSeconds }
          : {}),
      })
      .where(eq(schema.externalProbeSource.id, row.id));
    await recordAudit(tx, actor, {
      action: "probe_source.update",
      targetType: "probe_source",
      targetId: row.id,
      targetName: input.name ?? row.name,
      metadata: {
        from: {
          name: row.name,
          enabled: row.enabled,
          options: row.options,
          pollIntervalSeconds: row.pollIntervalSeconds,
          staleAfterSeconds: row.staleAfterSeconds,
        },
        name: input.name,
        enabled: input.enabled,
        options: fields?.options,
        secretsChanged: Object.keys(fields?.secrets ?? {}).sort(),
        webhookSecretChanged: !!input.webhookSecret,
        pollIntervalSeconds: input.pollIntervalSeconds,
        staleAfterSeconds: input.staleAfterSeconds,
      },
    });
  });
  return sourceDto(app, app.db, input.id);
}

/** Deletes the source, its mappings and results; its stale alert resolves. */
export async function deleteProbeSource(app: AppContext, id: string, actor: Actor) {
  const clusters = await clustersOfSource(app.db, id);
  await app.db.transaction(async (tx) => {
    const row = await findSource(tx, id);
    await tx.delete(schema.externalProbeSource).where(eq(schema.externalProbeSource.id, id));
    await resolvePlatformAlert(tx, "probe_source_stale", id, row.name);
    await recordAudit(tx, actor, {
      action: "probe_source.delete",
      targetType: "probe_source",
      targetId: id,
      targetName: row.name,
      metadata: { provider: row.provider },
    });
  });
  return { ok: true as const, clusterIds: clusters };
}

export async function rotateProbeSourceSecret(app: AppContext, id: string, actor: Actor) {
  const webhookSecret = newWebhookSecret();
  await app.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.externalProbeSource)
      .where(eq(schema.externalProbeSource.id, id))
      .for("update");
    if (!row) fail("PROBE_SOURCE_NOT_FOUND", "probe source not found");
    if (probeSourceEntry(row.provider)?.webhook !== "generated")
      fail("PROBE_SOURCE_WEBHOOK_UNSUPPORTED", "the provider makes this webhook secret");
    await tx
      .update(schema.externalProbeSource)
      .set({
        webhookSecretEnvelope: JSON.stringify(
          app.masterKey.seal(webhookSecret, webhookSecretBinding(id)),
        ),
      })
      .where(eq(schema.externalProbeSource.id, id));
    await recordAudit(tx, actor, {
      action: "probe_source.rotate_secret",
      targetType: "probe_source",
      targetId: id,
      targetName: row.name,
    });
  });
  return { webhookSecret };
}

// ---- mappings and results ----

async function mappingDtos(db: Executor, sourceId: string): Promise<ProbeSourceMapping[]> {
  const rows = await db
    .select({ m: schema.externalProbeMapping, node: schema.node })
    .from(schema.externalProbeMapping)
    .innerJoin(schema.node, eq(schema.node.id, schema.externalProbeMapping.nodeId))
    .where(eq(schema.externalProbeMapping.sourceId, sourceId));
  return rows
    .map(({ m, node }) => ({
      monitorId: m.monitorId,
      monitorName: m.monitorName,
      nodeId: node.id,
      nodeName: node.name,
      clusterId: node.clusterId,
      address: m.address,
    }))
    .sort((a, b) => a.nodeName.localeCompare(b.nodeName) || a.monitorId.localeCompare(b.monitorId));
}

export async function listProbeSourceMappings(db: Executor, sourceId: string) {
  await findSource(db, sourceId);
  return mappingDtos(db, sourceId);
}

/**
 * Replaces the mappings: each monitor once, an existing node, and an
 * address (when given) among the node's scheduling addresses or IPs.
 */
export async function setProbeSourceMappings(
  db: Database,
  sourceId: string,
  input: readonly ProbeSourceMappingInput[],
  actor: Actor,
) {
  if (input.length > MAX_PROBE_SOURCE_MAPPINGS)
    fail("PROBE_SOURCE_MAPPING_INVALID", "too many mappings", { monitor: "" });
  const before = await clustersOfSource(db, sourceId);
  const result = await db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(schema.externalProbeSource)
      .where(eq(schema.externalProbeSource.id, sourceId))
      .for("update");
    if (!row) fail("PROBE_SOURCE_NOT_FOUND", "probe source not found");
    const nodeIds = [...new Set(input.map((m) => m.nodeId))];
    const nodes = nodeIds.length
      ? await tx
          .select({ id: schema.node.id })
          .from(schema.node)
          .where(inArray(schema.node.id, nodeIds))
      : [];
    const ips = await nodeIpRows(tx, nodeIds);
    const seen = new Set<string>();
    const values: (typeof schema.externalProbeMapping.$inferInsert)[] = [];
    for (const m of input) {
      const monitorId = m.monitorId.trim();
      const invalid = () =>
        fail("PROBE_SOURCE_MAPPING_INVALID", "invalid mapping", { monitor: monitorId });
      if (!monitorId || seen.has(monitorId)) invalid();
      seen.add(monitorId);
      if (!nodes.some((n) => n.id === m.nodeId)) invalid();
      let address: string | null = null;
      if (m.address) {
        address = unicastAddress(m.address);
        const own = ips.get(m.nodeId) ?? [];
        const scheduled = schedulingAddressesOf(own).map((a) => a.address);
        const known = own.map((r) => unicastAddress(r.address));
        if (!address || !(scheduled.includes(address) || known.includes(address))) invalid();
      }
      values.push({
        sourceId,
        monitorId,
        monitorName: (m.monitorName ?? "").trim().slice(0, 200),
        nodeId: m.nodeId,
        address,
      });
    }
    await tx
      .delete(schema.externalProbeMapping)
      .where(eq(schema.externalProbeMapping.sourceId, sourceId));
    for (let i = 0; i < values.length; i += 500)
      await tx.insert(schema.externalProbeMapping).values(values.slice(i, i + 500));
    await recordAudit(tx, actor, {
      action: "probe_source.mappings",
      targetType: "probe_source",
      targetId: sourceId,
      targetName: row.name,
      metadata: {
        count: values.length,
        mappings: values.slice(0, 100).map((v) => ({
          monitorId: v.monitorId,
          nodeId: v.nodeId,
          address: v.address,
        })),
      },
    });
    return mappingDtos(tx, sourceId);
  });
  return {
    mappings: result,
    clusterIds: [...new Set([...before, ...result.map((m) => m.clusterId)])],
  };
}

export async function listProbeSourceResults(
  db: Executor,
  sourceId: string,
  now = new Date(),
): Promise<ProbeSourceResult[]> {
  const source = await findSource(db, sourceId);
  const healthy = sourceStatus(source, now) === "healthy";
  const since = now.getTime() - source.staleAfterSeconds * 1000;
  const mappings = await mappingDtos(db, sourceId);
  const observations = await db
    .select()
    .from(schema.externalProbeObservation)
    .where(eq(schema.externalProbeObservation.sourceId, sourceId))
    .limit(10_000);
  return observations
    .map((o) => {
      const mapping = mappings.find((m) => m.monitorId === o.monitorId);
      return {
        monitorId: o.monitorId,
        monitorName: mapping?.monitorName ?? "",
        nodeId: mapping?.nodeId ?? null,
        nodeName: mapping?.nodeName ?? null,
        location: o.location,
        up: o.lost < o.sent,
        lossPercent: Math.round(lossOf(o) * 10) / 10,
        rttMs: o.lost < o.sent && o.rttMs > 0 ? o.rttMs : null,
        error: o.error,
        checkedAt: o.checkedAt.toISOString(),
        receivedAt: o.receivedAt.toISOString(),
        counted: !!mapping && healthy && o.receivedAt.getTime() >= since,
      };
    })
    .sort(
      (a, b) =>
        Number(a.nodeId === null) - Number(b.nodeId === null) ||
        (a.nodeName ?? "").localeCompare(b.nodeName ?? "") ||
        a.monitorId.localeCompare(b.monitorId) ||
        a.location.localeCompare(b.location),
    );
}

// ---- provider API ----

/** The provider requests of a source, under the outbound policy. */
export function sourceHttp(app: AppContext): Http {
  const test = app.env.EDGEWEIR_PROBE_SOURCE_TEST_ENDPOINT;
  return async (request) => {
    try {
      if (test) {
        // Integration tests: the provider's API simulator, told which host was meant.
        const url = new URL(request.url);
        const target = new URL(`${url.pathname}${url.search}`, test);
        return await outboundRequest(
          app,
          {
            ...request,
            url: target.toString(),
            headers: { ...request.headers, "x-edgeweir-test-host": url.host },
          },
          API_LIMITS,
        );
      }
      return await outboundRequest(app, request, API_LIMITS);
    } catch (error) {
      if (error instanceof OutboundRefusedError) throw new ProbeSourceError("refused");
      throw new ProbeSourceError("unreachable");
    }
  };
}

const errorCodeOf = (error: unknown): ProbeSourceErrorCode =>
  error instanceof ProbeSourceError ? error.code : "bad_response";

function pullContext(
  app: AppContext,
  secrets: Record<string, string>,
  options: Record<string, string>,
  monitorIds: readonly string[],
  now: Date,
  http?: Http,
): PullContext {
  return {
    credentials: secrets,
    options,
    http: http ?? sourceHttp(app),
    now,
    monitorIds,
  };
}

/** Lists the provider's monitors with the given or stored fields; writes nothing. */
export async function checkProbeSource(app: AppContext, input: ProbeSourceCheckInput, http?: Http) {
  let provider: string;
  let secrets: Record<string, string>;
  let options: Record<string, string>;
  if ("id" in input) {
    const row = await findSource(app.db, input.id);
    provider = row.provider;
    const fields = input.fields ? checkedFields(row.provider, input.fields, true) : null;
    secrets = { ...openSecrets(app, row), ...(fields?.secrets ?? {}) };
    options = fields?.options ?? row.options;
  } else {
    provider = input.provider;
    const fields = checkedFields(input.provider, input.fields);
    secrets = fields.secrets;
    options = fields.options;
  }
  const adapter = adapterOf(provider);
  if (!adapter?.listMonitors) return { ok: true, monitors: null, error: "" };
  try {
    const monitors = await adapter.listMonitors(
      pullContext(app, secrets, options, [], new Date(), http),
    );
    return { ok: true, monitors: monitors.length, error: "" };
  } catch (error) {
    return { ok: false, monitors: null, error: errorCodeOf(error) };
  }
}

/** Matches a monitor's target to a node: an address of the node, or its host name. */
function suggest(
  target: string,
  nodes: { id: string; hostname: string; addresses: string[] }[],
): { nodeId: string; address: string | null } | null {
  let host = target.trim();
  try {
    host = new URL(host.includes("://") ? host : `tcp://${host}`).hostname;
  } catch {
    // Not a URL: compare as it is.
  }
  host = host.replace(/^\[|\]$/g, "").toLowerCase();
  const address = unicastAddress(host);
  for (const node of nodes) {
    if (address && node.addresses.includes(address)) return { nodeId: node.id, address };
    if (!address && node.hostname && node.hostname.toLowerCase() === host)
      return { nodeId: node.id, address: null };
  }
  return null;
}

/** The provider's monitors (pull) or the monitors deliveries named, with suggestions. */
export async function listProbeSourceMonitors(
  app: AppContext,
  sourceId: string,
  http?: Http,
): Promise<ProbeSourceMonitor[]> {
  const row = await findSource(app.db, sourceId);
  const adapter = adapterOf(row.provider);
  let monitors: { id: string; name: string; target: string }[];
  if (adapter?.listMonitors) {
    try {
      monitors = await adapter.listMonitors(
        pullContext(app, openSecrets(app, row), row.options, [], new Date(), http),
      );
    } catch (error) {
      fail("PROBE_SOURCE_UNAVAILABLE", "the provider's API failed", {
        reason: errorCodeOf(error),
      });
    }
  } else {
    const seen = await app.db
      .selectDistinct({ monitorId: schema.externalProbeObservation.monitorId })
      .from(schema.externalProbeObservation)
      .where(eq(schema.externalProbeObservation.sourceId, sourceId));
    monitors = seen.map((s) => ({ id: s.monitorId, name: "", target: "" }));
  }
  const nodes = await app.db
    .select({ id: schema.node.id, hostname: schema.node.hostname })
    .from(schema.node);
  const ips = await nodeIpRows(
    app.db,
    nodes.map((n) => n.id),
  );
  const candidates = nodes.map((n) => ({
    id: n.id,
    hostname: n.hostname,
    addresses: (ips.get(n.id) ?? []).flatMap((r) => unicastAddress(r.address) ?? []),
  }));
  return monitors.slice(0, MAX_MONITORS).map((m) => {
    const s = m.target ? suggest(m.target, candidates) : null;
    return {
      id: m.id,
      name: m.name,
      target: m.target,
      suggestedNodeId: s?.nodeId ?? null,
      suggestedAddress: s?.address ?? null,
    };
  });
}

/**
 * Polls one source now: the latest results of its mapped monitors, or the
 * failure code (stored; the source's results stop counting until the next
 * success). Returns the clusters to evaluate.
 */
export async function pollProbeSource(
  app: AppContext,
  row: SourceRow,
  now: Date,
  http?: Http,
): Promise<string[]> {
  const adapter = adapterOf(row.provider);
  if (!adapter?.poll) return [];
  const mappings = await app.db
    .select({ monitorId: schema.externalProbeMapping.monitorId })
    .from(schema.externalProbeMapping)
    .where(eq(schema.externalProbeMapping.sourceId, row.id));
  const monitorIds = mappings.map((m) => m.monitorId);
  try {
    const observations = monitorIds.length
      ? await adapter.poll(
          pullContext(app, openSecrets(app, row), row.options, monitorIds, now, http),
        )
      : [];
    const wanted = new Set(monitorIds);
    return await recordObservations(
      app.db,
      row.id,
      observations.filter((o) => wanted.has(o.monitorId)),
      now,
      "poll",
    );
  } catch (error) {
    const code = errorCodeOf(error);
    app.log.warn("probe source poll failed", { sourceId: row.id, provider: row.provider, code });
    await app.db
      .update(schema.externalProbeSource)
      .set({ lastPollAt: now, lastErrorAt: now, lastError: code })
      .where(eq(schema.externalProbeSource.id, row.id));
    // The source no longer counts: its clusters are evaluated without it.
    return clustersOfSource(app.db, row.id);
  }
}

/**
 * Polls every enabled pull source that is due (its interval since the last
 * poll) and returns the clusters to evaluate. Sources are polled one after
 * the other; each request is bounded (15 s).
 */
export async function pollProbeSources(app: AppContext, now = new Date(), http?: Http) {
  const rows = await app.db
    .select()
    .from(schema.externalProbeSource)
    .where(eq(schema.externalProbeSource.enabled, true));
  const clusters = new Set<string>();
  for (const row of rows) {
    if (!adapterOf(row.provider)?.poll) continue;
    if (row.lastPollAt && now.getTime() - row.lastPollAt.getTime() < row.pollIntervalSeconds * 1000)
      continue;
    for (const id of await pollProbeSource(app, row, now, http)) clusters.add(id);
  }
  return [...clusters];
}

/**
 * Raises probe_source_stale for every enabled source with mappings that has
 * had no success for its staleAfterSeconds (since it was created when it
 * never had one), and resolves it for the others.
 */
export async function sweepProbeSourceAlerts(db: Database, now = new Date()) {
  const rows = await db.select().from(schema.externalProbeSource);
  const mapped = new Set(
    (
      await db
        .selectDistinct({ sourceId: schema.externalProbeMapping.sourceId })
        .from(schema.externalProbeMapping)
    ).map((m) => m.sourceId),
  );
  for (const row of rows) {
    const since = (row.lastSuccessAt ?? row.createdAt).getTime();
    const stale =
      row.enabled && mapped.has(row.id) && now.getTime() - since > row.staleAfterSeconds * 1000;
    await db.transaction((tx) =>
      stale
        ? raisePlatformAlert(tx, "probe_source_stale", row.id, row.name, now)
        : resolvePlatformAlert(tx, "probe_source_stale", row.id, row.name, now),
    );
  }
}

// ---- modes ----

export async function listProbeModes(db: Executor): Promise<ProbeModes> {
  const settings = await getProbeSettings(db);
  const clusters = await db
    .select({ id: schema.cluster.id, name: schema.cluster.name, mode: schema.cluster.probeMode })
    .from(schema.cluster)
    .orderBy(schema.cluster.name);
  return {
    global: settings.mode,
    clusters: clusters.map((c) => ({
      clusterId: c.id,
      clusterName: c.name,
      mode: (["internal", "external", "all", "any"].includes(c.mode ?? "")
        ? c.mode
        : null) as ProbeMode | null,
    })),
  };
}

export async function setClusterProbeMode(
  db: Database,
  clusterId: string,
  mode: ProbeMode | null,
  actor: Actor,
) {
  await db.transaction(async (tx) => {
    const [cluster] = await tx
      .select({ id: schema.cluster.id, name: schema.cluster.name, mode: schema.cluster.probeMode })
      .from(schema.cluster)
      .where(eq(schema.cluster.id, clusterId))
      .for("update");
    if (!cluster) fail("CLUSTER_NOT_FOUND", "cluster not found");
    await tx
      .update(schema.cluster)
      .set({ probeMode: mode })
      .where(eq(schema.cluster.id, clusterId));
    await recordAudit(tx, actor, {
      action: "probe_source.cluster_mode",
      targetType: "cluster",
      targetId: clusterId,
      targetName: cluster.name,
      metadata: { from: cluster.mode, to: mode },
    });
  });
  return listProbeModes(db);
}
