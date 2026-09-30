import { createHash } from "node:crypto";
import type { TLSSocket } from "node:tls";
import { create } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  Code,
  ConnectError,
  type ContextValues,
  createContextKey,
  createContextValues,
  type HandlerContext,
  type ServiceImpl,
} from "@connectrpc/connect";
import type { ConnectNodeAdapterOptions } from "@connectrpc/connect-node";
import {
  applyNodeConfigDiff,
  decodeNodeConfig,
  diffNodeConfig,
  nodeRequirements,
} from "@edgeweir/config-compiler";
import { MAX_REPORTED_BANS, nodeSupportsFeature } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import {
  ApplyState,
  BanSchema,
  BanScope,
  BanSource,
  type BanStatus,
  GetConfigResponseSchema,
  type NodeService,
  NodeTaskSchema,
  PurgeType,
  type ReportStatsRequest,
  type ReportStatsV2Request,
  SecurityEventKind,
  TaskState,
  WatchConfigResponseSchema,
  WatchEvent,
} from "@edgeweir/proto";
import { and, eq, inArray } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { NODE_CERT_LIFETIME_DAYS } from "../pki/ca";
import { ingestLogs } from "../services/access-logs";
import { recordAudit } from "../services/audit";
import { banChanges, currentBanSequence, reportAutoBans } from "../services/bans";
import {
  type CacheTaskItem,
  hasDeliverableTasks,
  pullCacheTasks,
  reportCacheTaskResult,
} from "../services/cache-tasks";
import { nodeCertificates } from "../services/certificates";
import { challengeKeySecrets } from "../services/challenge-keys";
import { mirrorMinuteStats } from "../services/clickhouse";
import { claimEnrollmentToken } from "../services/enrollment";
import { isSerialRevoked, normalizeSerial } from "../services/nodes";
import { replaceOriginHealth } from "../services/origin-health";
import { mintRevisionReceipt, verifyRevisionReceipt } from "../services/revision-receipts";
import { getRevision, latestRevision, nodeTarget } from "../services/revisions";
import { evaluateAfterHeartbeat } from "../services/rollout";
import {
  MAX_REPORTED_SECURITY_EVENTS,
  reportSecurityEvents,
  toNodeSecurityState,
} from "../services/security";
import { s3SecretBinding } from "../services/sites";
import { ingestStatsBatch, MAX_STATS_PER_REPORT } from "../services/stats";
import {
  hasUpgradeTasks,
  pullUpgrade,
  recordUpgradeHealth,
  reportUpgrade,
} from "../services/upgrades";
import { recordStatsWatermark } from "../services/usage";

export const HEARTBEAT_SECONDS = 15;
export const KEEPALIVE_MS = 15_000;
/** Ask nodes to renew once less than a third of the lifetime remains. */
const RENEW_BEFORE_MS = (NODE_CERT_LIFETIME_DAYS * 24 * 3600 * 1000) / 3;
/** Tasks handed out per PullTasks call unless the node asks for fewer. */
export const MAX_TASKS_PER_PULL = 20;
/** Nodes with this feature receive dynamic bans (GetBans, WATCH_EVENT_BANS). */
export const BANS_FEATURE = "bans-v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UINT32_MAX = 4294967295;

/** The BanStatus of a heartbeat as stored on the node row. */
function toNodeBanStatus(status: BanStatus, now: Date): schema.NodeBanStatus {
  const count = (value: number) => Math.max(0, Math.min(Math.trunc(value), UINT32_MAX));
  return {
    appliedSequence: status.appliedSequence.toString(),
    entries: count(status.entries),
    capacity: count(status.capacity),
    unappliedIds: [...new Set(status.unappliedIds.filter((id) => UUID_RE.test(id)))]
      .slice(0, 100)
      .map((id) => id.toLowerCase()),
    unapplied: count(status.unapplied),
    kernelEntries: count(status.kernelEntries),
    autoEvicted: status.autoEvicted.toString(),
    reportedAt: now.toISOString(),
  };
}

const purgeTypes = {
  url: PurgeType.URL,
  prefix: PurgeType.PREFIX,
  site: PurgeType.SITE,
} as const;

