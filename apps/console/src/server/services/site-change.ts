import type { AuditAction, Revision, RevisionReasonCode } from "@edgeweir/contract";
import { type Actor, recordAudit } from "./audit";
import { publishRevision, type Tx, toRevisionDto } from "./revisions";

/**
 * Publishes the site's cluster after a change to the site and audits the
 * change with the new revision number. With `strict`, the site's stored rules
 * must compile (RULE_INVALID); otherwise a rule the current validator refuses
 * keeps its last compiled form (PublishOptions.site).
 */
export async function publishSiteChange(
  tx: Tx,
  actor: Actor,
  site: { id: string; name: string; clusterId: string },
  change: {
    reason: RevisionReasonCode;
    /** The reason's parameters; `{ site: <name> }` by default. */
    params?: Record<string, string>;
    action: AuditAction;
    metadata?: Record<string, unknown>;
    strict?: boolean;
  },
): Promise<Revision> {
  const { row } = await publishRevision(tx, {
    clusterId: site.clusterId,
    reason: { code: change.reason, params: change.params ?? { site: site.name } },
    actor,
    ...(change.strict ? { site: site.id } : {}),
  });
  await recordAudit(tx, actor, {
    action: change.action,
    targetType: "site",
    targetId: site.id,
    targetName: site.name,
    metadata: { ...change.metadata, revision: row.revision },
  });
  return toRevisionDto(row);
}
