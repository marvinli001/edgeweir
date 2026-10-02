import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, type HandlerContext, type ServiceImpl } from "@connectrpc/connect";
import { schema } from "@edgeweir/db";
import {
  GetProbeTargetsResponseSchema,
  ProbeMethod,
  type ProbeService,
  ProbeTargetSchema,
} from "@edgeweir/proto";
import { and, eq } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { NODE_CERT_LIFETIME_DAYS, NODE_ORGANIZATION, PROBE_ORGANIZATION } from "../pki/ca";
import { recordAudit } from "../services/audit";
import { acceptedCertificate, isSerialRevoked } from "../services/nodes";
import {
  claimProbeToken,
  getProbeSettings,
  MAX_PROBE_RESULTS,
  type Prober,
  probeTargets,
  recordProbeResults,
} from "../services/probes";
import { evaluateAfterProbeReport } from "../services/scheduling";
import { certificateColumns, issuedCertificateResponse, keptSerial, signCsr } from "./identity";
import { clientCertificateError, nodeProbeRegion, peerKey } from "./service";

/** Ask probes to renew once less than a third of the lifetime remains (as nodes). */
const RENEW_BEFORE_MS = (NODE_CERT_LIFETIME_DAYS * 24 * 3600 * 1000) / 3;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const methods = {
  tcp: ProbeMethod.TCP,
  http: ProbeMethod.HTTP,
  https: ProbeMethod.HTTPS,
} as const;
const text = (value: string | undefined, max: number) =>
  (value ?? "").replace(/[\p{Cc}]/gu, "").slice(0, max);

export interface ProbeServiceOptions {
  /** Runs after a report was stored (default: evaluate the clusters' scheduling now). */
  afterReport?: (clusterIds: readonly string[]) => Promise<void>;
}

/**
 * ProbeService on the node channel. EnrollProbe takes a one-time probe
 * token (no client certificate, like Enroll); every other call needs mutual
 * TLS with a probe certificate (O=Edgeweir Probe) of an enabled probe, or
 * the certificate of an active node the operator lets probe and whose node
 * group has a region. Node certificates never enroll or renew here.
 */
