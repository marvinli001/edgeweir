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
import {
  CHANNEL_FOLLOW_FEATURE,
  formatIp,
  MAX_REPORTED_BANS,
  nodeSupportsFeature,
  parseIp,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import {
  ApplyState,
  BanAction,
  BanSchema,
  BanScope,
  BanSource,
  type BanStatus,
  type CacheZoneUsage,
  DeviceVariant,
  GetConfigResponseSchema,
  type NodeLocation,
  type NodeMetrics,
  type NodeService,
  NodeTaskSchema,
  OriginHealthSource,
  PurgeType,
  type ReportStatsRequest,
  type ReportStatsV2Request,
  SecurityEventKind,
  TaskState,
} from "@edgeweir/proto";
import { and, eq, inArray, isNotNull, ne } from "drizzle-orm";
import { accessAuthSecretBinding } from "../lib/access-auth-secrets";
import type { AppContext } from "../lib/context";
import { heartbeatSeconds } from "../lib/node-online";
import { PURGE_KEY, siteSecretBinding } from "../lib/site-secrets";
import { NODE_CERT_LIFETIME_DAYS, NODE_ORGANIZATION } from "../pki/ca";
import { ingestLogs } from "../services/access-logs";
import { recordAudit } from "../services/audit";
import { nudgeAutoMitigation } from "../services/auto-mitigation";
import { banChanges, currentBanSequence, reportAutoBans } from "../services/bans";
import {
  type CacheTaskItem,
  createCacheTask,
  deviceTypeSites,
  hasDeliverableTasks,
  PurgeMethodLimited,
  pullCacheTasks,
  purgeMethodRetryAfter,
  reportCacheTaskResult,
} from "../services/cache-tasks";
import {
  changedCertificates,
  syncCertificateFailureAlerts,
  toCertificateFailures,
} from "../services/certificate-failures";
import { nodeCertificates } from "../services/certificates";
import { challengeKeySecrets } from "../services/challenge-keys";
import { nodeProviderSecrets } from "../services/challenge-providers";
import { mirrorMinuteStats } from "../services/clickhouse";
import { claimEnrollmentToken, findEnrollmentToken } from "../services/enrollment";
import { locateAddressOf, nodeIpRows } from "../services/node-addresses";
import {
  hasDebugLogTasks,
  pullDebugLogTask,
  reportDebugLogResult,
  uploadDebugLogs,
} from "../services/node-debug-logs";
import {
  hasDecommissionTask,
  pullDecommissionTask,
  reportDecommissionResult,
} from "../services/node-decommission";
import { ingestNodeLogs, nodeLogCursor } from "../services/node-logs";
import { acceptedCertificate, isSerialRevoked, replaceReportedAddresses } from "../services/nodes";
import { replaceOriginHealth } from "../services/origin-health";
import { nodeOriginClientCertificates } from "../services/origin-pki";
import { mintRevisionReceipt, verifyRevisionReceipt } from "../services/revision-receipts";
import { getRevision, latestRevision, nodeTarget } from "../services/revisions";
import { evaluateAfterHeartbeat } from "../services/rollout";
import {
  MAX_REPORTED_SECURITY_EVENTS,
  reportSecurityEvents,
  toNodeSecurityState,
} from "../services/security";
import { sessionTicketKeySecrets } from "../services/session-ticket-keys";
import { s3SecretBinding } from "../services/sites";
import { ingestStatsBatch, MAX_STATS_PER_REPORT } from "../services/stats";
import {
  hasUpgradeTasks,
  pullUpgrade,
  recordUpgradeHealth,
  reportUpgrade,
} from "../services/upgrades";
import { recordStatsWatermark } from "../services/usage";
import { channelAddressFor, channelData } from "./channel-status";
import {
  certificateColumns,
  issuedCertificateResponse,
  keptSerial,
  nodeInfoColumns,
  signCsr,
} from "./identity";
import { watchStream } from "./watch";
import { bridgedClientAddress } from "./websocket";

const KEEPALIVE_MS = 15_000;

/**
 * WatchConfig streams one node may hold at once: a new one ends the oldest.
 * A node needs one (two while it reconnects); more only multiply the reads
 * every publish and keepalive costs.
 */
export const MAX_WATCH_STREAMS = 2;
/** Ask nodes to renew once less than a third of the lifetime remains. */
const RENEW_BEFORE_MS = (NODE_CERT_LIFETIME_DAYS * 24 * 3600 * 1000) / 3;
/** Tasks handed out per PullTasks call unless the node asks for fewer. */
const MAX_TASKS_PER_PULL = 20;
/** Nodes with this feature receive dynamic bans (GetBans, WATCH_EVENT_BANS). */
const BANS_FEATURE = "bans-v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UINT32_MAX = 4294967295;
/** A proto map of counters (uint64 values) as numbers. */
const counts = (values: Record<string, bigint>) =>
  Object.fromEntries(Object.entries(values).map(([key, n]) => [key, Number(n)]));

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
    connectionLimitsActive: status.connectionLimitsActive,
    // The node's message, shown as it is: printable and short.
    connectionLimitsError: status.connectionLimitsError.replace(/[^\x20-\x7e]/g, " ").slice(0, 300),
  };
}

/** ReportStatusRequest.clock_offset_millis as stored (an integer column: ±24 days at most). */
function clockOffset(millis: bigint): number {
  const limit = 2n ** 31n - 1n;
  return Number(millis > limit ? limit : millis < -limit ? -limit : millis);
}

