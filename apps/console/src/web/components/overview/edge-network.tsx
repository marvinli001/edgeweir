import type { Cluster, Node } from "@edgeweir/contract";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import type { GlobeMarker, GlobeTone } from "@/components/effects/edge-globe";
import { FlowScaled } from "@/components/effects/number-flow";
import { Dot, LiveDot, type StatusTone } from "@/components/status-dot";
import { countryName } from "@/lib/access-logs";
import { nodePlaceOf } from "@/lib/edge-map";
import { formatBitRate, m } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const EdgeGlobe = React.lazy(() => import("@/components/effects/edge-globe"));

const BIT_UNITS = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"] as const;

interface Location {
  id: string;
  region: string;
  clusterId: string;
  clusterName: string;
  online: number;
  total: number;
  egress: number;
  tone: StatusTone;
  /** Why the light is not green, in words (the light never says it alone). */
  state: string | null;
}

/**
 * Where a location stands: all serving (good), some down or behind (warn), or none serving (bad),
 * with the word for the worst cause: offline, data plane unhealthy, behind.
 */
function standingOf(
  nodes: Node[],
  latest: (node: Node) => number,
): { tone: GlobeTone; state: string | null } {
  const online = nodes.filter((n) => n.online);
  const serving = online.filter((n) => n.dataPlaneHealthy);
  const unhealthy = online.length > serving.length;
  const lagging = online.some((n) => n.appliedRevision < (n.targetRevision ?? latest(n)));
  if (serving.length === 0)
    return { tone: "bad", state: unhealthy ? m.nodes_unhealthy() : m.nodes_offline() };
  if (unhealthy) return { tone: "warn", state: m.nodes_unhealthy() };
  if (online.length < nodes.length) return { tone: "warn", state: m.nodes_offline() };
  if (lagging) return { tone: "warn", state: m.nodes_behind() };
  return { tone: "good", state: null };
}

/** The latest revision of a node's cluster. */
function latestOf(clusters: Cluster[]): (node: Node) => number {
  const latest = new Map(clusters.map((c) => [c.id, c.latestRevision?.revision ?? 0]));
  return (node) => latest.get(node.clusterId) ?? 0;
}