export function createProbeService(
  app: AppContext,
  options: ProbeServiceOptions = {},
): ServiceImpl<typeof ProbeService> {
  const log = app.log.child({ component: "probe-channel" });
  const afterReport =
    options.afterReport ?? ((clusterIds) => evaluateAfterProbeReport(app, clusterIds));

  /** The prober behind the client certificate; `disabled` lets a disabled probe renew. */
  async function requireProber(
    ctx: HandlerContext,
    { disabled = false } = {},
  ): Promise<Prober & { certNotAfter: Date | null }> {
    const peer = ctx.values.get(peerKey);
    if (!peer.authorized || !peer.commonName || !UUID_RE.test(peer.commonName))
      throw new ConnectError(clientCertificateError(peer), Code.Unauthenticated);
    if (await isSerialRevoked(app.db, peer.serialNumber))
      throw new ConnectError("certificate has been revoked", Code.Unauthenticated);
    if (peer.organization === PROBE_ORGANIZATION) {
      const [row] = await app.db
        .select()
        .from(schema.probe)
        .where(eq(schema.probe.id, peer.commonName));
      if (!row) throw new ConnectError("unknown probe", Code.Unauthenticated);
      if (!row.enabled && !disabled)
        throw new ConnectError("probe is disabled", Code.PermissionDenied);
      const certificate = acceptedCertificate(row, peer.serialNumber);
      if (!certificate)
        throw new ConnectError("certificate has been superseded", Code.Unauthenticated);
      if (certificate === "current" && row.previousCertSerial)
        // The probe uses its renewed certificate: the one it replaced is no longer accepted.
        await app.db
          .update(schema.probe)
          .set({ previousCertSerial: null })
          .where(
            and(eq(schema.probe.id, row.id), eq(schema.probe.certSerial, row.certSerial ?? "")),
          );
      return {
        kind: "probe",
        id: row.id,
        name: row.name,
        regionId: row.regionId,
        certNotAfter: row.certNotAfter,
      };
    }
    if (peer.organization === NODE_ORGANIZATION) {
      const [row] = await app.db
        .select()
        .from(schema.node)
        .where(eq(schema.node.id, peer.commonName));
      if (!row) throw new ConnectError("unknown node", Code.Unauthenticated);
      if (row.status !== "active")
        throw new ConnectError("node is disabled", Code.PermissionDenied);
      if (!acceptedCertificate(row, peer.serialNumber))
        throw new ConnectError("certificate has been superseded", Code.Unauthenticated);
      if (!row.probeEnabled)
        throw new ConnectError("this node does not probe", Code.PermissionDenied);
      const regionId = await nodeProbeRegion(app.db, row);
      if (!regionId)
        throw new ConnectError(
          "the node's group has no region to probe from",
          Code.PermissionDenied,
        );
      return { kind: "node", id: row.id, name: row.name, regionId, certNotAfter: null };
    }
    throw new ConnectError("not a probe or node certificate", Code.Unauthenticated);
  }

  return {
    async enrollProbe(req, ctx) {
      const peer = ctx.values.get(peerKey);
      if (!req.token || !req.csrPem)
        throw new ConnectError("token and csr_pem are required", Code.InvalidArgument);
      const result = await app.db.transaction(async (tx) => {
        const token = await claimProbeToken(tx, req.token);
        if (!token)
          throw new ConnectError(
            "invalid, expired or already used probe token",
            Code.PermissionDenied,
          );
        const info = req.info;
        const [row] = await tx
          .insert(schema.probe)
          .values({
            name: token.name,
            regionId: token.regionId,
            hostname: text(info?.hostname, 253),
            agentVersion: text(info?.agentVersion, 64),
            os: text(info?.os, 32),
            arch: text(info?.arch, 32),
          })
          .returning();
        if (!row) throw new Error("probe insert failed");
        const issued = await signCsr(() => app.nodeCa.signProbeCsr(req.csrPem, row.id));
        await tx
          .update(schema.probe)
          .set({ ...certificateColumns(issued), enrolledAt: new Date() })
          .where(eq(schema.probe.id, row.id));
        await tx
          .update(schema.probeToken)
          .set({ usedAt: new Date(), usedByProbeId: row.id })
          .where(eq(schema.probeToken.id, token.id));
        await recordAudit(
          tx,
          { type: "probe", id: row.id, name: row.name, ip: peer.remoteAddress ?? "" },
          {
            action: "probe.enroll",
            targetType: "probe",
            targetId: row.id,
            targetName: row.name,
            metadata: {
              regionId: row.regionId,
              tokenId: token.id,
              hostname: row.hostname,
              certSerial: issued.serialNumber,
            },
          },
        );
        return { row, issued };
      });
      log.info("probe enrolled", { probeId: result.row.id, name: result.row.name });
      return {
        probeId: result.row.id,
        probeName: result.row.name,
        regionId: result.row.regionId,
        ...issuedCertificateResponse(app, result.issued),
      };
    },

    async renewProbeCertificate(req, ctx) {
      // Identity only: a disabled probe keeps a valid certificate for when it is enabled again.
      const prober = await requireProber(ctx, { disabled: true });
      if (prober.kind !== "probe")
        throw new ConnectError(
          "nodes renew their certificate with NodeService.RenewCertificate",
          Code.FailedPrecondition,
        );
      const peerSerial = ctx.values.get(peerKey).serialNumber;
      const issued = await signCsr(() => app.nodeCa.signProbeCsr(req.csrPem, prober.id));
      await app.db.transaction(async (tx) => {
        const [row] = await tx
          .select({
            certSerial: schema.probe.certSerial,
            previousCertSerial: schema.probe.previousCertSerial,
          })
          .from(schema.probe)
          .where(eq(schema.probe.id, prober.id))
          .for("update");
        const kept = keptSerial(row, peerSerial);
        await tx
          .update(schema.probe)
          .set({ ...certificateColumns(issued), previousCertSerial: kept })
          .where(eq(schema.probe.id, prober.id));
        await recordAudit(
          tx,
          { type: "probe", id: prober.id, name: prober.name },
          {
            action: "probe.certificate_renew",
            targetType: "probe",
            targetId: prober.id,
            targetName: prober.name,
            metadata: { certSerial: issued.serialNumber, previousCertSerial: kept },
          },
        );
      });
      return issuedCertificateResponse(app, issued);
    },

    async getProbeTargets(req, ctx) {
      const prober = await requireProber(ctx);
      const now = new Date();
      if (prober.kind === "probe") {
        const info = req.info;
        await app.db
          .update(schema.probe)
          .set({
            lastSeenAt: now,
            ...(info
              ? {
                  hostname: text(info.hostname, 253),
                  agentVersion: text(info.agentVersion, 64),
                  os: text(info.os, 32),
                  arch: text(info.arch, 32),
                }
              : {}),
          })
          .where(eq(schema.probe.id, prober.id));
      }
      const settings = await getProbeSettings(app.db);
      const targets = await probeTargets(app.db, prober);
      return create(GetProbeTargetsResponseSchema, {
        targets: targets.map((t) =>
          create(ProbeTargetSchema, {
            nodeId: t.nodeId,
            address: t.address,
            port: t.port,
            method: methods[t.method],
            proxyProtocol: t.proxyProtocol,
          }),
        ),
        intervalSeconds: settings.intervalSeconds,
        timeoutMs: settings.timeoutMs,
        attempts: settings.attempts,
        renewCertificate:
          !!prober.certNotAfter && prober.certNotAfter.getTime() - now.getTime() < RENEW_BEFORE_MS,
      });
    },

    async reportProbeResults(req, ctx) {
      const prober = await requireProber(ctx);
      if (req.results.length > MAX_PROBE_RESULTS)
        throw new ConnectError(
          `at most ${MAX_PROBE_RESULTS} results per request`,
          Code.InvalidArgument,
        );
      const { accepted, clusterIds } = await recordProbeResults(
        app.db,
        prober,
        req.results.map((r) => ({
          nodeId: r.nodeId,
          address: r.address,
          port: r.port,
          sent: r.sent,
          lost: r.lost,
          rttMs: r.rttMs,
          error: r.error,
        })),
      );
      log.debug("probe results", {
        prober: `${prober.kind}:${prober.id}`,
        reported: req.results.length,
        accepted,
      });
      if (clusterIds.length) await afterReport(clusterIds);
      return { accepted };
    },
  };
}