/**
 * ReportStatusRequest.location as stored on the node row: an uppercase
 * two-letter country or "", a short subdivision, coordinates only as a
 * finite pair within range.
 */
function toNodeLocation(l: NodeLocation, now: Date): schema.NodeLocationData {
  const country = /^[A-Z]{2}$/.test(l.country) ? l.country : "";
  const latitude = l.latitude ?? Number.NaN;
  const longitude = l.longitude ?? Number.NaN;
  const placed = country !== "" && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
  return {
    address: l.address.slice(0, 64),
    country,
    subdivision: country ? l.subdivision.slice(0, 64) : "",
    latitude: placed ? latitude : null,
    longitude: placed ? longitude : null,
    reportedAt: now.toISOString(),
  };
}

/** ReportStatusRequest.metrics as stored on the node row: finite, non-negative, CPU 0-100. */
function toNodeMetrics(m: NodeMetrics, now: Date): schema.NodeMetricsData {
  const real = (value: number, max = Number.MAX_SAFE_INTEGER) =>
    Number.isFinite(value) ? Math.min(Math.max(value, 0), max) : 0;
  const count = (value: bigint) =>
    Number(value < 0n ? 0n : value > 9007199254740991n ? 9007199254740991n : value);
  return {
    cpuPercent: real(m.cpuPercent, 100),
    load1: real(m.load1, 1e6),
    load5: real(m.load5, 1e6),
    load15: real(m.load15, 1e6),
    memoryUsedBytes: count(m.memoryUsedBytes),
    memoryTotalBytes: count(m.memoryTotalBytes),
    egressBps: count(m.egressBps),
    activeConnections: count(m.activeConnections),
    reportedAt: now.toISOString(),
  };
}

/** ReportStatusRequest.cache_usage as stored on the node row (bounded, at most 8 zones). */
function toNodeCacheUsage(zones: CacheZoneUsage[], now: Date): schema.NodeCacheUsage {
  const bytes = (value: bigint) =>
    Number(value < 0n ? 0n : value > 9007199254740991n ? 9007199254740991n : value);
  return {
    zones: zones.slice(0, 8).map((zone) => ({
      name: zone.name.slice(0, 64),
      usedBytes: bytes(zone.usedBytes),
      maxBytes: bytes(zone.maxBytes),
      measuredAt: (zone.measuredAt ? timestampDate(zone.measuredAt) : now).toISOString(),
    })),
    reportedAt: now.toISOString(),
  };
}

/** The region of the node's group (where a node that also probes probes from), or null. */
export async function nodeProbeRegion(
  db: AppContext["db"],
  node: { nodeGroupId: string | null },
): Promise<string | null> {
  if (!node.nodeGroupId) return null;
  const [group] = await db
    .select({ regionId: schema.nodeGroup.regionId })
    .from(schema.nodeGroup)
    .where(eq(schema.nodeGroup.id, node.nodeGroupId));
  return group?.regionId ?? null;
}

const purgeTypes = {
  url: PurgeType.URL,
  prefix: PurgeType.PREFIX,
  site: PurgeType.SITE,
  host: PurgeType.HOST,
  tag: PurgeType.TAG,
} as const;

/**
 * The device variants nodes request for an item: one desktop request unless
 * the site's cache key separates devices, then every variant asked for.
 * Desktop stays UNSPECIFIED there, as nodes before prefetch-v2 send it.
 */
function itemVariants(item: CacheTaskItem, deviceType: ReadonlySet<string>): DeviceVariant[] {
  if (!deviceType.has(item.siteId)) return [DeviceVariant.UNSPECIFIED];
  const asked = item.variants ?? ["desktop"];
  return [
    ...(asked.includes("desktop") ? [DeviceVariant.DESKTOP] : []),
    ...(asked.includes("mobile") ? [DeviceVariant.MOBILE] : []),
  ];
}

/**
 * A pulled cache task as the node runs it. `deviceType` holds the sites
 * whose cache key separates mobile and desktop user agents now: only they
 * get mobile prefetch targets.
 */
function toNodeTask(
  task: { id: string; type: string; createdAt: Date; items: CacheTaskItem[] },
  deviceType: ReadonlySet<string>,
) {
  const createdAt = timestampFromDate(task.createdAt);
  if (task.type === "prefetch") {
    return create(NodeTaskSchema, {
      id: task.id,
      createdAt,
      kind: {
        case: "prefetch",
        value: {
          targets: task.items.flatMap((i) =>
            itemVariants(i, deviceType).map((variant) => ({
              siteId: i.siteId,
              url: i.url,
              variant,
            })),
          ),
        },
      },
    });
  }
  const sitemap = task.type === "sitemap" ? task.items[0] : undefined;
  if (sitemap) {
    return create(NodeTaskSchema, {
      id: task.id,
      createdAt,
      kind: {
        case: "sitemap",
        value: {
          siteId: sitemap.siteId,
          url: sitemap.url,
          maxUrls: sitemap.maxUrls ?? 1000,
          // Named explicitly: a sitemap task needs prefetch-v2 anyway.
          variants: itemVariants(sitemap, deviceType).map((variant) =>
            variant === DeviceVariant.UNSPECIFIED ? DeviceVariant.DESKTOP : variant,
          ),
        },
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
          tag: i.tag ?? "",
        })),
      },
    },
  });
}