function locationsOf(nodes: Node[], clusters: Cluster[]): Location[] {
  const latest = latestOf(clusters);
  const groups = new Map<string, Node[]>();
  for (const node of nodes) {
    if (node.status !== "active") continue;
    const key = `${node.clusterId}:${node.regionName ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }
  return [...groups.entries()].map(([key, list]) => {
    const first = list[0] as Node;
    return {
      id: key.replace(/[^a-zA-Z0-9-]/g, "-"),
      region: first.regionName ?? first.clusterName,
      clusterId: first.clusterId,
      clusterName: first.clusterName,
      online: list.filter((n) => n.online).length,
      total: list.length,
      egress: list.reduce((sum, n) => sum + (n.online ? (n.metrics?.egressBps ?? 0) : 0), 0),
      ...standingOf(list, latest),
    };
  });
}

/**
 * A marker per place the nodes' public addresses are at (their GeoIP location, reported by the
 * nodes), colored by the worst standing there and sized by its share of the nodes. Nodes whose
 * address no database knows are left off the globe.
 */
function markersOf(nodes: Node[], clusters: Cluster[]): GlobeMarker[] {
  const latest = latestOf(clusters);
  const places = new Map<string, { location: [number, number]; country: string; nodes: Node[] }>();
  for (const node of nodes) {
    if (node.status !== "active") continue;
    const place = nodePlaceOf(node.location);
    if (!place || !node.location) continue;
    const key = `${place[0].toFixed(1)}_${place[1].toFixed(1)}`;
    const entry = places.get(key) ?? { location: place, country: node.location.country, nodes: [] };
    entry.nodes.push(node);
    places.set(key, entry);
  }
  const most = Math.max(1, ...[...places.values()].map((p) => p.nodes.length));
  return [...places.entries()].map(([key, place]) => {
    const country = countryName(place.country);
    const only = place.nodes.length === 1 ? place.nodes[0] : undefined;
    return {
      id: `node-${key.replace(/[^0-9_]/g, (c) => (c === "-" ? "m" : "d"))}`,
      location: place.location,
      tone: standingOf(place.nodes, latest).tone,
      weight: place.nodes.length / most,
      label: only
        ? `${only.name} · ${country}`
        : m.overview_globe_place({ place: country, count: place.nodes.length }),
    };
  });
}

/**
 * The edge network at a glance: the nodes on a globe where their public addresses are, colored
 * by their health, and the locations listed with their health in words, nodes and egress (the
 * list is the globe's text alternative). Side by side where the card is wide (it spans the row), stacked where it is narrow
 * (a column of the bento).
 */
export function EdgeNetworkCard({
  nodes,
  clusters,
  className,
}: {
  nodes: Node[];
  clusters: Cluster[];
  className?: string;
}) {
  const locations = React.useMemo(() => locationsOf(nodes, clusters), [nodes, clusters]);
  const totalEgress = locations.reduce((sum, l) => sum + l.egress, 0);
  const markers = React.useMemo(() => markersOf(nodes, clusters), [nodes, clusters]);

  return (
    <section
      className={cn(
        "@container/edge relative flex min-w-0 flex-col overflow-hidden rounded-lg border bg-card ",
        className,
      )}
      aria-labelledby="edge-network-title"
      data-testid="edge-network"
    >
      <div className="flex items-start justify-between gap-3 px-4 pt-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="edge-network-title" className="truncate text-dense text-muted-foreground">
            {m.overview_edge_network()}
          </h2>
          <div className="flex items-baseline gap-2">
            <span className="text-display font-medium">
              <FlowScaled value={totalEgress} units={BIT_UNITS} />
            </span>
            <span className="text-xs text-muted-foreground">{m.overview_egress()}</span>
          </div>
        </div>
        <LiveDot label={m.overview_live()} className="mt-0.5 shrink-0" />
      </div>
      <div className="grid flex-1 content-start items-center gap-2 p-2 @2xl/edge:grid-cols-[minmax(0,17rem)_minmax(0,1fr)] @2xl/edge:content-center">
        <div className="relative mx-auto w-full max-w-60 py-2" aria-hidden>
          <React.Suspense fallback={<div className="aspect-square w-full" />}>
            <EdgeGlobe markers={markers} />
          </React.Suspense>
        </div>
        <ul className="flex min-w-0 flex-col" data-testid="edge-locations">
          {locations.length === 0 ? (
            <li className="flex h-10 items-center px-2 text-sm text-muted-foreground">
              {m.nodes_empty_title()}
            </li>
          ) : null}
          {locations.map((location) => (
            <li key={location.id}>
              <Link
                to="/clusters"
                search={{ cluster: location.clusterId }}
                className="grid min-h-10 pointer-coarse:min-h-11 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-md px-2 py-1.5 text-sm outline-none transition-colors focus-ring hover:bg-wash focus-visible:bg-wash"
              >
                <Dot tone={location.tone} />
                <span className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="min-w-0 truncate font-medium">{location.region}</span>
                  {/*
                    Narrow rows give up the cluster name first: it takes no room of its own (zero
                    basis) and only grows into what is left, up to its full width. The state word
                    is never cut: when it does not fit beside the region it moves to a line of its
                    own (and wraps there if even that is too narrow).
                  */}
                  <span className="max-w-max min-w-0 grow basis-0 truncate text-xs text-muted-foreground">
                    {location.clusterName}
                  </span>
                  {location.state ? (
                    <span className="text-xs font-medium">{location.state}</span>
                  ) : null}
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {m.clusters_nodes_count({ online: location.online, total: location.total })}
                </span>
                <span className="min-w-16 text-right text-xs font-medium tabular-nums">
                  {formatBitRate(location.egress / 8)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
