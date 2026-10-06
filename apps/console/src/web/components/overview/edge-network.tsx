import type { Cluster, Node } from "@edgeweir/contract";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import type { GlobeArc, GlobeMarker, GlobeTone } from "@/components/effects/edge-globe";
import { FlowScaled } from "@/components/effects/number-flow";
import { Spotlight } from "@/components/effects/spotlight";
import { Dot } from "@/components/status-dot";
import { placeOf } from "@/lib/edge-map";
import { formatBitRate, m } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useVisitorFlows } from "@/lib/visitor-flows";

const EdgeGlobe = React.lazy(() => import("@/components/effects/edge-globe"));

const BIT_UNITS = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"] as const;

interface Location {
  id: string;
  region: string;
  clusterId: string;
  clusterName: string;
  place: [number, number] | null;
  online: number;
  total: number;
  egress: number;
  tone: GlobeTone;
}

/** Where a location stands: all serving, some down or behind, or none serving. */
function toneOf(nodes: Node[], latest: number): GlobeTone {
  const serving = nodes.filter((n) => n.online && n.dataPlaneHealthy);
  if (serving.length === 0) return "bad";
  const lagging = nodes.some((n) => n.online && n.appliedRevision < (n.targetRevision ?? latest));
  return serving.length < nodes.length || lagging ? "warn" : "good";
}

function locationsOf(nodes: Node[], clusters: Cluster[]): Location[] {
  const latest = new Map(clusters.map((c) => [c.id, c.latestRevision?.revision ?? 0]));
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
      place: placeOf(first.regionName),
      online: list.filter((n) => n.online).length,
      total: list.length,
      egress: list.reduce((sum, n) => sum + (n.online ? (n.metrics?.egressBps ?? 0) : 0), 0),
      tone: toneOf(list, latest.get(first.clusterId) ?? 0),
    };
  });
}

/**
 * The edge network at a glance: every edge location on a globe, colored by health, with the
 * traffic flowing into it, and the locations listed with their nodes and egress.
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
  const flows = useVisitorFlows();
  const locations = React.useMemo(() => locationsOf(nodes, clusters), [nodes, clusters]);
  const totalEgress = locations.reduce((sum, l) => sum + l.egress, 0);
  const maxNodes = Math.max(1, ...locations.map((l) => l.total));
  const markers = React.useMemo<GlobeMarker[]>(
    () =>
      locations.flatMap((l) =>
        l.place
          ? [
              {
                id: l.id,
                location: l.place,
                tone: l.tone,
                weight: l.total / maxNodes,
                label: l.region,
              },
            ]
          : [],
      ),
    [locations, maxNodes],
  );
  const arcs = React.useMemo<GlobeArc[]>(
    () =>
      flows.flatMap((flow, index) => {
        const target = locations.find((l) => l.region === flow.to && l.place);
        return target?.place ? [{ id: `flow-${index}`, from: flow.from, to: target.place }] : [];
      }),
    [flows, locations],
  );

  return (
    <section
      className={cn(
        "relative grid overflow-hidden rounded-2xl bg-card shadow-elev-1 edge-lit animate-enter @3xl/main:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]",
        className,
      )}
      aria-labelledby="edge-network-title"
      data-testid="edge-network"
    >
      <Spotlight size={520} />
      <div className="relative z-[1] flex items-center justify-center p-4 @3xl/main:pr-0">
        <div className="relative w-full max-w-[19rem]">
          {/* Light under the globe, so the sphere sits in it rather than on the card. */}
          <div
            aria-hidden
            className="absolute inset-[6%] rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--primary)_14%,transparent),transparent)] blur-2xl dark:bg-[radial-gradient(closest-side,color-mix(in_oklch,var(--signal)_18%,transparent),transparent)]"
          />
          <React.Suspense fallback={<div className="aspect-square w-full" />}>
            <EdgeGlobe markers={markers} arcs={arcs} />
          </React.Suspense>
        </div>
      </div>
      <div className="relative z-[1] flex min-w-0 flex-col gap-3 px-3 pt-1 pb-3 @3xl/main:pt-4">
        <div className="flex flex-col gap-0.5 px-2">
          <h2 id="edge-network-title" className="text-[13px] text-muted-foreground">
            {m.overview_edge_network()}
          </h2>
          <div className="flex items-baseline gap-2">
            <span className="text-[1.75rem] leading-tight font-semibold tracking-tight">
              <FlowScaled value={totalEgress} units={BIT_UNITS} />
            </span>
            <span className="text-[13px] text-muted-foreground">{m.overview_egress()}</span>
          </div>
        </div>
        <ul className="flex flex-col">
          {locations.map((location) => (
            <li key={location.id}>
              <Link
                to="/clusters"
                search={{ cluster: location.clusterId }}
                className="grid h-10 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 rounded-xl px-2 text-sm outline-none transition-colors hover:bg-foreground/[0.04] focus-visible:bg-foreground/[0.06]"
              >
                <Dot tone={location.tone} pulse={location.online > 0} />
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate font-medium">{location.region}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {location.clusterName}
                  </span>
                </span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {m.clusters_nodes_count({ online: location.online, total: location.total })}
                </span>
                <span className="w-20 text-right text-xs font-medium tabular-nums">
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
