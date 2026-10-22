import { schema } from "@edgeweir/db";
import type { CertificateFailure } from "@edgeweir/proto";
import { eq, inArray, sql } from "drizzle-orm";
import { lockCertificateFailures } from "../lib/locks";
import { raisePlatformAlert, resolvePlatformAlert } from "./platform-alerts";
import type { Executor } from "./revisions";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;
const REASONS = new Set(["invalid_material", "fingerprint_mismatch", "unavailable"]);

/** Failed certificates a node's status keeps at most. */
const MAX_CERTIFICATE_FAILURES = 100;

/**
 * ReportStatusRequest.certificate_failures as stored (certificate-isolation-v1):
 * certificate ids only, once each, sorted, at most MAX_CERTIFICATE_FAILURES;
 * an unknown reason counts as invalid_material, messages at most 256
 * characters.
 */
export function toCertificateFailures(
  failures: readonly CertificateFailure[],
): schema.NodeCertificateFailure[] {
  const out = new Map<string, schema.NodeCertificateFailure>();
  for (const f of failures) {
    const id = f.certificateId.toLowerCase();
    if (!UUID.test(id) || out.has(id)) continue;
    out.set(id, {
      certificateId: id,
      fingerprint: FINGERPRINT.test(f.sha256Fingerprint) ? f.sha256Fingerprint : "",
      reason: REASONS.has(f.reason)
        ? (f.reason as schema.NodeCertificateFailure["reason"])
        : "invalid_material",
      message: f.message.replace(/\p{Cc}/gu, " ").slice(0, 256),
      servingFingerprint: FINGERPRINT.test(f.servingFingerprint) ? f.servingFingerprint : "",
    });
    if (out.size === MAX_CERTIFICATE_FAILURES) break;
  }
  return [...out.values()].sort((a, b) => (a.certificateId < b.certificateId ? -1 : 1));
}

/** The ids whose failure differs between two stored lists (added, removed or changed). */
export function changedCertificates(
  before: readonly schema.NodeCertificateFailure[],
  after: readonly schema.NodeCertificateFailure[],
): string[] {
  const key = (f: schema.NodeCertificateFailure) => JSON.stringify(f);
  const was = new Map(before.map((f) => [f.certificateId, key(f)]));
  const now = new Map(after.map((f) => [f.certificateId, key(f)]));
  return [...new Set([...was.keys(), ...now.keys()])].filter((id) => was.get(id) !== now.get(id));
}

/**
 * Fires certificate_unloadable for each of `ids` some node reports and
 * resolves it for those none reports any more (in the transaction that
 * changed a node's status, after the change). A transaction lock per
 * certificate serializes concurrent heartbeats: the later one sees the
 * earlier one's status, so the last report decides.
 */
export async function syncCertificateFailureAlerts(tx: Executor, ids: readonly string[]) {
  if (!ids.length) return;
  for (const id of [...new Set(ids)].sort()) await lockCertificateFailures(tx, id);
  const certificates = await tx
    .select({ id: schema.certificate.id, name: schema.certificate.name })
    .from(schema.certificate)
    .where(inArray(schema.certificate.id, [...ids]));
  for (const id of ids) {
    const [failing] = await tx
      .select({ nodeId: schema.nodeConfigStatus.nodeId })
      .from(schema.nodeConfigStatus)
      .where(
        sql`${schema.nodeConfigStatus.certificateFailures} @> ${JSON.stringify([{ certificateId: id }])}::jsonb`,
      )
      .limit(1);
    const name = certificates.find((c) => c.id === id)?.name ?? "";
    if (failing && name) await raisePlatformAlert(tx, "certificate_unloadable", id, name);
    else await resolvePlatformAlert(tx, "certificate_unloadable", id, name);
  }
}

/**
 * The failures nodes report, by certificate id: each node's name and
 * whether it serves earlier material.
 */
export async function certificateNodeFailures(db: Executor) {
  const rows = await db
    .select({
      nodeId: schema.node.id,
      nodeName: schema.node.name,
      failures: schema.nodeConfigStatus.certificateFailures,
    })
    .from(schema.nodeConfigStatus)
    .innerJoin(schema.node, eq(schema.node.id, schema.nodeConfigStatus.nodeId))
    .where(sql`jsonb_array_length(${schema.nodeConfigStatus.certificateFailures}) > 0`);
  const out = new Map<
    string,
    { nodeId: string; nodeName: string; reason: string; servingEarlier: boolean }[]
  >();
  for (const row of rows)
    for (const f of row.failures) {
      const list = out.get(f.certificateId) ?? [];
      list.push({
        nodeId: row.nodeId,
        nodeName: row.nodeName,
        reason: f.reason,
        servingEarlier: f.servingFingerprint !== "",
      });
      out.set(f.certificateId, list);
    }
  for (const list of out.values()) list.sort((a, b) => a.nodeName.localeCompare(b.nodeName));
  return out;
}