export interface PeerInfo {
  authorized: boolean;
  authorizationError?: string;
  commonName?: string;
  /** Subject organization: "Edgeweir Node" for nodes, "Edgeweir Probe" for probes. */
  organization?: string;
  serialNumber?: string;
  fingerprintSha256?: string;
  remoteAddress?: string;
  /** The TLS server name the client sent (SNI); none for an IP address. */
  serverName?: string;
  /** The connection came through the WebSocket entry. */
  webSocket?: boolean;
}

export const peerKey = createContextKey<PeerInfo>({ authorized: false });

/**
 * Why a request without an accepted client certificate is refused. With a
 * certificate the TLS layer rejected, its OpenSSL verify code is named (an
 * expired one, i.e. a node offline past its renewal, says how to recover).
 */
export function clientCertificateError(peer: PeerInfo): string {
  if (!peer.fingerprintSha256 || !peer.authorizationError)
    return "client certificate required (mutual TLS); enroll first";
  if (peer.authorizationError === "CERT_HAS_EXPIRED")
    return "client certificate has expired (CERT_HAS_EXPIRED); re-enroll with `edgeweir-node enroll --force`";
  return `client certificate rejected (${peer.authorizationError})`;
}

/** Refusals recorded on a node at most this often. */
const AUTH_ERROR_RECORD_MS = 60_000;
const authErrorRecorded = new Map<string, number>();

/**
 * Records on the node why the TLS layer refused its certificate, when the
 * certificate is the node's own (CN = node id, its current fingerprint),
 * so the console can show an expired certificate. At most once a minute
 * per node; never fails the request.
 */
export async function recordRefusedCertificate(
  app: Pick<AppContext, "db" | "log">,
  peer: PeerInfo,
  now = new Date(),
): Promise<boolean> {
  const code = peer.authorizationError;
  const nodeId = peer.commonName;
  if (
    !code ||
    !/^[A-Z0-9_]{1,64}$/.test(code) ||
    !nodeId ||
    !UUID_RE.test(nodeId) ||
    peer.organization !== NODE_ORGANIZATION ||
    !peer.fingerprintSha256
  )
    return false;
  const last = authErrorRecorded.get(nodeId);
  if (last !== undefined && now.getTime() - last < AUTH_ERROR_RECORD_MS) return false;
  if (authErrorRecorded.size > 10_000) authErrorRecorded.clear();
  authErrorRecorded.set(nodeId, now.getTime());
  try {
    const updated = await app.db
      .update(schema.node)
      .set({ lastAuthError: code, lastAuthErrorAt: now })
      .where(
        and(
          eq(schema.node.id, nodeId.toLowerCase()),
          eq(schema.node.certFingerprint, peer.fingerprintSha256),
        ),
      )
      .returning({ id: schema.node.id });
    return updated.length > 0;
  } catch (error) {
    app.log.debug("could not record a refused node certificate", { nodeId, error });
    return false;
  }
}

/**
 * A connection's source address as stored on the node: canonical text, an
 * IPv4-mapped address (dual-stack listeners) as IPv4, no zone; null when
 * it is not an IP address.
 */
