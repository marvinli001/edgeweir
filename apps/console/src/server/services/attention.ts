import { ATTENTION_KINDS, type AttentionItem, type Node } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { asc } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { listBindings } from "./dns";
import { listNodes } from "./nodes";
import { loadRollout } from "./revisions";
import { listUpgrades } from "./upgrades";

/** A rolled-back canary or a failed upgrade stays on the list this long. */
export const ATTENTION_RECENT_MS = 24 * 3_600_000;

/**
 * Offline after connecting, failed to apply its configuration, data plane
 * down, or its certificate refused since it last got through.
 */
export function nodeUnhealthy(node: Node): boolean {
  if (node.status !== "active" || !node.lastSeenAt) return false;
  return (
    !node.online ||
    node.applyState === "failed" ||
    !!node.authError ||
    // Before its first configuration a node serves nothing yet.
    (node.appliedRevision > 0 && !node.dataPlaneHealthy)
  );
}

/**
 * Online and healthy, but not running its target revision: behind it, or
 * unable to run it until upgraded. A node without any configuration yet is
 * still starting, not lagging.
 */
export function nodeLagging(node: Node): boolean {
  if (node.status !== "active" || !node.online || nodeUnhealthy(node)) return false;
  if (node.upgradeRequired) return true;
  return (
    node.appliedRevision > 0 &&
    node.targetRevision !== null &&
    node.appliedRevision < node.targetRevision
  );
}

const item = (
  kind: AttentionItem["kind"],
  cluster: { id: string; name: string },
  fields: Partial<Pick<AttentionItem, "revision" | "at" | "count" | "version">> = {},
): AttentionItem => ({
  kind,
  clusterId: cluster.id,
  clusterName: cluster.name,
  revision: fields.revision ?? null,
  at: fields.at ?? null,
  count: fields.count ?? 0,
  version: fields.version ?? "",
});

/**
 * What needs the operator across the clusters, most pressing first: nodes
 * unhealthy, DNS publications failed or blocked, upgrades failed within a
 * day, canaries rolled back within a day, awaiting promotion or running,
 * nodes lagging or without an address DNS can use. Empty when all is well.
 */
export async function listAttention(app: AppContext, now = Date.now()): Promise<AttentionItem[]> {
  const db = app.db;
  const clusters = await db
    .select({ id: schema.cluster.id, name: schema.cluster.name })
    .from(schema.cluster)
    .orderBy(asc(schema.cluster.name));
  if (!clusters.length) return [];
  const items: AttentionItem[] = [];
  const recent = (at: Date | string | null | undefined) =>
    !!at && now - new Date(at).getTime() <= ATTENTION_RECENT_MS;

  const nodes = await listNodes(db);
  const bindings = await listBindings(app);
  const upgrades = await listUpgrades(app);
  for (const cluster of clusters) {
    const own = nodes.filter((n) => n.clusterId === cluster.id);
    const unhealthy = own.filter(nodeUnhealthy).length;
    if (unhealthy) items.push(item("nodes_unhealthy", cluster, { count: unhealthy }));
    const lagging = own.filter(nodeLagging).length;
    if (lagging) items.push(item("nodes_lagging", cluster, { count: lagging }));

    const binding = bindings.find((b) => b.clusterId === cluster.id);
    if (binding && binding.mode !== "off") {
      if (binding.blocked) items.push(item("dns_blocked", cluster));
      if (binding.revision?.status === "failed")
        items.push(item("dns_failed", cluster, { revision: binding.revision.revision }));
      // Only DNS answers with node addresses: elsewhere a missing one does not matter.
      const unaddressed = own.filter(
        (n) => n.status === "active" && n.online && n.dnsIssue === "no_public_address",
      ).length;
      if (unaddressed) items.push(item("nodes_no_address", cluster, { count: unaddressed }));
    }

    // The newest upgrade of the cluster (the list is newest first).
    const upgrade = upgrades.find((u) => u.clusterId === cluster.id);
    if (upgrade) {
      const failed = upgrade.deliveries.filter((d) => d.state === "failed");
      const finished = failed
        .map((d) => d.finishedAt)
        .filter((at): at is string => !!at)
        .sort()
        .at(-1);
      if ((upgrade.state === "failed" || failed.length) && recent(finished ?? upgrade.createdAt))
        items.push(item("upgrade_failed", cluster, { version: upgrade.version }));
    }

    const rollout = await loadRollout(db, cluster.id);
    if (rollout?.enabled) {
      if (rollout.state === "canary" && rollout.candidateRevision !== null)
        items.push(
          item("canary_running", cluster, {
            revision: rollout.candidateRevision,
            at: rollout.windowStartedAt
              ? new Date(
                  rollout.windowStartedAt.getTime() + rollout.windowSeconds * 1000,
                ).toISOString()
              : null,
          }),
        );
      else if (rollout.state === "awaiting_promotion" && rollout.candidateRevision !== null)
        items.push(
          item("canary_awaiting_promotion", cluster, { revision: rollout.candidateRevision }),
        );
      else if (rollout.state === "rolled_back" && recent(rollout.finishedAt))
        items.push(
          item("canary_rolled_back", cluster, {
            revision: rollout.lastCandidateRevision,
            at: rollout.finishedAt?.toISOString() ?? null,
          }),
        );
    }
  }
  const rank = (kind: AttentionItem["kind"]) => ATTENTION_KINDS.indexOf(kind);
  // Stable: clusters keep their name order within a kind.
  return items.sort((a, b) => rank(a.kind) - rank(b.kind));
}
