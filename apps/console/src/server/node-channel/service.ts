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
import { applyNodeConfigDiff, decodeNodeConfig, diffNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import {
  ApplyState,
  GetConfigResponseSchema,
  type NodeService,
  WatchConfigResponseSchema,
  WatchEvent,
} from "@edgeweir/proto";
import { and, eq, sql } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { NODE_CERT_LIFETIME_DAYS } from "../pki/ca";
import { recordAudit } from "../services/audit";
import { claimEnrollmentToken } from "../services/enrollment";
import { getRevision, latestRevision } from "../services/revisions";

export const HEARTBEAT_SECONDS = 15;
export const KEEPALIVE_MS = 15_000;
/** Ask nodes to renew once less than a third of the lifetime remains. */
const RENEW_BEFORE_MS = (NODE_CERT_LIFETIME_DAYS * 24 * 3600 * 1000) / 3;

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

const normalizeSerial = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/^0+/, "").replace(/:/g, "");

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
        const [nodeRow] = await tx
          .insert(schema.node)
          .values({
            clusterId: token.clusterId,
            nodeGroupId: token.nodeGroupId,
            name: token.nodeName || info?.hostname || `node-${token.id.slice(0, 8)}`,
            hostname: info?.hostname ?? "",
            agentVersion: info?.agentVersion ?? "",
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
          { type: "node", id: nodeRow.id, ip: peer.remoteAddress ?? "" },
          {
            action: "node.enroll",
            targetType: "node",
            targetId: nodeRow.id,
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
      await app.db
        .update(schema.node)
        .set({
          certSerial: issued.serialNumber,
          certFingerprint: issued.fingerprintSha256,
          certNotAfter: issued.notAfter,
        })
        .where(eq(schema.node.id, node.id));
      await recordAudit(
        app.db,
        { type: "node", id: node.id },
        {
          action: "node.certificate_renew",
          targetType: "node",
          targetId: node.id,
          metadata: { certSerial: issued.serialNumber },
        },
      );
      return {
        certificatePem: issued.certificatePem,
        caCertificatePem: app.nodeCa.certificatePem,
        notAfter: timestampFromDate(issued.notAfter),
      };
    },

    async *watchConfig(_req, ctx) {
      const node = await requireNode(ctx);
      const queue: { revision: number; contentHash: string }[] = [];
      let wake: (() => void) | undefined;
      const push = (item: { revision: number; contentHash: string }) => {
        queue.push(item);
        wake?.();
      };
      const refresh = async () => {
        const latest = await latestRevision(app.db, node.clusterId);
        if (latest) push({ revision: latest.revision, contentHash: latest.contentHash });
      };
      const offConfig = app.events.on("config", (e) => {
        if (e.clusterId === node.clusterId) push(e);
      });
      const offReconnect = app.events.on("reconnected", () => void refresh());
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
          if (queue.length === 0) {
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
          } else if (!item) {
            yield create(WatchConfigResponseSchema, {
              event: WatchEvent.KEEPALIVE,
              latestRevision: BigInt(Math.max(lastSent, 0)),
            });
          }
        }
      } finally {
        offConfig();
        offReconnect();
        ctx.signal.removeEventListener("abort", onAbort);
        log.info("watch stream closed", { nodeId: node.id });
      }
    },

    async getConfig(req, ctx) {
      const node = await requireNode(ctx);
      const target =
        req.revision === 0n
          ? await latestRevision(app.db, node.clusterId)
          : await getRevision(app.db, node.clusterId, Number(req.revision));
      if (!target) throw new ConnectError("revision not found", Code.NotFound);
      const snapshot = decodeNodeConfig(target.ir);
      const generatedAt = timestampFromDate(new Date());
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
          });
        }
      }
      return create(GetConfigResponseSchema, {
        payload: { case: "snapshot", value: snapshot },
        generatedAt,
      });
    },

    async reportStatus(req, ctx) {
      const node = await requireNode(ctx);
      const peer = ctx.values.get(peerKey);
      const now = new Date();
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
            ...(info
              ? {
                  hostname: info.hostname || node.hostname,
                  agentVersion: info.agentVersion,
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
        const ips = [...new Set(info?.ipAddresses ?? [])].slice(0, 64);
        if (ips.length) {
          await tx
            .insert(schema.nodeIp)
            .values(ips.map((address) => ({ nodeId: node.id, address })))
            .onConflictDoNothing();
        }
      });
      const latest = await latestRevision(app.db, node.clusterId);
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
      };
    },

    async reportStats(req, ctx) {
      const node = await requireNode(ctx);
      let accepted = 0;
      for (const s of req.stats.slice(0, 5000)) {
        if (!s.minute || !s.siteId) continue;
        const [site] = await app.db
          .select({ id: schema.site.id })
          .from(schema.site)
          .where(and(eq(schema.site.id, s.siteId), eq(schema.site.clusterId, node.clusterId)));
        if (!site) continue;
        const minute = timestampDate(s.minute);
        minute.setUTCSeconds(0, 0);
        const codes: Record<string, number> = {};
        for (const [code, n] of Object.entries(s.statusCodes)) codes[code] = Number(n);
        await app.db
          .insert(schema.nodeMinuteStats)
          .values({
            minute,
            nodeId: node.id,
            siteId: s.siteId,
            requests: Number(s.requests),
            bytesSent: Number(s.bytesSent),
            bytesReceived: Number(s.bytesReceived),
            cacheHits: Number(s.cacheHits),
            cacheMisses: Number(s.cacheMisses),
            statusCodes: codes,
          })
          .onConflictDoUpdate({
            target: [
              schema.nodeMinuteStats.minute,
              schema.nodeMinuteStats.nodeId,
              schema.nodeMinuteStats.siteId,
            ],
            set: {
              requests: sql`${schema.nodeMinuteStats.requests} + excluded.requests`,
              bytesSent: sql`${schema.nodeMinuteStats.bytesSent} + excluded.bytes_sent`,
              bytesReceived: sql`${schema.nodeMinuteStats.bytesReceived} + excluded.bytes_received`,
              cacheHits: sql`${schema.nodeMinuteStats.cacheHits} + excluded.cache_hits`,
              cacheMisses: sql`${schema.nodeMinuteStats.cacheMisses} + excluded.cache_misses`,
              // Sum per-status counters key by key.
              statusCodes: sql`(select coalesce(jsonb_object_agg(k, coalesce((${schema.nodeMinuteStats.statusCodes} ->> k)::bigint, 0) + coalesce((excluded.status_codes ->> k)::bigint, 0)), '{}'::jsonb) from jsonb_object_keys(${schema.nodeMinuteStats.statusCodes} || excluded.status_codes) as k)`,
            },
          });
        accepted++;
      }
      return { accepted };
    },
  };
}
