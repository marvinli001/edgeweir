import type { Cluster, Node } from "@edgeweir/contract";
import { ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { AnimatedBeam } from "@/components/effects/animated-beam";
import { Dot, type StatusTone } from "@/components/status-dot";
import { formatBitRate, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

/** How many nodes the strip draws; the node cards below list them all. */
const SHOWN = 8;

function toneOf(node: Node, latest: number): StatusTone {
  if (node.status === "disabled") return "idle";
  if (!node.online) return "bad";
  if (!node.dataPlaneHealthy || node.applyState === "failed") return "bad";
  return node.appliedRevision < (node.targetRevision ?? latest) ? "warn" : "good";
}

/**
 * The cluster and its nodes, joined by the configuration channel: a beam runs to every online
 * node (a quiet signal pulse, the page's only loop), an offline or disabled one hangs on a dashed
 * idle line. Each node shows its applied revision (with a word while it lags) and its egress.
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
      className="@container relative grid grid-cols-[auto_minmax(0,22rem)] content-center items-center justify-center gap-x-[clamp(2rem,14cqi,9rem)] overflow-hidden rounded-xl px-3 py-4 sunk-well @2xl/main:px-4"
      data-testid="cluster-links"
    >
      <div className="relative z-[1] flex flex-col items-center gap-1.5 rounded-xl bg-raised p-2 shadow-elev-2 edge-lit @min-[26rem]:px-3 @min-[26rem]:py-2.5">
        <span
          ref={hub}
          aria-hidden
          className="lit-glow absolute top-1/2 -right-1 size-2 -translate-y-1/2 rounded-full border border-transparent bg-signal"
        />
        <span className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground btn-lit [&_svg]:size-4">
          <HugeiconsIcon icon={ServerStack01Icon} strokeWidth={2} />
        </span>
        <span className="hidden max-w-24 truncate text-xs font-medium @min-[26rem]:block">
          {cluster.name}
        </span>
        {cluster.latestRevision ? (
          <span className="hidden font-mono text-[11px] text-muted-foreground @min-[26rem]:block">
            #{cluster.latestRevision.revision}
          </span>
        ) : null}
      </div>
      <ul className="relative z-[1] flex w-full flex-col gap-2">
        {list.map((node, index) => {
          const tone = toneOf(node, latest);
          const target = node.targetRevision ?? latest;
          const lagging = node.appliedRevision > 0 && node.appliedRevision < target;
          return (
            <li
              key={node.id}
              className="relative flex min-w-0 items-center gap-2 rounded-lg bg-raised px-2.5 py-1.5 text-xs shadow-elev-1 animate-enter"
              style={{ animationDelay: `${Math.min(index, 12) * 40}ms` }}
            >
              <span
                ref={refFor(node.id)}
                aria-hidden
                className={cn(
                  "absolute top-1/2 -left-1 size-1.5 -translate-y-1/2 rounded-full",
                  node.online && node.status !== "disabled" ? "bg-signal" : "bg-border",
                )}
              />
              <Dot tone={tone} glow={node.online && tone === "good"} small />
              <span className="min-w-0 flex-1 truncate font-medium">{node.name}</span>
              {node.appliedRevision > 0 ? (
                <span className="hidden shrink-0 items-center gap-1 font-mono text-[11px] text-muted-foreground @min-[22rem]:inline-flex">
                  #{node.appliedRevision}
                  {lagging ? (
                    <span className="font-sans text-foreground">{m.nodes_behind()}</span>
                  ) : null}
                </span>
              ) : null}
              <span className="shrink-0 text-right tabular-nums text-muted-foreground @min-[22rem]:w-[4.75rem]">
                {node.online && node.metrics
                  ? formatBitRate(node.metrics.egressBps / 8)
                  : node.status === "disabled"
                    ? m.nodes_disabled()
                    : m.nodes_offline()}
              </span>
            </li>
          );
        })}
      </ul>
      {list.map((node, index) => (
        <AnimatedBeam
          key={node.id}
          containerRef={container}
          fromRef={hub}
          toRef={refFor(node.id)}
          dim={!node.online || node.status === "disabled"}
          delay={index * 0.6}
          curvature={0}
          className="z-0"
        />
      ))}
    </div>
  );
}
