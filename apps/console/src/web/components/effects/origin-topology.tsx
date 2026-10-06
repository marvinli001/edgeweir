/*
 * A small directed graph read left to right (React Flow 12, MIT, webkid GmbH; nodes and edges
 * adapted from React Flow UI's base node, base handle and animated SVG edge, MIT; laid out with
 * dagre, MIT). Read-only: no dragging, panning or wheel zoom, so the page scrolls through it.
 * Pulses travel the live edges only while the graph is on screen and motion is allowed. Colors
 * are token classes. Lazy-loaded with the page.
 */
import dagre from "@dagrejs/dagre";
import {
  BaseEdge,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  Handle,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import * as React from "react";
import { cn } from "@/lib/utils";
import { useThemeKey } from "./tokens";
import { useLive } from "./use-live";

export type TopologyTone = "good" | "warn" | "bad" | "idle";

// A type alias (not an interface): React Flow wants node data assignable to a record.
export type TopologyNode = {
  id: string;
  title: string;
  /** Second line (machine values set in mono). */
  detail?: string;
  mono?: boolean;
  tone?: TopologyTone;
  /** A short tag after the title (backup, group). */
  tag?: string;
  icon?: React.ReactNode;
};

export interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  /** flow: carries traffic; standby: failover path (dashed); degraded: carries traffic, with errors. */
  kind: "flow" | "standby" | "degraded";
}

const NODE_WIDTH = 212;
const NODE_HEIGHT = 58;

const TONE_DOT: Record<TopologyTone, string> = {
  good: "bg-state-good [--lit:var(--state-good)]",
  warn: "bg-state-warn [--lit:var(--state-warn)]",
  bad: "bg-destructive [--lit:var(--destructive)]",
  idle: "bg-muted-foreground/50",
};

const LiveContext = React.createContext(false);

type GraphNode = Node<TopologyNode, "box">;
type GraphEdge = Edge<{ label?: string; kind: TopologyEdge["kind"] }, "flow">;

function BoxNode({ data }: NodeProps<GraphNode>) {
  return (
    <div
      className="flex h-full w-full items-center gap-2.5 rounded-xl bg-raised px-3 text-left shadow-elev-1 edge-lit"
      data-tone={data.tone}
    >
      <Handle type="target" position={Position.Left} className="opacity-0" isConnectable={false} />
      {data.icon ? (
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-well text-muted-foreground [&_svg]:size-4">
          {data.icon}
        </span>
      ) : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-1.5">
          {data.tone ? (
            <span
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                TONE_DOT[data.tone],
                data.tone !== "idle" && "lit-glow",
              )}
            />
          ) : null}
          <span className="truncate text-[13px] font-medium text-foreground" title={data.title}>
            {data.title}
          </span>
          {data.tag ? (
            <span className="shrink-0 rounded-md bg-well px-1.5 text-[10px] leading-4 text-muted-foreground">
              {data.tag}
            </span>
          ) : null}
        </span>
        {data.detail ? (
          <span
            className={cn("truncate text-[11px] text-muted-foreground", data.mono && "font-mono")}
          >
            {data.detail}
          </span>
        ) : null}
      </span>
      <Handle type="source" position={Position.Right} className="opacity-0" isConnectable={false} />
    </div>
  );
}

function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
}: EdgeProps<GraphEdge>) {
  const live = React.useContext(LiveContext);
  const [path] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const kind = data?.kind ?? "flow";
  // Labels sit nearer the target than the midpoint, so fanned-out edges keep them apart.
  const labelX = sourceX + (targetX - sourceX) * 0.66;
  const labelY = sourceY + (targetY - sourceY) * 0.66;
  return (
    <>
      {/* Inline style: React Flow's own stylesheet sets the stroke after the utilities. */}
      <BaseEdge
        id={id}
        path={path}
        style={{
          fill: "none",
          strokeWidth: kind === "standby" ? 1.25 : 1.5,
          strokeDasharray: kind === "standby" ? "4 5" : undefined,
          stroke:
            kind === "standby"
              ? "color-mix(in oklch, var(--muted-foreground) 60%, transparent)"
              : kind === "degraded"
                ? "var(--state-warn)"
                : "color-mix(in oklch, var(--signal) 75%, transparent)",
        }}
      />
      {live && kind !== "standby" ? (
        <circle r={2.5} className={kind === "degraded" ? "fill-state-warn" : "fill-signal"}>
          <animateMotion dur="2.4s" repeatCount="indefinite" path={path} />
        </circle>
      ) : null}
      {data?.label ? (
        <EdgeLabelRenderer>
          <span
            className={cn(
              "nodrag nopan pointer-events-none absolute rounded-md px-1.5 text-[10px] leading-4 font-medium tabular-nums shadow-elev-1",
              kind === "standby" ? "bg-well text-muted-foreground" : "bg-raised text-foreground",
            )}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data.label}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

const nodeTypes = { box: BoxNode };
const edgeTypes = { flow: FlowEdge };

function layout(nodes: TopologyNode[], edges: TopologyEdge[]) {
  const graph = new dagre.graphlib.Graph();
  graph.setGraph({ rankdir: "LR", nodesep: 18, ranksep: 72, marginx: 8, marginy: 8 });
  graph.setDefaultEdgeLabel(() => ({}));
  for (const node of nodes) graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const edge of edges) graph.setEdge(edge.source, edge.target);
  dagre.layout(graph);
  const placed: GraphNode[] = nodes.map((node) => {
    const at = graph.node(node.id);
    return {
      id: node.id,
      type: "box",
      data: node,
      position: { x: (at?.x ?? 0) - NODE_WIDTH / 2, y: (at?.y ?? 0) - NODE_HEIGHT / 2 },
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      draggable: false,
      selectable: false,
      connectable: false,
    };
  });
  const links: GraphEdge[] = edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    type: "flow",
    data: { label: edge.label, kind: edge.kind },
    selectable: false,
  }));
  return { placed, links, height: graph.graph().height ?? 240 };
}

export default function OriginTopology({
  nodes,
  edges,
  label,
}: {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  /** What the graph shows, for screen readers. */
  label: string;
}) {
  const wrap = React.useRef<HTMLDivElement>(null);
  const live = useLive(wrap);
  const theme = useThemeKey();
  const { placed, links, height } = React.useMemo(() => layout(nodes, edges), [nodes, edges]);
  return (
    <LiveContext.Provider value={live}>
      <div
        ref={wrap}
        role="img"
        aria-label={label}
        className="topology w-full"
        style={{ height: Math.min(420, Math.max(220, height + 24)) }}
      >
        <ReactFlow
          nodes={placed}
          edges={links}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          colorMode={theme === "dark" ? "dark" : "light"}
          fitView
          fitViewOptions={{ padding: 0.06, maxZoom: 1 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          preventScrolling={false}
          proOptions={{ hideAttribution: true }}
        />
      </div>
    </LiveContext.Provider>
  );
}
