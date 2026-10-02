import { createHash, randomBytes } from "node:crypto";
import { decodeNodeConfig } from "@edgeweir/config-compiler";
import {
  nodeSupportsFeature,
  PROBE_HEALTH_FEATURE,
  PROBE_SETTINGS_DEFAULTS,
  type Probe,
  type ProbeResultDto,
  type ProbeSettings,
  type ProbeTokenResult,
  probeSettings,
  unicastAddress,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { ListenerProtocol } from "@edgeweir/proto";
import { and, desc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import { nodeIpRows, schedulingAddressesOf } from "./node-addresses";
import { normalizeSerial } from "./nodes";
import { type Executor, latestRevision, publisher, type Tx } from "./revisions";
import { defineSetting } from "./settings";

export const PROBE_TOKEN_PREFIX = "ewp_";
export const PROBE_SETTINGS_KEY = "probes";
/** Results per ReportProbeResults call. */
export const MAX_PROBE_RESULTS = 10_000;
/** Largest round-trip time accepted (the longest attempt timeout). */
const MAX_RTT_MS = 10_000;
/** Results older than this are deleted (a prober that stopped reporting). */
const RESULT_RETENTION_MS = 3600 * 1000;

/** The value an upsert would have inserted. */
const sqlExcluded = (column: string) => sql.raw(`excluded."${column}"`);

export type ProbeMethodName = "tcp" | "http" | "https";
export interface ProbeTarget {
  nodeId: string;
  address: string;
  port: number;
  method: ProbeMethodName;
  proxyProtocol: boolean;
}
/** Who measures: an enrolled probe, or a node that also probes from its group's region. */
export interface Prober {
  kind: "probe" | "node";
  id: string;
  name: string;
  regionId: string | null;
}

export const hashProbeToken = (token: string) =>
  createHash("sha256").update(token, "utf8").digest("hex");

const probeSetting = defineSetting({
  key: PROBE_SETTINGS_KEY,
  schema: probeSettings,
  defaults: PROBE_SETTINGS_DEFAULTS,
  auditAction: "system.probes_update",
});

export const getProbeSettings = probeSetting.read;

export function setProbeSettings(db: Database, input: ProbeSettings, actor: Actor) {
  return db.transaction((tx) => probeSetting.write(tx, actor, input));
}

/** Seconds of results that count: three rounds, at least 15 s. */
export const probeWindowSeconds = (settings: ProbeSettings) =>
  Math.max(3 * settings.intervalSeconds, 15);

/** Shell-quotes a value for the generated command. */
function sh(value: string): string {
  return /^[A-Za-z0-9_./:@=+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * The command the console shows for a new probe: the node image in probe
 * mode (no OpenResty), with the token in EDGEWEIR_TOKEN (exported by the
 * shell and passed by name, never on the command line) and its identity in
 * a volume of its own.
 */
export function buildProbeCommand(opts: { serverUrl: string; caSha256: string; token: string }) {
  return [
    `export EDGEWEIR_TOKEN='${opts.token.replace(/'/g, `'"'"'`)}'`,
    [
      // Probes run no data plane: the image's health check would report them unhealthy.
      "docker run -d --name edgeweir-probe --restart unless-stopped --no-healthcheck",
      "-e EDGEWEIR_TOKEN",
      `-e EDGEWEIR_SERVER=${sh(opts.serverUrl)}`,
      `-e EDGEWEIR_CA_SHA256=${sh(opts.caSha256)}`,
      "-e EDGEWEIR_STATE_DIR=/var/lib/edgeweir-probe",
      "-v edgeweir-probe:/var/lib/edgeweir-probe",
      "--entrypoint /usr/local/bin/edgeweir-node",
      "ghcr.io/marvinli001/edgeweir-node:latest probe",
    ].join(" "),
  ].join("\n");
}

async function findRegion(db: Executor, id: string) {
  const [row] = await db.select().from(schema.region).where(eq(schema.region.id, id));
  if (!row) fail("REGION_NOT_FOUND", "region not found");
  return row;
}

export async function createProbeToken(
  db: Database,
  input: { name: string; regionId: string; ttlMinutes: number },
  ctx: { actor: Actor; serverUrl: string; caSha256: string },
): Promise<ProbeTokenResult> {
  const region = await findRegion(db, input.regionId);
  const token = `${PROBE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  const expiresAt = new Date(Date.now() + input.ttlMinutes * 60_000);
  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(schema.probeToken)
      .values({
        tokenHash: hashProbeToken(token),
        tokenPrefix: token.slice(0, PROBE_TOKEN_PREFIX.length + 6),
        name: input.name,
        regionId: region.id,
        expiresAt,
        createdByUserId: publisher(ctx.actor),
      })
      .returning();
    if (!inserted) throw new Error("probe token insert failed");
    await recordAudit(tx, ctx.actor, {
      action: "probe.token_create",
      targetType: "region",
      targetId: region.id,
      targetName: region.name,
      metadata: {
        tokenId: inserted.id,
        name: input.name,
        expiresAt: expiresAt.toISOString(),
      },
    });
    return inserted;
  });
  return {
    tokenId: row.id,
    token,
    expiresAt: expiresAt.toISOString(),
    serverUrl: ctx.serverUrl,
    caSha256: ctx.caSha256,
    command: buildProbeCommand({ serverUrl: ctx.serverUrl, caSha256: ctx.caSha256, token }),
  };
}

/** Locks an unused, unexpired probe token (two enrollments cannot both use it). */
export async function claimProbeToken(tx: Tx, token: string) {
  const [row] = await tx
    .select()
    .from(schema.probeToken)
    .where(
      and(
        eq(schema.probeToken.tokenHash, hashProbeToken(token)),
        isNull(schema.probeToken.usedAt),
        gt(schema.probeToken.expiresAt, new Date()),
      ),
    )
    .for("update");
  return row;
}

type ProbeRow = typeof schema.probe.$inferSelect;
type ResultRow = typeof schema.probeResult.$inferSelect;

async function findProbe(db: Executor, id: string): Promise<ProbeRow> {
  const [row] = await db.select().from(schema.probe).where(eq(schema.probe.id, id));
  if (!row) fail("PROBE_NOT_FOUND", "probe not found");
  return row;
}

function roundSummary(rows: ResultRow[]): Probe["lastRound"] {
  const latest = rows.reduce<Date | null>(
    (max, r) => (!max || r.checkedAt > max ? r.checkedAt : max),
    null,
  );
  if (!latest) return null;
  // One report stores every result of a round with the same time.
  const round = rows.filter((r) => r.checkedAt.getTime() === latest.getTime());
  const sent = round.reduce((n, r) => n + r.sent, 0);
  const lost = round.reduce((n, r) => n + r.lost, 0);
  const answered = round.filter((r) => r.sent > r.lost);
  return {
    checkedAt: latest.toISOString(),
    results: round.length,
    failed: round.filter((r) => r.lost >= r.sent).length,
    lossPercent: sent ? Math.round((1000 * lost) / sent) / 10 : 0,
    avgRttMs: answered.length
      ? Math.round(answered.reduce((n, r) => n + r.rttMs, 0) / answered.length)
      : null,
  };
}

export async function listProbes(db: Executor, now = Date.now()): Promise<Probe[]> {
  const rows = await db.select().from(schema.probe).orderBy(schema.probe.createdAt);
  if (!rows.length) return [];
  const regions = await db.select().from(schema.region);
  const settings = await getProbeSettings(db);
  const results = await db
    .select()
    .from(schema.probeResult)
    .where(
      inArray(
        schema.probeResult.proberId,
        rows.map((r) => r.id),
      ),
    );
  const targets = (await probeTargets(db, null)).length;
  const onlineMs = Math.max(3 * settings.intervalSeconds, 30) * 1000;
  return rows.map((r) => {
    const region = regions.find((g) => g.id === r.regionId);
    return {
      id: r.id,
      name: r.name,
      regionId: r.regionId,
      regionName: region?.name ?? "",
      regionCode: region?.code ?? "",
      enabled: r.enabled,
      online: !!r.lastSeenAt && now - r.lastSeenAt.getTime() <= onlineMs,
      lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
      enrolledAt: r.enrolledAt?.toISOString() ?? null,
      hostname: r.hostname,
      agentVersion: r.agentVersion,
      os: r.os,
      arch: r.arch,
      certNotAfter: r.certNotAfter?.toISOString() ?? null,
      targets,
      lastRound: roundSummary(results.filter((x) => x.proberId === r.id)),
      createdAt: r.createdAt.toISOString(),
    };
  });
}

async function probeDto(db: Executor, id: string): Promise<Probe> {
  const dto = (await listProbes(db)).find((p) => p.id === id);
  if (!dto) fail("PROBE_NOT_FOUND", "probe not found");
  return dto;
}

export async function updateProbe(
  db: Database,
  input: { id: string; name?: string; enabled?: boolean },
  actor: Actor,
): Promise<Probe> {
  return db.transaction(async (tx) => {
    const before = await findProbe(tx, input.id);
    const [updated] = await tx
      .update(schema.probe)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      })
      .where(eq(schema.probe.id, input.id))
      .returning();
    if (!updated) throw new Error("probe update failed");
    // A disabled probe's results no longer count.
    if (input.enabled === false)
      await tx.delete(schema.probeResult).where(eq(schema.probeResult.proberId, updated.id));
    await recordAudit(tx, actor, {
      action: "probe.update",
      targetType: "probe",
      targetId: updated.id,
      targetName: updated.name,
      metadata: { from: { name: before.name, enabled: before.enabled }, ...input },
    });
    return probeDto(tx, updated.id);
  });
}

/** Deletes a probe and revokes its certificates: the node channel refuses them from now on. */
export async function deleteProbe(db: Database, id: string, actor: Actor) {
  await db.transaction(async (tx) => {
    const row = await findProbe(tx, id);
    const serials = [row.certSerial, row.previousCertSerial].filter((s): s is string => !!s);
    if (serials.length)
      await tx
        .insert(schema.nodeCertificateRevocation)
        .values(
          serials.map((serial) => ({
            serial: normalizeSerial(serial),
            // The revocation list is keyed by serial; it names the probe here.
            nodeId: row.id,
            fingerprintSha256: serial === row.certSerial ? (row.certFingerprint ?? "") : "",
            reason: "probe deleted",
          })),
        )
        .onConflictDoNothing();
    await tx.delete(schema.probeResult).where(eq(schema.probeResult.proberId, id));
    await tx.delete(schema.probe).where(eq(schema.probe.id, id));
    await recordAudit(tx, actor, {
      action: "probe.delete",
      targetType: "probe",
      targetId: id,
      targetName: row.name,
      metadata: { regionId: row.regionId, certSerial: row.certSerial },
    });
  });
  return { ok: true as const };
}

/** Latest results, filtered by prober (probe or node id) and/or measured node. */
export async function listProbeResults(
  db: Executor,
  input: { probeId?: string; nodeId?: string },
): Promise<ProbeResultDto[]> {
  if (input.nodeId) {
    const [node] = await db
      .select({ id: schema.node.id })
      .from(schema.node)
      .where(eq(schema.node.id, input.nodeId));
    if (!node) fail("NODE_NOT_FOUND", "node not found");
  }
  if (input.probeId) {
    const [probe] = await db
      .select({ id: schema.probe.id })
      .from(schema.probe)
      .where(eq(schema.probe.id, input.probeId));
    const [node] = probe
      ? [probe]
      : await db
          .select({ id: schema.node.id })
          .from(schema.node)
          .where(eq(schema.node.id, input.probeId));
    if (!node) fail("PROBE_NOT_FOUND", "probe not found");
  }
  const rows = await db
    .select()
    .from(schema.probeResult)
    .where(
      and(
        input.probeId ? eq(schema.probeResult.proberId, input.probeId) : undefined,
        input.nodeId ? eq(schema.probeResult.nodeId, input.nodeId) : undefined,
      ),
    )
    .orderBy(desc(schema.probeResult.checkedAt))
    .limit(5000);
  const probes = await db
    .select({ id: schema.probe.id, name: schema.probe.name })
    .from(schema.probe);
  const nodes = await db.select({ id: schema.node.id, name: schema.node.name }).from(schema.node);
  const regions = await db
    .select({ id: schema.region.id, name: schema.region.name })
    .from(schema.region);
  return rows
    .map((r) => ({
      proberKind: r.proberKind === "node" ? ("node" as const) : ("probe" as const),
      proberId: r.proberId,
      proberName:
        (r.proberKind === "node" ? nodes : probes).find((p) => p.id === r.proberId)?.name ?? "",
      regionId: r.regionId,
      regionName: regions.find((g) => g.id === r.regionId)?.name ?? null,
      nodeId: r.nodeId,
      nodeName: nodes.find((n) => n.id === r.nodeId)?.name ?? "",
      address: r.address,
      port: r.port,
      method: (["tcp", "http", "https"].includes(r.method) ? r.method : "tcp") as ProbeMethodName,
      sent: r.sent,
      lost: r.lost,
      lossPercent: r.sent ? Math.round((1000 * r.lost) / r.sent) / 10 : 0,
      rttMs: r.rttMs,
      error: r.error,
      checkedAt: r.checkedAt.toISOString(),
    }))
    .sort(
      (a, b) =>
        a.nodeName.localeCompare(b.nodeName) ||
        a.address.localeCompare(b.address) ||
        a.port - b.port ||
        a.proberName.localeCompare(b.proberName),
    );
}

/**
 * What a prober measures: every scheduling address (every level) of every
 * enabled node × each listener port of its cluster's latest configuration,
 * except the prober's own node. HTTP and HTTPS listeners are probed with
 * GET /.edgeweir/health only when every active node of the cluster reports
 * probe-health-v1, else with a TCP connection. Sorted by node, address, port.
 * `prober` null: the targets of a probe (no node of its own).
 */
export async function probeTargets(db: Executor, prober: Prober | null): Promise<ProbeTarget[]> {
  const nodes = await db
    .select()
    .from(schema.node)
    .where(
      and(
        eq(schema.node.status, "active"),
        prober?.kind === "node" ? ne(schema.node.id, prober.id) : undefined,
      ),
    );
  if (!nodes.length) return [];
  const allActive = await db
    .select({ clusterId: schema.node.clusterId, features: schema.node.supportedFeatures })
    .from(schema.node)
    .where(eq(schema.node.status, "active"));
  const ips = await nodeIpRows(
    db,
    nodes.map((n) => n.id),
  );
  const targets: ProbeTarget[] = [];
  for (const clusterId of new Set(nodes.map((n) => n.clusterId))) {
    const latest = await latestRevision(db, clusterId);
    if (!latest) continue;
    const listeners = decodeNodeConfig(latest.ir).listeners;
    const health = allActive
      .filter((n) => n.clusterId === clusterId)
      .every((n) => nodeSupportsFeature(n.features, PROBE_HEALTH_FEATURE));
    for (const node of nodes.filter((n) => n.clusterId === clusterId))
      for (const { address } of schedulingAddressesOf(ips.get(node.id) ?? []))
        for (const listener of listeners) {
          if (listener.port < 1 || listener.port > 65535) continue;
          const method: ProbeMethodName = !health
            ? "tcp"
            : listener.protocol === ListenerProtocol.HTTPS
              ? "https"
              : listener.protocol === ListenerProtocol.HTTP
                ? "http"
                : "tcp";
          targets.push({
            nodeId: node.id,
            address,
            port: listener.port,
            method,
            proxyProtocol: listener.proxyProtocol,
          });
        }
  }
  const key = (t: ProbeTarget) => `${t.nodeId}|${t.address}|${String(t.port).padStart(5, "0")}`;
  const unique = new Map(targets.map((t) => [key(t), t]));
  return [...unique.values()].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

export interface ReportedResult {
  nodeId: string;
  address: string;
  port: number;
  sent: number;
  lost: number;
  rttMs: number;
  error: string;
}

/**
 * Stores one round: results for targets the prober has now (others are
 * dropped: a node removed meanwhile, or made up), with 1-10 attempts, no
 * more lost than sent and a round-trip time of at most 10 s. Returns how
 * many were kept and the clusters they concern.
 */
export async function recordProbeResults(
  db: Database,
  prober: Prober,
  results: readonly ReportedResult[],
  now = new Date(),
) {
  const targets = await probeTargets(db, prober);
  const byKey = new Map(targets.map((t) => [`${t.nodeId}|${t.address}|${t.port}`, t]));
  const rows = new Map<string, typeof schema.probeResult.$inferInsert>();
  for (const r of results.slice(0, MAX_PROBE_RESULTS)) {
    const address = unicastAddress(r.address) ?? "";
    const key = `${r.nodeId}|${address}|${r.port}`;
    const target = byKey.get(key);
    if (!target) continue;
    if (!Number.isInteger(r.sent) || r.sent < 1 || r.sent > 10) continue;
    if (!Number.isInteger(r.lost) || r.lost < 0 || r.lost > r.sent) continue;
    const rttMs = r.lost === r.sent ? 0 : Math.round(r.rttMs);
    if (!Number.isFinite(rttMs) || rttMs < 0 || rttMs > MAX_RTT_MS) continue;
    rows.set(key, {
      proberKind: prober.kind,
      proberId: prober.id,
      regionId: prober.regionId,
      nodeId: target.nodeId,
      address: target.address,
      port: target.port,
      method: target.method,
      sent: r.sent,
      lost: r.lost,
      rttMs,
      error: r.lost ? r.error.replace(/[^a-z0-9_]/g, "").slice(0, 32) : "",
      checkedAt: now,
    });
  }
  const values = [...rows.values()];
  await db.transaction(async (tx) => {
    for (let i = 0; i < values.length; i += 500)
      await tx
        .insert(schema.probeResult)
        .values(values.slice(i, i + 500))
        .onConflictDoUpdate({
          target: [
            schema.probeResult.proberId,
            schema.probeResult.nodeId,
            schema.probeResult.address,
            schema.probeResult.port,
          ],
          set: {
            proberKind: prober.kind,
            regionId: prober.regionId,
            method: sqlExcluded("method"),
            sent: sqlExcluded("sent"),
            lost: sqlExcluded("lost"),
            rttMs: sqlExcluded("rtt_ms"),
            error: sqlExcluded("error"),
            checkedAt: now,
          },
        });
    if (prober.kind === "probe")
      await tx.update(schema.probe).set({ lastSeenAt: now }).where(eq(schema.probe.id, prober.id));
    // Results of probers that stopped reporting.
    await tx
      .delete(schema.probeResult)
      .where(lt(schema.probeResult.checkedAt, new Date(now.getTime() - RESULT_RETENTION_MS)));
  });
  const nodeIds = [...new Set(values.map((v) => v.nodeId))];
  const clusters = nodeIds.length
    ? await db
        .selectDistinct({ clusterId: schema.node.clusterId })
        .from(schema.node)
        .where(inArray(schema.node.id, nodeIds))
    : [];
  return { accepted: values.length, clusterIds: clusters.map((c) => c.clusterId) };
}