function toNodeTask(task: { id: string; type: string; createdAt: Date; items: CacheTaskItem[] }) {
  const createdAt = timestampFromDate(task.createdAt);
  if (task.type === "prefetch") {
    return create(NodeTaskSchema, {
      id: task.id,
      createdAt,
      kind: {
        case: "prefetch",
        value: { targets: task.items.map((i) => ({ siteId: i.siteId, url: i.url })) },
      },
    });
  }
  return create(NodeTaskSchema, {
    id: task.id,
    createdAt,
    kind: {
      case: "purge",
      value: {
        targets: task.items.map((i) => ({
          siteId: i.siteId,
          type: purgeTypes[i.type as keyof typeof purgeTypes] ?? PurgeType.UNSPECIFIED,
          host: i.host,
          path: i.path,
          query: i.query,
        })),
      },
    },
  });
}

export interface PeerInfo {
  authorized: boolean;
  authorizationError?: string;
  commonName?: string;
  serialNumber?: string;
  fingerprintSha256?: string;
  remoteAddress?: string;
}

export const peerKey = createContextKey<PeerInfo>({ authorized: false });

type NodeServerRequest = Parameters<NonNullable<ConnectNodeAdapterOptions["contextValues"]>>[0];

function tlsSocketOf(req: NodeServerRequest): TLSSocket | undefined {
  const h2 = req as { stream?: { session?: { socket?: TLSSocket } } };
  return h2.stream?.session?.socket ?? (req.socket as TLSSocket | undefined);
}

/** Extracts the verified client certificate (if any) for every request. */
export function peerContextValues(req: NodeServerRequest): ContextValues {
  const socket = tlsSocketOf(req);
  const info: PeerInfo = { authorized: false, remoteAddress: socket?.remoteAddress };
  if (socket && typeof socket.getPeerCertificate === "function") {
    const cert = socket.getPeerCertificate(false);
    info.authorized = socket.authorized === true;
    if (socket.authorizationError) info.authorizationError = String(socket.authorizationError);
    if (cert && Object.keys(cert).length > 0 && cert.raw) {
      const cn = cert.subject?.CN;
      info.commonName = Array.isArray(cn) ? cn[0] : cn;
      info.serialNumber = cert.serialNumber?.toLowerCase();
      info.fingerprintSha256 = createHash("sha256").update(cert.raw).digest("hex");
    }
  }
  return createContextValues().set(peerKey, info);
}

