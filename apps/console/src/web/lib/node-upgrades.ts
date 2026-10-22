import type { Node } from "@edgeweir/contract";
// Relative on purpose: the module is unit-tested outside Vite's "@" alias.
import { m } from "../paraglide/messages.js";

/** Architectures node releases are built for. */
const RELEASE_ARCHES = ["amd64", "arm64"];

/**
 * Why an active node stops an upgrade from starting, as the console checks
 * it (every active node of the cluster must be ready); null when ready. A
 * node marked "Upgrade required" behind its target still runs the revision
 * it applied before: the upgrade is what lets it apply the target.
 */
export function upgradeBlocker(node: Node, busy: ReadonlySet<string>): string | null {
  if (busy.has(node.id)) return m.upgrade_reason_busy();
  if (!node.online) return m.nodes_offline();
  if (node.os !== "linux") return m.upgrade_reason_os();
  if (!RELEASE_ARCHES.includes(node.arch)) return m.upgrade_reason_arch();
  if (!node.supportedFeatures.includes("self-upgrade-v1")) return m.upgrade_reason_feature();
  if (!node.dataPlaneHealthy) return m.nodes_unhealthy();
  if (node.applyState !== "applied") return m.upgrade_reason_not_applied();
  if (
    node.targetRevision !== null &&
    node.appliedRevision !== node.targetRevision &&
    !(
      node.upgradeRequired &&
      node.appliedRevision > 0 &&
      node.appliedRevision < node.targetRevision
    )
  )
    return m.nodes_behind();
  return null;
}