export function normalizeRemoteAddress(address: string | undefined): string | null {
  if (!address) return null;
  const text = address.replace(/%.*$/, "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
  const ip = parseIp(text);
  return ip ? formatIp(ip) : null;
}

type NodeServerRequest = Parameters<NonNullable<ConnectNodeAdapterOptions["contextValues"]>>[0];

function tlsSocketOf(req: NodeServerRequest): TLSSocket | undefined {
  const h2 = req as { stream?: { session?: { socket?: TLSSocket } } };
  return h2.stream?.session?.socket ?? (req.socket as TLSSocket | undefined);
}

/**
 * Extracts the verified client certificate (if any) for every request. A
 * connection through the WebSocket entry comes from loopback; its address is
 * the WebSocket client's.
 */
export function peerContextValues(req: NodeServerRequest): ContextValues {
  const socket = tlsSocketOf(req);
  const bridged = bridgedClientAddress(socket?.remoteAddress, socket?.remotePort);
  const info: PeerInfo = {
    authorized: false,
    remoteAddress: bridged ?? socket?.remoteAddress,
    serverName: typeof socket?.servername === "string" ? socket.servername : undefined,
    webSocket: bridged !== undefined,
  };
  if (socket && typeof socket.getPeerCertificate === "function") {
    const cert = socket.getPeerCertificate(false);
    info.authorized = socket.authorized === true;
    if (socket.authorizationError) info.authorizationError = String(socket.authorizationError);
    if (cert && Object.keys(cert).length > 0 && cert.raw) {
      const cn = cert.subject?.CN;
      info.commonName = Array.isArray(cn) ? cn[0] : cn;
      const org = cert.subject?.O;
      info.organization = Array.isArray(org) ? org[0] : org;
      info.serialNumber = cert.serialNumber?.toLowerCase();
      info.fingerprintSha256 = createHash("sha256").update(cert.raw).digest("hex");
    }
  }
  return createContextValues().set(peerKey, info);
}

/** `closing` ends every watch stream, so the channel can shut down while nodes are connected. */
export function createNodeService(
  app: AppContext,
  { closing }: { closing?: AbortSignal } = {},
): ServiceImpl<typeof NodeService> {
  const log = app.log.child({ component: "node-channel" });
  /** Open WatchConfig streams by node, oldest first. */
  const watching = new Map<string, AbortController[]>();

  /**
   * mTLS gate for every RPC except Enroll. `disabled` lets a disabled node
   * through, for RPCs that only concern its identity.
   */
  async function requireNode(ctx: HandlerContext, { disabled = false } = {}) {
    const peer = ctx.values.get(peerKey);
    if (!peer.authorized || !peer.commonName) {
      throw new ConnectError(clientCertificateError(peer), Code.Unauthenticated);
    }
    // Probe certificates (O=Edgeweir Probe) come from the same CA and never reach NodeService.
    if (peer.organization !== NODE_ORGANIZATION || !UUID_RE.test(peer.commonName))
      throw new ConnectError("not a node certificate", Code.Unauthenticated);
    if (await isSerialRevoked(app.db, peer.serialNumber)) {
      throw new ConnectError("certificate has been revoked", Code.Unauthenticated);
    }
    const [row] = await app.db
      .select()
      .from(schema.node)
      .where(eq(schema.node.id, peer.commonName));
    if (!row) throw new ConnectError("unknown node", Code.Unauthenticated);
    if (row.status !== "active" && !disabled)
      throw new ConnectError("node is disabled", Code.PermissionDenied);
    const certificate = acceptedCertificate(row, peer.serialNumber);
    if (!certificate)
      throw new ConnectError("certificate has been superseded", Code.Unauthenticated);
    if (certificate === "current" && row.previousCertSerial) {
      // The node uses its renewed certificate: the one it replaced is no longer accepted.
      await app.db
        .update(schema.node)
        .set({ previousCertSerial: null })
        .where(and(eq(schema.node.id, row.id), eq(schema.node.certSerial, row.certSerial ?? "")));
      return { ...row, previousCertSerial: null };
    }
    return row;
  }

  /** The node's target revision, as of now. */
  async function currentTarget(nodeId: string) {
    const [row] = await app.db
      .select({ id: schema.node.id, clusterId: schema.node.clusterId })
      .from(schema.node)
      .where(eq(schema.node.id, nodeId));
    return row ? nodeTarget(app.db, row, "head") : undefined;
  }

  /** Ends an open watch stream once its node is disabled, deleted or its certificate superseded. */
  async function assertStillActive(nodeId: string, serial: string | undefined) {
    const [row] = await app.db
      .select({
        status: schema.node.status,
        certSerial: schema.node.certSerial,
        previousCertSerial: schema.node.previousCertSerial,
      })
      .from(schema.node)
      .where(eq(schema.node.id, nodeId));
    if (!row) throw new ConnectError("unknown node", Code.Unauthenticated);
    if (row.status !== "active") throw new ConnectError("node is disabled", Code.PermissionDenied);
    if (!acceptedCertificate(row, serial)) {
      throw new ConnectError("certificate has been superseded", Code.Unauthenticated);
    }
  }

  const statsHandler = async (
    req: Pick<ReportStatsRequest, "stats" | "batchSequence"> & {
      completeUntil?: ReportStatsV2Request["completeUntil"];
      l4Stats?: ReportStatsV2Request["l4Stats"];
    },
    ctx: HandlerContext,
  ) => {
    const node = await requireNode(ctx);
    const l4Stats = req.l4Stats ?? [];
    if (req.batchSequence === 0n && req.stats.length === 0 && l4Stats.length === 0) {
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
                loggedRules: Object.fromEntries(
                  s.loggedRules.map((v) => [v.value, Number(v.count)]),
                ),
                authFailures: Number(s.authFailures),
                imageBytesSaved: Number(s.imageBytesSaved),
                markdownResponses: Number(s.markdownResponses),
                statusCodes: Object.fromEntries(
                  Object.entries(s.statusCodes).map(([code, n]) => [code, Number(n)]),
                ),
                dimensions: {
                  countries: s.countries.map((c) => ({
                    country: c.country,
                    requests: Number(c.requests),
                    bytesSent: Number(c.bytesSent),
                  })),
                  asns: s.asns.map((a) => ({
                    asn: a.asn,
                    name: a.name,
                    requests: Number(a.requests),
                  })),
                  referers: Object.fromEntries(s.referers.map((v) => [v.value, Number(v.count)])),
                  browsers: counts(s.browsers),
                  oses: counts(s.operatingSystems),
                  devices: counts(s.devices),
                  httpVersions: counts(s.httpVersions),
                  tlsVersions: counts(s.tlsVersions),
                  blockReasons: counts(s.blockReasons),
                  challengesIssued: Number(s.challengesIssued),
                  challengesPassed: Number(s.challengesPassed),
                  challengeOutcomes: counts(s.challengeOutcomes),
                  origins: s.origins.map((o) => ({
                    originId: o.originId,
                    requests: Number(o.requests),
                    connectFailures: Number(o.connectFailures),
                    timeouts: Number(o.timeouts),
                    tlsFailures: Number(o.tlsFailures),
                    invalidResponses: Number(o.invalidResponses),
                    serverErrors: Number(o.serverErrors),
                    headerTimeBuckets: o.headerTimeBuckets.map(Number),
                    headerTimeMsSum: Number(o.headerTimeMsSum),
                  })),
                  crawlers: s.crawlers.map((c) => ({
                    crawler: c.crawler,
                    verification: c.verification,
                    requests: Number(c.requests),
                    status2xx: Number(c.status2xx),
                    status3xx: Number(c.status3xx),
                    status4xx: Number(c.status4xx),
                    status5xx: Number(c.status5xx),
                    blocked: Number(c.blocked),
                    bytes: Number(c.bytes),
                    charged: Number(c.charged),
                    chargedMicros: Number(c.chargedMicros),
                    robots: Number(c.robots),
                    allowed: Number(c.allowed),
                  })),
                  crawlerPaths: s.crawlerPaths.map((p) => ({
                    crawler: p.crawler,
                    path: p.path,
                    requests: Number(p.requests),
                  })),
                },
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
      l4Stats.slice(0, MAX_STATS_PER_REPORT).flatMap((s) =>
        s.minute && s.appId
          ? [
              {
                minute: timestampDate(s.minute),
                appId: s.appId,
                connections: Number(s.connections),
                refused: Number(s.refused),
                peakConcurrent: Number(s.peakConcurrent),
                bytesReceived: Number(s.bytesReceived),
                bytesSent: Number(s.bytesSent),
              },
            ]
          : [],
      ),
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
      const keySha256 = await signCsr(() => app.nodeCa.csrKeySha256(req.csrPem));
      const refused = () =>
        new ConnectError(
          "invalid, expired or already used enrollment token",
          Code.PermissionDenied,
        );
      const result = await app.db.transaction(async (tx) => {
        const info = req.info;
        // The key of an enrolled node (a retry after a lost answer): that node, never a second one.
        const [known] = await tx
          .select()
          .from(schema.node)
          .where(eq(schema.node.keySha256, keySha256))
          .for("update");
        if (known) {
          const token = await findEnrollmentToken(tx, req.token);
          const sameToken = token?.usedByNodeId === known.id;
          const freshToken =
            !!token &&
            token.usedAt === null &&
            token.expiresAt > new Date() &&
            token.clusterId === known.clusterId &&
            (token.nodeGroupId === null || token.nodeGroupId === known.nodeGroupId);
          if (!token || !(sameToken || freshToken)) throw refused();
          const issued = await signCsr(() => app.nodeCa.signNodeCsr(req.csrPem, known.id));
          await tx
            .update(schema.node)
            .set({ ...certificateColumns(issued), previousCertSerial: known.certSerial, keySha256 })
            .where(eq(schema.node.id, known.id));
          if (freshToken) {
            await tx
              .update(schema.enrollmentToken)
              .set({ usedAt: new Date(), usedByNodeId: known.id })
              .where(eq(schema.enrollmentToken.id, token.id));
          }
          await recordAudit(
            tx,
            { type: "node", id: known.id, name: known.name, ip: peer.remoteAddress ?? "" },
            {
              action: "node.enroll",
              targetType: "node",
              targetId: known.id,
              targetName: known.name,
              metadata: {
                clusterId: known.clusterId,
                tokenId: token.id,
                hostname: info?.hostname ?? "",
                certSerial: issued.serialNumber,
                sameKey: true,
              },
            },
          );
          return { nodeRow: known, issued, sameKey: true };
        }
        const token = await claimEnrollmentToken(tx, req.token);
        if (!token) throw refused();
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
            ...nodeInfoColumns(info),
            remoteAddress: normalizeRemoteAddress(peer.remoteAddress),
          })
          .returning();
        if (!nodeRow) throw new Error("node insert failed");
        const issued = await signCsr(() => app.nodeCa.signNodeCsr(req.csrPem, nodeRow.id));
        await tx
          .update(schema.node)
          .set({ ...certificateColumns(issued), keySha256, enrolledAt: new Date() })
          .where(eq(schema.node.id, nodeRow.id));
        // NodeInfo.machine_id: the same machine as other nodes (a hint only, ADR-0067).
        const sameMachine = nodeRow.machineId
          ? await tx
              .select({ id: schema.node.id })
              .from(schema.node)
              .where(
                and(eq(schema.node.machineId, nodeRow.machineId), ne(schema.node.id, nodeRow.id)),
              )
          : [];
        await replaceReportedAddresses(tx, nodeRow.id, info?.ipAddresses ?? []);
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
              ...(sameMachine.length > 0 ? { sameMachineAs: sameMachine.map((n) => n.id) } : {}),
            },
          },
        );
        if (sameMachine.length > 0)
          log.warn("node enrolled on the machine of other nodes", {
            nodeId: nodeRow.id,
            sameMachineAs: sameMachine.map((n) => n.id),
          });
        return { nodeRow, issued, sameKey: false };
      });
      log.info(result.sameKey ? "node enrolled again with its key" : "node enrolled", {
        nodeId: result.nodeRow.id,
        name: result.nodeRow.name,
      });
      return {
        nodeId: result.nodeRow.id,
        clusterId: result.nodeRow.clusterId,
        nodeName: result.nodeRow.name,
        ...issuedCertificateResponse(app, result.issued),
      };
    },

    async renewCertificate(req, ctx) {
      // Identity only: a disabled node keeps a valid certificate, so it can come back once enabled.
      const node = await requireNode(ctx, { disabled: true });
      const peerSerial = ctx.values.get(peerKey).serialNumber;
      const issued = await signCsr(() => app.nodeCa.signNodeCsr(req.csrPem, node.id));
      await app.db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            certSerial: schema.node.certSerial,
            previousCertSerial: schema.node.previousCertSerial,
          })
          .from(schema.node)
          .where(eq(schema.node.id, node.id))
          .for("update");
        const kept = keptSerial(row, peerSerial);
        await tx
          .update(schema.node)
          .set({
            ...certificateColumns(issued),
            previousCertSerial: kept,
            keySha256: issued.keySha256,
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
            metadata: { certSerial: issued.serialNumber, previousCertSerial: kept },
          },
        );
      });
      return issuedCertificateResponse(app, issued);
    },

    async *watchConfig(_req, ctx) {
      const node = await requireNode(ctx);
      const serial = ctx.values.get(peerKey).serialNumber;
      const own = new AbortController();
      const streams = watching.get(node.id) ?? [];
      streams.push(own);
      while (streams.length > MAX_WATCH_STREAMS) streams.shift()?.abort();
      watching.set(node.id, streams);
      try {
        yield* watchStream({
          node,
          bans: nodeSupportsFeature(node.supportedFeatures, BANS_FEATURE),
          // A node follows its own target: the candidate in a canary group, else the stable revision.
          source: {
            target: () => currentTarget(node.id),
            hasTasks: () => hasDeliverableTasks(app.db, node.id),
            assertActive: () => assertStillActive(node.id, serial),
            banSequence: () => currentBanSequence(app.db),
          },
          events: app.events,
          log,
          signal: AbortSignal.any([ctx.signal, own.signal]),
          closing,
          keepaliveMs: KEEPALIVE_MS,
        });
      } finally {
        const left = (watching.get(node.id) ?? []).filter((c) => c !== own);
        if (left.length > 0) watching.set(node.id, left);
        else watching.delete(node.id);
      }
    },

    async getConfig(req, ctx) {
      const node = await requireNode(ctx);
      const own = await nodeTarget(app.db, node, "head");
      // A node never gets a revision newer than its target (a canary candidate
      // stays with the canary nodes).
      if (req.revision !== 0n && own && req.revision > BigInt(own.revision))
        throw new ConnectError("revision is not published to this node", Code.FailedPrecondition);
      // The configuration itself is read for the revision shipped only.
      const wanted = req.revision === 0n ? own?.revision : Number(req.revision);
      const target =
        wanted === undefined ? undefined : await getRevision(app.db, node.clusterId, wanted);
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
      const issued = await latestRevision(app.db, node.clusterId, "head");
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
            remoteAddress: normalizeRemoteAddress(peer.remoteAddress) ?? node.remoteAddress,
            // Nodes without metrics-v1 send none (nor do others before their second sample).
            metrics: req.metrics ? toNodeMetrics(req.metrics, now) : null,
            // cache-zone-v1: the last measurement; heartbeats before the first keep the stored one.
            ...(req.cacheUsage.length ? { cacheUsage: toNodeCacheUsage(req.cacheUsage, now) } : {}),
            // Nodes without bans-v1 send no BanStatus.
            banStatus: req.bans ? toNodeBanStatus(req.bans, now) : null,
            // Sites above the normal CC level; nodes without challenge-v1 send none.
            securityState: toNodeSecurityState(req.security),
            // The address the node uses (channel-follow-v1) and what this connection showed.
            channel: channelData(req.channel, peer, now),
            // Nodes since v1.5.0, from the previous response's console_time.
            ...(req.clockOffsetMillis !== undefined
              ? { clockOffsetMs: clockOffset(req.clockOffsetMillis), clockMeasuredAt: now }
              : {}),
            ...(info ? { ...nodeInfoColumns(info), hostname: info.hostname || node.hostname } : {}),
            // Nodes since v1.6.2, for the previous response's locate_address.
            ...(req.location ? { location: toNodeLocation(req.location, now) } : {}),
          })
          .where(eq(schema.node.id, node.id));
        // Certificates of the applied revision the node could not load
        // (certificate-isolation-v1; older nodes fail the revision instead).
        const certificateFailures = toCertificateFailures(req.certificateFailures);
        const [previous] = await tx
          .select({ certificateFailures: schema.nodeConfigStatus.certificateFailures })
          .from(schema.nodeConfigStatus)
          .where(eq(schema.nodeConfigStatus.nodeId, node.id));
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
          certificateFailures,
        };
        await tx
          .insert(schema.nodeConfigStatus)
          .values(values)
          .onConflictDoUpdate({ target: schema.nodeConfigStatus.nodeId, set: values });
        await syncCertificateFailureAlerts(
          tx,
          changedCertificates(previous?.certificateFailures ?? [], certificateFailures),
        );
        await recordUpgradeHealth(
          tx,
          { ...node, agentVersion: info?.agentVersion ?? node.agentVersion },
          values,
          now,
        );
        // Every heartbeat carries the host's current addresses.
        await replaceReportedAddresses(tx, node.id, info?.ipAddresses ?? []);
        await replaceOriginHealth(
          tx,
          node,
          req.originHealth.slice(0, 2000).map((h) => ({
            siteId: h.siteId,
            originId: h.originId,
            // Nodes before v0.12.0 report the passive check only, without a source.
            source:
              h.source === OriginHealthSource.ACTIVE ? ("active" as const) : ("passive" as const),
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
      const locateAddress = locateAddressOf(
        (await nodeIpRows(app.db, [node.id])).get(node.id) ?? [],
        normalizeRemoteAddress(peer.remoteAddress) ?? node.remoteAddress,
      );
      await evaluateAfterHeartbeat(app, node);
      const tasksPending =
        (await hasDeliverableTasks(app.db, node.id)) ||
        (await hasUpgradeTasks(app.db, node.id)) ||
        (await hasDebugLogTasks(app.db, node.id)) ||
        (await hasDecommissionTask(app.db, node.id));
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
        reportIntervalSeconds: heartbeatSeconds(),
        tasksPending,
        // The node probes only while its node group has a region to probe from.
        probe: node.probeEnabled && !!(await nodeProbeRegion(app.db, node)),
        // Nodes with channel-follow-v1 check this address and move to it.
        channel: await channelAddressFor(app, info?.supportedFeatures ?? node.supportedFeatures),
        consoleTime: timestampFromDate(new Date()),
        // The node answers with where this is in its next heartbeat (location).
        locateAddress,
      };
    },

    async checkChannel(_req, ctx) {
      // Disabled nodes too: set-server must find out whether an address reaches the console.
      const node = await requireNode(ctx, { disabled: true });
      return {
        nodeId: node.id,
        channel: await channelAddressFor(app, [CHANNEL_FOLLOW_FEATURE]),
        consoleTime: timestampFromDate(new Date()),
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

    async uploadDebugLogs(req, ctx) {
      const node = await requireNode(ctx);
      const stored = await uploadDebugLogs(app, node, req);
      log.info("debug logs uploaded", { nodeId: node.id, pullId: req.taskId, entries: stored });
      return {};
    },

    async reportNodeLogs(req, ctx) {
      const node = await requireNode(ctx);
      if (req.batchSequence === 0n && !req.entries.length)
        return { accepted: 0, batchSequence: await nodeLogCursor(app.db, node.id) };
      return {
        accepted: await ingestNodeLogs(app, node, req),
        batchSequence: req.batchSequence,
      };
    },

    async getCertificates(req, ctx) {
      const node = await requireNode(ctx);
      const ids = [...new Set(req.ids)].filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 100);
      // Site certificates and the origin client certificates nodes present to origins.
      return {
        certificates: [
          ...(await nodeCertificates(app, node.clusterId, ids)),
          ...(await nodeOriginClientCertificates(app, node.clusterId, ids)),
        ],
      };
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
      // PURGE keys of the cluster's sites travel the same way (no access key id).
      const keys = await app.db
        .select({ secret: schema.siteSecret })
        .from(schema.siteSecret)
        .innerJoin(schema.site, eq(schema.site.id, schema.siteSecret.siteId))
        .where(
          and(
            inArray(schema.siteSecret.id, ids),
            eq(schema.siteSecret.kind, PURGE_KEY),
            eq(schema.site.clusterId, node.clusterId),
          ),
        );
      for (const { secret } of keys) {
        try {
          const value = app.masterKey.open(
            JSON.parse(secret.secretEnvelope),
            siteSecretBinding(secret.id),
          );
          credentials.push({
            id: secret.id,
            version: BigInt(secret.version),
            accessKeyId: "",
            secretAccessKey: value.toString("utf8"),
          });
        } catch (error) {
          log.error("cannot open site secret", { secretId: secret.id, error });
        }
      }
      // Secrets of access authentication rules (Basic users and hashes, URL keys) as JSON.
      const authRules = await app.db
        .select({ rule: schema.siteAuthRule })
        .from(schema.siteAuthRule)
        .innerJoin(schema.site, eq(schema.site.id, schema.siteAuthRule.siteId))
        .where(
          and(
            inArray(schema.siteAuthRule.id, ids),
            isNotNull(schema.siteAuthRule.secretEnvelope),
            eq(schema.site.clusterId, node.clusterId),
          ),
        );
      for (const { rule } of authRules) {
        try {
          const value = app.masterKey.open(
            JSON.parse(rule.secretEnvelope as string),
            accessAuthSecretBinding(rule.id),
          );
          credentials.push({
            id: rule.id,
            version: BigInt(rule.secretVersion),
            accessKeyId: "",
            secretAccessKey: value.toString("utf8"),
          });
        } catch (error) {
          log.error("cannot open access authentication secret", { ruleId: rule.id, error });
        }
      }
      // Secrets of interactive challenge providers the cluster's sites use (challenge-v3), as JSON.
      credentials.push(
        ...(await nodeProviderSecrets(app.db, app.masterKey, node.clusterId, ids, (message, data) =>
          log.error(message, data),
        )),
      );
      log.info("origin credentials delivered", {
        nodeId: node.id,
        credentials: credentials.map((c) => c.id),
      });
      return { credentials };
    },

    async submitPurge(req, ctx) {
      const node = await requireNode(ctx);
      if (!/^[0-9a-f-]{36}$/i.test(req.siteId) || req.url.length > 2048)
        throw new ConnectError("invalid PURGE request", Code.InvalidArgument);
      const [site] = await app.db
        .select({
          id: schema.site.id,
          clusterId: schema.site.clusterId,
          enabled: schema.site.enabled,
          purgeMethod: schema.site.purgeMethod,
        })
        .from(schema.site)
        .where(eq(schema.site.id, req.siteId));
      if (!site || site.clusterId !== node.clusterId || !site.enabled || !site.purgeMethod)
        throw new ConnectError(
          "the site has no PURGE method on this cluster",
          Code.PermissionDenied,
        );
      // A lock-free check first: a site over its quota is refused without
      // queueing on the site's lock (createCacheTask counts again under it).
      const retryAfter = await purgeMethodRetryAfter(app.db, site.id);
      if (retryAfter > 0)
        throw new ConnectError(`retry after ${retryAfter}`, Code.ResourceExhausted);
      try {
        const task = await createCacheTask(
          app.db,
          { type: "url", urls: [req.url], siteIds: [] },
          {
            actor: { type: "node", id: node.id, name: node.name },
            source: "purge_method",
            siteId: site.id,
          },
        );
        log.info("PURGE task created", { nodeId: node.id, siteId: site.id, taskId: task.id });
        return { taskId: task.id };
      } catch (error) {
        if (error instanceof PurgeMethodLimited)
          throw new ConnectError(`retry after ${error.retryAfter}`, Code.ResourceExhausted);
        const code = (error as { code?: string }).code;
        if (code === "CACHE_TASK_URL_INVALID" || code === "CACHE_TASK_HOST_UNKNOWN")
          throw new ConnectError("the site does not serve this URL", Code.InvalidArgument);
        if (code === "SITE_DISABLED")
          throw new ConnectError("the site is disabled", Code.PermissionDenied);
        throw error;
      }
    },

    async pullTasks(req, ctx) {
      const node = await requireNode(ctx);
      const max = Math.min(req.maxTasks || MAX_TASKS_PER_PULL, MAX_TASKS_PER_PULL);
      // The node's purge lane (proto v0.17.0) takes purges only.
      const purgeOnly = req.purgeOnly;
      const upgrade = purgeOnly ? null : await pullUpgrade(app, node);
      const debugLogs = purgeOnly ? null : await pullDebugLogTask(app, node);
      const decommission = purgeOnly ? null : await pullDecommissionTask(app.db, node);
      const limit = max - (upgrade ? 1 : 0) - (debugLogs ? 1 : 0) - (decommission ? 1 : 0);
      const tasks = limit > 0 ? await pullCacheTasks(app.db, node, limit, { purgeOnly }) : [];
      // Only prefetches depend on the cache key's device type.
      const deviceType = await deviceTypeSites(
        app.db,
        tasks.flatMap((task) =>
          task.type === "prefetch" || task.type === "sitemap"
            ? task.items.map((item) => item.siteId)
            : [],
        ),
      );
      return {
        tasks: [
          ...tasks.map((task) => toNodeTask(task, deviceType)),
          ...(upgrade ? [upgrade] : []),
          ...(debugLogs ? [debugLogs] : []),
          ...(decommission ? [decommission] : []),
        ],
      };
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
      if (await reportDebugLogResult(app, node.id, req)) return {};
      if (await reportDecommissionResult(app, node, req)) return {};
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
      const page = await banChanges(
        app.db,
        node,
        req.afterSequence,
        req.limit,
        new Date(),
        req.greylist,
      );
      const toBan = (ban: (typeof page.bans)[number]) =>
        create(BanSchema, {
          id: ban.id,
          cidr: ban.cidr,
          scope: ban.scope === "platform" ? BanScope.PLATFORM : BanScope.SITE,
          siteId: ban.siteId ?? "",
          expiresAt: timestampFromDate(ban.expiresAt),
          // Rules' bans are automatic for the nodes (waf-v2).
          source: ban.source === "manual" ? BanSource.MANUAL : BanSource.AUTO,
          reason: ban.reason,
          createdAt: timestampFromDate(ban.createdAt),
          // Greylist entries (only for nodes that asked for them).
          ...(ban.action === "challenge"
            ? { action: BanAction.CHALLENGE, challenge: ban.challenge ?? "js" }
            : ban.action === "rate_limit"
              ? {
                  action: BanAction.RATE_LIMIT,
                  rateLimitRequests: ban.rateLimitRequests ?? 0,
                  rateLimitWindowSeconds: ban.rateLimitWindowSeconds ?? 0,
                }
              : {}),
        });
      return {
        reset: page.reset,
        bans: page.bans.map(toBan),
        removedIds: page.removedIds,
        sequence: page.sequence,
        more: page.more,
        liftedOwnBans: page.liftedOwn.map(toBan),
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
          scope: ban.scope === BanScope.PLATFORM ? ("platform" as const) : ("site" as const),
          siteId: ban.siteId,
          cidr: ban.cidr,
          createdAt: ban.createdAt ? timestampDate(ban.createdAt) : null,
          expiresAt: ban.expiresAt ? timestampDate(ban.expiresAt) : null,
          reason: ban.reason,
          metric: ban.metric,
          observed: ban.observed,
          threshold: ban.threshold,
          windowSeconds: ban.windowSeconds,
          ruleId: ban.ruleId,
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

    async getSessionTicketKeys(req, ctx) {
      const node = await requireNode(ctx);
      // Only keys of the node's own cluster; unknown ids are left out.
      const keys = await sessionTicketKeySecrets(app, node.clusterId, req.ids);
      log.info("session ticket keys delivered", { nodeId: node.id, keys: keys.map((k) => k.id) });
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
      // A site's level going up may start its automatic mitigation: evaluate now, not at the
      // next minute. After the answer: the node does not wait for a publish.
      if (accepted > 0)
        void nudgeAutoMitigation(app, [
          ...new Set(
            req.events
              .filter((e) => e.kind === SecurityEventKind.SITE_LEVEL && e.level !== "normal")
              .map((e) => e.siteId.toLowerCase()),
          ),
        ]);
      return { accepted };
    },
  };
}