export function createNodeService(app: AppContext): ServiceImpl<typeof NodeService> {
  const log = app.log.child({ component: "node-channel" });

  /** mTLS gate for every RPC except Enroll. */
  async function requireNode(ctx: HandlerContext) {
    const peer = ctx.values.get(peerKey);
    if (!peer.authorized || !peer.commonName) {
      throw new ConnectError(
        "client certificate required (mutual TLS); enroll first",
        Code.Unauthenticated,
      );
    }
    if (await isSerialRevoked(app.db, peer.serialNumber)) {
      throw new ConnectError("certificate has been revoked", Code.Unauthenticated);
    }
    const [row] = await app.db
      .select()
      .from(schema.node)
      .where(eq(schema.node.id, peer.commonName));
    if (!row) throw new ConnectError("unknown node", Code.Unauthenticated);
    if (row.status !== "active") throw new ConnectError("node is disabled", Code.PermissionDenied);
    if (normalizeSerial(row.certSerial) !== normalizeSerial(peer.serialNumber)) {
      throw new ConnectError("certificate has been superseded", Code.Unauthenticated);
    }
    return row;
  }

  /** The node's target revision, with its current node group. */
  async function currentTarget(nodeId: string) {
    const [row] = await app.db
      .select({ clusterId: schema.node.clusterId, nodeGroupId: schema.node.nodeGroupId })
      .from(schema.node)
      .where(eq(schema.node.id, nodeId));
    return row ? nodeTarget(app.db, row) : undefined;
  }

  /** Ends an open watch stream once its node is disabled, deleted or re-keyed. */
  async function assertStillActive(node: { id: string; certSerial: string | null }) {
    const [row] = await app.db
      .select({ status: schema.node.status, certSerial: schema.node.certSerial })
      .from(schema.node)
      .where(eq(schema.node.id, node.id));
    if (!row) throw new ConnectError("unknown node", Code.Unauthenticated);
    if (row.status !== "active") throw new ConnectError("node is disabled", Code.PermissionDenied);
    if (normalizeSerial(row.certSerial) !== normalizeSerial(node.certSerial)) {
      throw new ConnectError("certificate has been superseded", Code.Unauthenticated);
    }
  }

  const statsHandler = async (
    req: Pick<ReportStatsRequest, "stats" | "batchSequence"> & {
      completeUntil?: ReportStatsV2Request["completeUntil"];
    },
    ctx: HandlerContext,
  ) => {
    const node = await requireNode(ctx);
    if (req.batchSequence === 0n && req.stats.length === 0) {
      // The node's statistics watermark comes with a cursor query once nothing is pending.
      if (req.completeUntil)
        await recordStatsWatermark(app.db, node.id, timestampDate(req.completeUntil));
      const [cursor] = await app.db
        .select()
        .from(schema.nodeStatsCursor)
        .where(eq(schema.nodeStatsCursor.nodeId, node.id));
      return { accepted: 0, batchSequence: cursor?.sequence ?? 0n };
    }
    if (req.batchSequence < 1n || req.batchSequence > 9223372036854775807n)
      throw new ConnectError(
        "statistics sequence required; upgrade the node",
        Code.FailedPrecondition,
      );
    const accepted = await ingestStatsBatch(
      app.db,
      node,
      req.batchSequence,
      req.stats.slice(0, MAX_STATS_PER_REPORT).flatMap((s) =>
        s.minute && s.siteId
          ? [
              {
                minute: timestampDate(s.minute),
                siteId: s.siteId,
                requests: Number(s.requests),
                bytesSent: Number(s.bytesSent),
                bytesReceived: Number(s.bytesReceived),
                cacheHits: Number(s.cacheHits),
                cacheMisses: Number(s.cacheMisses),
                topUrls: Object.fromEntries(s.topUrls.map((v) => [v.value, Number(v.count)])),
                topIps: Object.fromEntries(s.topIps.map((v) => [v.value, Number(v.count)])),
                wafRules: Object.fromEntries(s.wafRules.map((v) => [v.value, Number(v.count)])),
                statusCodes: Object.fromEntries(
                  Object.entries(s.statusCodes).map(([code, n]) => [code, Number(n)]),
                ),
              },
            ]
          : [],
      ),
      undefined,
      app.env.EDGEWEIR_ANALYTICS === "clickhouse"
        ? (tx) =>
            mirrorMinuteStats(
              app.env,
              tx,
              node.id,
              req.batchSequence,
              req.stats
                .slice(0, MAX_STATS_PER_REPORT)
                .flatMap((s) =>
                  s.minute
                    ? [{ siteId: s.siteId, minute: timestampDate(s.minute).toISOString() }]
                    : [],
                ),
            )
        : undefined,
    );
    if (req.completeUntil)
      await recordStatsWatermark(app.db, node.id, timestampDate(req.completeUntil));
    return { accepted, batchSequence: req.batchSequence };
  };

  return {
    async enroll(req, ctx) {
      const peer = ctx.values.get(peerKey);
      if (!req.token || !req.csrPem) {
        throw new ConnectError("token and csr_pem are required", Code.InvalidArgument);
      }
      const result = await app.db.transaction(async (tx) => {
        const token = await claimEnrollmentToken(tx, req.token);
        if (!token) {
          throw new ConnectError(
            "invalid, expired or already used enrollment token",
            Code.PermissionDenied,
          );
        }
        const info = req.info;
        let nodeGroupId = token.nodeGroupId;
        if (!nodeGroupId) {
          const [fallback] = await tx
            .select({ id: schema.nodeGroup.id })
            .from(schema.nodeGroup)
            .where(
              and(
                eq(schema.nodeGroup.clusterId, token.clusterId),
                eq(schema.nodeGroup.isDefault, true),
              ),
            );
          nodeGroupId = fallback?.id ?? null;
        }
        const [nodeRow] = await tx
          .insert(schema.node)
          .values({
            clusterId: token.clusterId,
            nodeGroupId,
            name: token.nodeName || info?.hostname || `node-${token.id.slice(0, 8)}`,
            hostname: info?.hostname ?? "",
            agentVersion: info?.agentVersion ?? "",
            supportedFeatures: [...new Set(info?.supportedFeatures ?? [])]
              .filter((f) => /^[a-z0-9-]{1,64}$/.test(f))
              .slice(0, 64),
            engine: info?.engine ?? "",
            engineVersion: info?.engineVersion ?? "",
            os: info?.os ?? "",
            arch: info?.arch ?? "",
          })
          .returning();
        if (!nodeRow) throw new Error("node insert failed");
        let issued: Awaited<ReturnType<typeof app.nodeCa.signNodeCsr>>;
        try {
          issued = await app.nodeCa.signNodeCsr(req.csrPem, nodeRow.id);
        } catch (error) {
          throw new ConnectError(`rejected CSR: ${(error as Error).message}`, Code.InvalidArgument);
        }
        await tx
          .update(schema.node)
          .set({
            certSerial: issued.serialNumber,
            certFingerprint: issued.fingerprintSha256,
            certNotAfter: issued.notAfter,
            enrolledAt: new Date(),
          })
          .where(eq(schema.node.id, nodeRow.id));
        const ips = [...new Set(info?.ipAddresses ?? [])].slice(0, 64);
        if (ips.length) {
          await tx
            .insert(schema.nodeIp)
            .values(ips.map((address) => ({ nodeId: nodeRow.id, address })))
            .onConflictDoNothing();
        }
        await tx
          .update(schema.enrollmentToken)
          .set({ usedAt: new Date(), usedByNodeId: nodeRow.id })
          .where(eq(schema.enrollmentToken.id, token.id));
        await recordAudit(
          tx,
          { type: "node", id: nodeRow.id, name: nodeRow.name, ip: peer.remoteAddress ?? "" },
          {
            action: "node.enroll",
            targetType: "node",
            targetId: nodeRow.id,
            targetName: nodeRow.name,
            metadata: {
              clusterId: token.clusterId,
              tokenId: token.id,
              hostname: info?.hostname ?? "",
              certSerial: issued.serialNumber,
            },
          },
        );
        return { nodeRow, issued };
      });
      log.info("node enrolled", { nodeId: result.nodeRow.id, name: result.nodeRow.name });
      return {
        nodeId: result.nodeRow.id,
        clusterId: result.nodeRow.clusterId,
        nodeName: result.nodeRow.name,
        certificatePem: result.issued.certificatePem,
        caCertificatePem: app.nodeCa.certificatePem,
        notAfter: timestampFromDate(result.issued.notAfter),
      };
    },

    async renewCertificate(req, ctx) {
      const node = await requireNode(ctx);
      let issued: Awaited<ReturnType<typeof app.nodeCa.signNodeCsr>>;
      try {
        issued = await app.nodeCa.signNodeCsr(req.csrPem, node.id);
      } catch (error) {
        throw new ConnectError(`rejected CSR: ${(error as Error).message}`, Code.InvalidArgument);
      }
      await app.db.transaction(async (tx) => {
        await tx
          .update(schema.node)
          .set({
            certSerial: issued.serialNumber,
            certFingerprint: issued.fingerprintSha256,
            certNotAfter: issued.notAfter,
          })
          .where(eq(schema.node.id, node.id));
        await recordAudit(
          tx,
          { type: "node", id: node.id, name: node.name },
          {
            action: "node.certificate_renew",
            targetType: "node",
            targetId: node.id,
            targetName: node.name,
            metadata: { certSerial: issued.serialNumber },
          },
        );
      });
      return {
        certificatePem: issued.certificatePem,
        caCertificatePem: app.nodeCa.certificatePem,
        notAfter: timestampFromDate(issued.notAfter),
      };
    },

    async *watchConfig(_req, ctx) {
      const node = await requireNode(ctx);
      const queue: { revision: number; contentHash: string }[] = [];
      let tasksPending = false;
      let wake: (() => void) | undefined;
      const push = (item: { revision: number; contentHash: string }) => {
        queue.push(item);
        wake?.();
      };
      // A node follows its own target: the candidate in a canary group, else the stable revision.
      const refresh = async () => {
        const target = await currentTarget(node.id);
        if (target) push({ revision: target.revision, contentHash: target.contentHash });
        if (await hasDeliverableTasks(app.db, node.id)) {
          tasksPending = true;
          wake?.();
        }
      };
      const offConfig = app.events.on("config", (e) => {
        if (e.clusterId === node.clusterId) void refresh();
      });
      const offTasks = app.events.on("tasks", (e) => {
        if (e.clusterIds.includes(node.clusterId)) {
          tasksPending = true;
          wake?.();
        }
      });
      // Nodes with bans-v1 learn the ban sequence when the stream opens and on every change.
      const bans = nodeSupportsFeature(node.supportedFeatures, BANS_FEATURE);
      let bansPending = bans;
      const offBans = app.events.on("bans", (e) => {
        if (bans && (e.clusterIds === null || e.clusterIds.includes(node.clusterId))) {
          bansPending = true;
          wake?.();
        }
      });
      const offReconnect = app.events.on("reconnected", () => {
        bansPending ||= bans;
        void refresh();
      });
      const onAbort = () => wake?.();
      ctx.signal.addEventListener("abort", onAbort);
      log.info("watch stream opened", { nodeId: node.id });
      try {
        await refresh();
        if (queue.length === 0) {
          yield create(WatchConfigResponseSchema, {
            event: WatchEvent.REVISION,
            latestRevision: 0n,
          });
        }
        let lastSent = -1;
        while (!ctx.signal.aborted) {
          if (tasksPending) {
            tasksPending = false;
            yield create(WatchConfigResponseSchema, {
              event: WatchEvent.TASKS,
              latestRevision: BigInt(Math.max(lastSent, 0)),
            });
            continue;
          }
          if (queue.length === 0 && !bansPending) {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, KEEPALIVE_MS);
              wake = () => {
                clearTimeout(timer);
                resolve();
              };
            });
            wake = undefined;
          }
          if (ctx.signal.aborted) break;
          await assertStillActive(node);
          if (tasksPending) continue;
          const item = queue
            .splice(0)
            .reduce<{ revision: number; contentHash: string } | undefined>(
              (max, cur) => (!max || cur.revision > max.revision ? cur : max),
              undefined,
            );
          if (item && item.revision !== lastSent) {
            lastSent = item.revision;
            yield create(WatchConfigResponseSchema, {
              event: WatchEvent.REVISION,
              latestRevision: BigInt(item.revision),
              contentHash: item.contentHash,
            });
          } else if (!item && !bansPending) {
            yield create(WatchConfigResponseSchema, {
              event: WatchEvent.KEEPALIVE,
              latestRevision: BigInt(Math.max(lastSent, 0)),
            });
          }
          if (bansPending) {
            bansPending = false;
            yield create(WatchConfigResponseSchema, {
              event: WatchEvent.BANS,
              latestRevision: BigInt(Math.max(lastSent, 0)),
              banSequence: await currentBanSequence(app.db),
            });
          }
        }
      } finally {
        offConfig();
        offTasks();
        offBans();
        offReconnect();
        ctx.signal.removeEventListener("abort", onAbort);
        log.info("watch stream closed", { nodeId: node.id });
      }
    },

    async getConfig(req, ctx) {
      const node = await requireNode(ctx);
      const own = await nodeTarget(app.db, node);
      // A node never gets a revision newer than its target (a canary candidate
      // stays with the canary nodes).
      if (req.revision !== 0n && own && req.revision > BigInt(own.revision))
        throw new ConnectError("revision is not published to this node", Code.FailedPrecondition);
      const target =
        req.revision === 0n ? own : await getRevision(app.db, node.clusterId, Number(req.revision));
      if (!target) throw new ConnectError("revision not found", Code.NotFound);
      const snapshot = decodeNodeConfig(target.ir);
      if (
        nodeRequirements(snapshot).some(
          (feature) => !nodeSupportsFeature(node.supportedFeatures, feature),
        )
      ) {
        throw new ConnectError(
          "agent upgrade required for this configuration",
          Code.FailedPrecondition,
        );
      }
      const generatedAt = timestampFromDate(new Date());
      const revisionReceipt = mintRevisionReceipt(app, node, target.revision, target.contentHash);
      if (req.baseRevision > 0n && req.baseRevision < BigInt(target.revision)) {
        const base = await getRevision(app.db, node.clusterId, Number(req.baseRevision));
        if (base) {
          const baseConfig = decodeNodeConfig(base.ir);
          const diff = diffNodeConfig(baseConfig, snapshot);
          // Self-check before shipping: the diff must reproduce the snapshot.
          applyNodeConfigDiff(baseConfig, diff);
          return create(GetConfigResponseSchema, {
            payload: { case: "diff", value: diff },
            generatedAt,
            revisionReceipt,
          });
        }
      }
      return create(GetConfigResponseSchema, {
        payload: { case: "snapshot", value: snapshot },
        generatedAt,
        revisionReceipt,
      });
    },

    async reportStatus(req, ctx) {
      const node = await requireNode(ctx);
      const peer = ctx.values.get(peerKey);
      const now = new Date();
      if (req.appliedRevision < 0n || req.appliedRevision >= BigInt(Number.MAX_SAFE_INTEGER))
        throw new ConnectError("invalid applied revision", Code.InvalidArgument);
      const issued = await latestRevision(app.db, node.clusterId);
      const revisionReceiptVerified = verifyRevisionReceipt(
        app,
        node,
        Number(req.appliedRevision),
        req.appliedContentHash,
        req.revisionReceipt,
      );
      if (req.appliedRevision > BigInt(issued?.revision ?? 0) && !revisionReceiptVerified)
        throw new ConnectError(
          "unverifiable restored revision; a persisted console receipt is required",
          Code.FailedPrecondition,
        );
      const info = req.info;
      const state =
        req.state === ApplyState.APPLIED
          ? "applied"
          : req.state === ApplyState.FAILED
            ? "failed"
            : "applying";
      await app.db.transaction(async (tx) => {
        await tx
          .update(schema.node)
          .set({
            lastSeenAt: now,
            // Nodes without bans-v1 send no BanStatus.
            banStatus: req.bans ? toNodeBanStatus(req.bans, now) : null,
            // Sites above the normal CC level; nodes without challenge-v1 send none.
            securityState: toNodeSecurityState(req.security),
            ...(info
              ? {
                  hostname: info.hostname || node.hostname,
                  agentVersion: info.agentVersion,
                  supportedFeatures: [...new Set(info.supportedFeatures)]
                    .filter((f) => /^[a-z0-9-]{1,64}$/.test(f))
                    .slice(0, 64),
                  engine: info.engine,
                  engineVersion: info.engineVersion,
                  os: info.os,
                  arch: info.arch,
                }
              : {}),
          })
          .where(eq(schema.node.id, node.id));
        const values = {
          nodeId: node.id,
          appliedRevision: Number(req.appliedRevision),
          revisionReceiptVerified,
          appliedContentHash: req.appliedContentHash,
          state,
          message: req.message.slice(0, 4000),
          dataPlaneHealthy: req.dataPlaneHealthy,
          appliedAt: req.appliedAt ? timestampDate(req.appliedAt) : null,
          reportedAt: now,
        };
        await tx
          .insert(schema.nodeConfigStatus)
          .values(values)
          .onConflictDoUpdate({ target: schema.nodeConfigStatus.nodeId, set: values });
        await recordUpgradeHealth(
          tx,
          { ...node, agentVersion: info?.agentVersion ?? node.agentVersion },
          values,
          now,
        );
        const ips = [...new Set(info?.ipAddresses ?? [])].slice(0, 64);
        if (ips.length) {
          await tx
            .insert(schema.nodeIp)
            .values(ips.map((address) => ({ nodeId: node.id, address })))
            .onConflictDoNothing();
        }
        await replaceOriginHealth(
          tx,
          node,
          req.originHealth.slice(0, 2000).map((h) => ({
            siteId: h.siteId,
            originId: h.originId,
            healthy: h.healthy,
            consecutiveFailures: h.consecutiveFailures,
            lastError: h.lastError,
            lastErrorCode: h.lastErrorCode,
            lastErrorParams: h.lastErrorParams,
            lastFailureAt: h.lastFailureAt ? timestampDate(h.lastFailureAt) : null,
            downUntil: h.downUntil ? timestampDate(h.downUntil) : null,
          })),
          now,
        );
      });
      const latest = await currentTarget(node.id);
      await evaluateAfterHeartbeat(app, node);
      const tasksPending =
        (await hasDeliverableTasks(app.db, node.id)) || (await hasUpgradeTasks(app.db, node.id));
      const expiresIn = (node.certNotAfter?.getTime() ?? 0) - now.getTime();
      log.debug("status", {
        nodeId: node.id,
        applied: Number(req.appliedRevision),
        state,
        remote: peer.remoteAddress,
      });
      return {
        latestRevision: BigInt(latest?.revision ?? 0),
        renewCertificate: expiresIn < RENEW_BEFORE_MS,
        reportIntervalSeconds: HEARTBEAT_SECONDS,
        tasksPending,
      };
    },

    async reportLogs(req, ctx) {
      const node = await requireNode(ctx);
      if (req.batchSequence === 0n && !req.logs.length) {
        const [cursor] = await app.db
          .select()
          .from(schema.nodeLogCursor)
          .where(eq(schema.nodeLogCursor.nodeId, node.id));
        return { accepted: 0, batchSequence: cursor?.sequence ?? 0n };
      }
      return {
        accepted: await ingestLogs(app, node, req.batchSequence, req.logs),
        batchSequence: req.batchSequence,
      };
    },
    reportStats: statsHandler,
    reportStatsV2: statsHandler,

    async getCertificates(req, ctx) {
      const node = await requireNode(ctx);
      return { certificates: await nodeCertificates(app, node.clusterId, req.ids) };
    },

    async getOriginCredentials(req, ctx) {
      const node = await requireNode(ctx);
      const ids = [...new Set(req.ids)].filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 1000);
      if (ids.length === 0) return { credentials: [] };
      // Only credentials of sites served by the node's own cluster.
      const rows = await app.db
        .select({ credential: schema.originCredential })
        .from(schema.originCredential)
        .innerJoin(schema.site, eq(schema.site.id, schema.originCredential.siteId))
        .where(
          and(inArray(schema.originCredential.id, ids), eq(schema.site.clusterId, node.clusterId)),
        );
      const credentials = rows.flatMap(({ credential }) => {
        try {
          const secret = app.masterKey.open(
            JSON.parse(credential.secretEnvelope),
            s3SecretBinding(credential.id),
          );
          return [
            {
              id: credential.id,
              version: BigInt(credential.version),
              accessKeyId: credential.accessKeyId,
              secretAccessKey: secret.toString("utf8"),
            },
          ];
        } catch (error) {
          log.error("cannot open origin credential", { credentialId: credential.id, error });
          return [];
        }
      });
      log.info("origin credentials delivered", {
        nodeId: node.id,
        credentials: credentials.map((c) => c.id),
      });
      return { credentials };
    },

    async pullTasks(req, ctx) {
      const node = await requireNode(ctx);
      const max = Math.min(req.maxTasks || MAX_TASKS_PER_PULL, MAX_TASKS_PER_PULL);
      const upgrade = await pullUpgrade(app, node);
      const limit = max - (upgrade ? 1 : 0);
      const tasks = limit > 0 ? await pullCacheTasks(app.db, node, limit) : [];
      return { tasks: [...tasks.map(toNodeTask), ...(upgrade ? [upgrade] : [])] };
    },

    async reportTaskResult(req, ctx) {
      const node = await requireNode(ctx);
      if (!/^[0-9a-f-]{36}$/i.test(req.taskId)) {
        throw new ConnectError("invalid task_id", Code.InvalidArgument);
      }
      if (req.state !== TaskState.SUCCEEDED && req.state !== TaskState.FAILED) {
        throw new ConnectError("state must be SUCCEEDED or FAILED", Code.InvalidArgument);
      }
      if (await reportUpgrade(app, node.id, req)) return {};
      const recorded = await reportCacheTaskResult(app.db, node, {
        taskId: req.taskId,
        state: req.state === TaskState.SUCCEEDED ? "succeeded" : "failed",
        message: req.message,
        errorCode: req.errorCode,
        errorParams: req.errorParams,
        succeeded: req.succeeded,
        failed: req.failed,
        finishedAt: req.finishedAt ? timestampDate(req.finishedAt) : new Date(),
      });
      log.info("task result", {
        nodeId: node.id,
        taskId: req.taskId,
        state: TaskState[req.state],
        recorded,
      });
      return {};
    },

    async getBans(req, ctx) {
      const node = await requireNode(ctx);
      const page = await banChanges(app.db, node.clusterId, req.afterSequence, req.limit);
      return {
        reset: page.reset,
        bans: page.bans.map((ban) =>
          create(BanSchema, {
            id: ban.id,
            cidr: ban.cidr,
            scope: ban.scope === "platform" ? BanScope.PLATFORM : BanScope.SITE,
            siteId: ban.siteId ?? "",
            expiresAt: timestampFromDate(ban.expiresAt),
            source: ban.source === "auto" ? BanSource.AUTO : BanSource.MANUAL,
            reason: ban.reason,
            createdAt: timestampFromDate(ban.createdAt),
          }),
        ),
        removedIds: page.removedIds,
        sequence: page.sequence,
        more: page.more,
      };
    },

    async reportBans(req, ctx) {
      const node = await requireNode(ctx);
      if (req.bans.length > MAX_REPORTED_BANS)
        throw new ConnectError(
          `at most ${MAX_REPORTED_BANS} bans per request`,
          Code.InvalidArgument,
        );
      const accepted = await reportAutoBans(
        app.db,
        node,
        req.bans.map((ban) => ({
          siteId: ban.siteId,
          cidr: ban.cidr,
          createdAt: ban.createdAt ? timestampDate(ban.createdAt) : null,
          expiresAt: ban.expiresAt ? timestampDate(ban.expiresAt) : null,
          reason: ban.reason,
          metric: ban.metric,
          observed: ban.observed,
          threshold: ban.threshold,
          windowSeconds: ban.windowSeconds,
        })),
      );
      log.debug("automatic bans", { nodeId: node.id, reported: req.bans.length, accepted });
      return { accepted };
    },

    async getChallengeKeys(req, ctx) {
      const node = await requireNode(ctx);
      // Only keys of the node's own cluster; unknown ids are left out.
      const keys = await challengeKeySecrets(app, node.clusterId, req.ids);
      log.info("challenge keys delivered", { nodeId: node.id, keys: keys.map((k) => k.id) });
      return { keys };
    },

    async reportSecurityEvents(req, ctx) {
      const node = await requireNode(ctx);
      if (req.events.length > MAX_REPORTED_SECURITY_EVENTS)
        throw new ConnectError(
          `at most ${MAX_REPORTED_SECURITY_EVENTS} events per request`,
          Code.InvalidArgument,
        );
      const kinds = {
        [SecurityEventKind.SITE_LEVEL]: "site_level",
        [SecurityEventKind.PATH_LEVEL]: "path_level",
        [SecurityEventKind.IP_BANNED]: "ip_banned",
      } as const;
      const accepted = await reportSecurityEvents(
        app.db,
        node,
        req.events.map((event) => ({
          id: event.id,
          siteId: event.siteId,
          occurredAt: event.occurredAt ? timestampDate(event.occurredAt) : null,
          kind: kinds[event.kind as keyof typeof kinds] ?? null,
          level: event.level,
          previousLevel: event.previousLevel,
          path: event.path,
          address: event.address,
          metric: event.metric,
          observed: event.observed,
          threshold: event.threshold,
          topIps: event.topIps.map((t) => ({ value: t.value, count: Number(t.count) })),
          topPaths: event.topPaths.map((t) => ({ value: t.value, count: Number(t.count) })),
        })),
      );
      log.debug("security events", { nodeId: node.id, reported: req.events.length, accepted });
      return { accepted };
    },
  };
}
