import type { OriginHealth, Site } from "@edgeweir/contract";
import {
  CloudServerIcon,
  GitForkIcon,
  ServerStack01Icon,
  UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import type {
  TopologyEdge,
  TopologyNode,
  TopologyTone,
} from "@/components/effects/origin-topology";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatPercent, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

const OriginTopology = React.lazy(() => import("@/components/effects/origin-topology"));

const icon = (i: typeof UserGroupIcon) => <HugeiconsIcon icon={i} strokeWidth={2} />;

const POLICY: Record<Site["originSettings"]["policy"], () => string> = {
  weighted_random: m.site_pool_policy_weighted_random,
  round_robin: m.site_pool_policy_round_robin,
  consistent_hash: m.site_pool_policy_consistent_hash,
};

function healthTone(health: OriginHealth | undefined): TopologyTone {
  if (!health || health.onlineNodes === 0) return "idle";
  if (health.downNodes === 0) return "good";
  return health.downNodes >= health.onlineNodes ? "bad" : "warn";
}

/**
 * Where a request goes: visitors reach the site's edge cluster, which picks an origin group
 * (the default one, others through origin rules) and an origin in it by weight; backups take
 * over when the others are down. Edges carry the weight shares; origins their health.
 */
function graphOf(site: Site, health: OriginHealth[]) {
  const byOrigin = new Map(health.map((h) => [h.originId, h]));
  const delivery = site.delivery;
  const nodes: TopologyNode[] = [
    { id: "visitors", title: m.topology_visitors(), icon: icon(UserGroupIcon) },
    {
      id: "edge",
      title: site.clusterName,
      detail: m.clusters_nodes_count({ online: delivery.currentNodes, total: delivery.totalNodes }),
      tone: delivery.state === "live" ? "good" : delivery.state === "disabled" ? "idle" : "warn",
      icon: icon(ServerStack01Icon),
    },
  ];
  const edges: TopologyEdge[] = [{ id: "in", source: "visitors", target: "edge", kind: "flow" }];
  const groups = [...new Set(site.origins.map((o) => o.group))].sort();
  const protocol = site.originSettings.protocol === "http2" ? " · HTTP/2" : "";
  for (const group of groups) {
    const pool = `pool:${group}`;
    nodes.push({
      id: pool,
      title: group || m.site_origin_group_default(),
      detail: `${POLICY[site.originSettings.policy]()}${protocol}`,
      icon: icon(GitForkIcon),
    });
    edges.push({ id: `to-${pool}`, source: "edge", target: pool, kind: "flow" });
    const members = site.origins.filter((o) => o.group === group);
    const active = members.filter((o) => !o.backup);
    const totalWeight = active.reduce((sum, o) => sum + o.weight, 0);
    const shares = site.originSettings.policy !== "consistent_hash" && active.length > 1;
    for (const origin of members) {
      const h = byOrigin.get(origin.id);
      const tone = healthTone(h);
      nodes.push({
        id: origin.id,
        title: origin.address,
        detail: `${origin.scheme}:${origin.port}`,
        mono: true,
        tag: origin.backup ? m.site_origin_backup() : undefined,
        tone,
        icon: icon(CloudServerIcon),
      });
      edges.push({
        id: `to-${origin.id}`,
        source: pool,
        target: origin.id,
        kind: origin.backup ? "standby" : tone === "warn" || tone === "bad" ? "degraded" : "flow",
        label: origin.backup
          ? m.topology_failover()
          : shares
            ? formatPercent((origin.weight / totalWeight) * 100)
            : undefined,
      });
    }
  }
  return { nodes, edges };
}

export function OriginTopologyCard({ site }: { site: Site }) {
  const health = useQuery({
    ...orpc.sites.originHealth.queryOptions({ input: { id: site.id } }),
    refetchInterval: 10_000,
    meta: { background: true },
  });
  const graph = React.useMemo(() => graphOf(site, health.data ?? []), [site, health.data]);
  return (
    <Card data-testid="origin-topology">
      <CardHeader>
        <CardTitle>{m.site_traffic_path()}</CardTitle>
      </CardHeader>
      <CardContent>
        <React.Suspense fallback={<div className="h-56" />}>
          <OriginTopology nodes={graph.nodes} edges={graph.edges} label={m.site_traffic_path()} />
        </React.Suspense>
      </CardContent>
    </Card>
  );
}
