import type { Cluster, Node } from "@edgeweir/contract";
import { ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { AnimatedBeam } from "@/components/effects/animated-beam";
import { Dot, type StatusTone } from "@/components/status-dot";
import { formatBitRate, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/** How many nodes the strip draws; the table below lists them all. */
const SHOWN = 8;

function toneOf(node: Node, latest: number): StatusTone {
  if (node.status === "disabled") return "idle";
  if (!node.online) return "bad";
  if (!node.dataPlaneHealthy || node.applyState === "failed") return "bad";
  return node.appliedRevision < (node.targetRevision ?? latest) ? "warn" : "good";
}

/**
 * The cluster and its nodes, joined by the configuration channel: a beam runs to every online
 * node (signal pulse), an offline or disabled one hangs on a dashed idle line.
 */
export function ClusterLinks({ cluster }: { cluster: Cluster }) {
  const nodes = useQuery({
    ...orpc.nodes.list.queryOptions({ input: { clusterId: cluster.id } }),
    refetchInterval: 5_000,
    meta: { background: true },
  });
  const container = React.useRef<HTMLDivElement>(null);
  const hub = React.useRef<HTMLSpanElement>(null);
  const list = (nodes.data ?? []).slice(0, SHOWN);
  const refs = React.useRef(new Map<string, React.RefObject<HTMLSpanElement | null>>());
  const refFor = (id: string) => {
    let ref = refs.current.get(id);
    if (!ref) {
      ref = React.createRef<HTMLSpanElement>();
      refs.current.set(id, ref);
    }
    return ref;
  };
  if (list.length === 0) return null;
  const latest = cluster.latestRevision?.revision ?? 0;
  return (
    <div
      ref={container}
      className="relative grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-12 rounded-xl bg-well/60 px-4 py-4 sm:gap-x-28"
      data-testid="cluster-links"
    >
      <div className="relative z-[1] flex flex-col items-center gap-1.5 rounded-xl bg-raised px-3 py-2.5 shadow-elev-2 edge-lit">
        <span
          ref={hub}
          aria-hidden
          className="lit-glow absolute top-1/2 -right-1 size-2 -translate-y-1/2 rounded-full bg-signal"
        />
        <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground btn-lit [&_svg]:size-4">
          <HugeiconsIcon icon={ServerStack01Icon} strokeWidth={2} />
        </span>
        <span className="text-xs font-medium">{cluster.name}</span>
        {cluster.latestRevision ? (
          <span className="font-mono text-[11px] text-muted-foreground">
            #{cluster.latestRevision.revision}
          </span>
        ) : null}
      </div>
      <div className="relative z-[1] flex w-full max-w-sm flex-col gap-2">
        {list.map((node) => {
          const tone = toneOf(node, latest);
          return (
            <div
              key={node.id}
              className="relative flex min-w-0 items-center gap-2 rounded-lg bg-raised px-2.5 py-1.5 text-xs shadow-elev-1"
            >
              <span
                ref={refFor(node.id)}
                aria-hidden
                className="absolute top-1/2 -left-1 size-1.5 -translate-y-1/2 rounded-full bg-border"
              />
              <Dot tone={tone} pulse={node.online && tone === "good"} small />
              <span className="truncate font-medium">{node.name}</span>
              <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                {node.online && node.metrics
                  ? formatBitRate(node.metrics.egressBps / 8)
                  : m.nodes_offline()}
              </span>
            </div>
          );
        })}
      </div>
      {list.map((node, index) => (
        <AnimatedBeam
          key={node.id}
          containerRef={container}
          fromRef={hub}
          toRef={refFor(node.id)}
          dim={!node.online || node.status === "disabled"}
          delay={index * 0.35}
          curvature={0}
          className="z-0"
        />
      ))}
    </div>
  );
}
