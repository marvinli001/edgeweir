/*
 * A small directed graph read left to right (React Flow 12, MIT, webkid GmbH; nodes and edges
 * adapted from React Flow UI's base node, base handle and animated SVG edge, MIT; laid out with
 * dagre, MIT); narrow cards (phones) get an indented tree read top to bottom instead, at full
 * size, with each edge's label on its target. Read-only: no dragging, panning or wheel zoom, so
 * the page scrolls through it.
 * An image to assistive technology (role img with the caller's label): no node or edge takes
 * focus, and React Flow's own keyboard help, live region and edge labels (English, for editing)
 * stay out of the tree. Pulses travel the live edges only while the graph is on screen and motion
 * is allowed. Colors are token classes. Lazy-loaded with the page.
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

/** A node as drawn: in the tree, its incoming edge's label rides on it. */
type BoxData = TopologyNode & { tree?: boolean; edgeLabel?: string };
type GraphNode = Node<BoxData, "box">;
type GraphEdge = Edge<{ label?: string; kind: TopologyEdge["kind"] }, "flow" | "tree">;

/** The tree's indent per level, and where a parent's line down leaves it (left of its children). */
const TREE_INDENT = 24;
const TREE_LINE = 12;
const TREE_GAP = 10;
/** Cards narrower than this draw the tree. */
const TREE_BELOW = 560;

function BoxNode({ data }: NodeProps<GraphNode>) {
  return (
    <div
      className="flex h-full w-full items-center gap-2.5 rounded-md bg-raised px-3 text-left shadow-elev-1 "
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
                data.tone !== "idle" && "",
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
      {data.edgeLabel ? (
        <span className="shrink-0 rounded-md bg-well px-1.5 text-[10px] leading-4 font-medium text-muted-foreground tabular-nums">
          {data.edgeLabel}
        </span>
      ) : null}
      <Handle
        type="source"
        position={data.tree ? Position.Bottom : Position.Right}
        style={data.tree ? { left: TREE_LINE } : undefined}
        className="opacity-0"
        isConnectable={false}
      />
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
      {/* Stroke color, width and dashes per kind: .topology-edge in index.css. */}
      <BaseEdge id={id} path={path} className="topology-edge" data-kind={kind} />
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

/** The tree's edge: down the parent's line, then across into the child's left side. */
function TreeEdge({ id, sourceX, sourceY, targetX, targetY, data }: EdgeProps<GraphEdge>) {
  const live = React.useContext(LiveContext);
  const path = `M ${sourceX} ${sourceY} L ${sourceX} ${targetY} L ${targetX} ${targetY}`;
  const kind = data?.kind ?? "flow";
  return (
    <>
      <BaseEdge id={id} path={path} className="topology-edge" data-kind={kind} />
      {live && kind !== "standby" ? (
        <circle r={2.5} className={kind === "degraded" ? "fill-state-warn" : "fill-signal"}>
          <animateMotion dur="1.6s" repeatCount="indefinite" path={path} />
        </circle>
      ) : null}
    </>
  );
}

const nodeTypes = { box: BoxNode };
const edgeTypes = { flow: FlowEdge, tree: TreeEdge };

/** The sides of a scroller that hide more content fade out (scroll-fade), so a phone shows it scrolls. */
function markFade(element: HTMLElement) {
  const start = element.scrollLeft > 1;
  const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
  if (start || end) element.dataset.fade = start && end ? "both" : start ? "start" : "end";
  else delete element.dataset.fade;
}

/** A read-only graph: nothing moves, takes focus or captures the page's scrolling. */
const STATIC_FLOW = {
  nodeTypes,
  edgeTypes,
  nodesDraggable: false,
  nodesConnectable: false,
  nodesFocusable: false,
  edgesFocusable: false,
  elementsSelectable: false,
  disableKeyboardA11y: true,
  "aria-hidden": true,
  panOnDrag: false,
  zoomOnScroll: false,
  zoomOnPinch: false,
  zoomOnDoubleClick: false,
  preventScrolling: false,
  proOptions: { hideAttribution: true },
} as const;

/** fitView's padding on each side, as a share of the graph's size. */
const FIT_PADDING = 0.06;
/** The smallest scale the graph is drawn at; narrower cards scroll sideways instead. */
const MIN_SCALE = 0.72;

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
  return {
    placed,
    links,
    width: graph.graph().width ?? 960,
    height: graph.graph().height ?? 240,
  };
}

/**
 * The narrow layout: nodes in depth-first order, one per row, each indented a level past the
 * node its first incoming edge comes from, as wide as the card allows.
 */
function treeLayout(nodes: TopologyNode[], edges: TopologyEdge[], boxWidth: number) {
  const parentEdge = new Map<string, TopologyEdge>();
  for (const edge of edges) if (!parentEdge.has(edge.target)) parentEdge.set(edge.target, edge);
  const children = new Map<string, TopologyNode[]>();
  for (const node of nodes) {
    const parent = parentEdge.get(node.id)?.source;
    if (parent) children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  const order: { node: TopologyNode; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (node: TopologyNode, depth: number) => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    order.push({ node, depth });
    for (const child of children.get(node.id) ?? []) visit(child, depth + 1);
  };
  for (const node of nodes) if (!parentEdge.has(node.id)) visit(node, 0);
  for (const node of nodes) visit(node, 0);
  const deepest = Math.max(0, ...order.map((entry) => entry.depth));
  const width = Math.max(160, boxWidth - deepest * TREE_INDENT);
  const placed: GraphNode[] = order.map(({ node, depth }, index) => ({
    id: node.id,
    type: "box",
    data: { ...node, tree: true, edgeLabel: parentEdge.get(node.id)?.label },
    position: { x: depth * TREE_INDENT, y: index * (NODE_HEIGHT + TREE_GAP) },
    width,
    height: NODE_HEIGHT,
    draggable: false,
    selectable: false,
    connectable: false,
  }));
  const links: GraphEdge[] = edges
    .filter((edge) => parentEdge.get(edge.target) === edge)
    .map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "tree",
      data: { kind: edge.kind },
      selectable: false,
    }));
  return { placed, links, height: order.length * (NODE_HEIGHT + TREE_GAP) - TREE_GAP };
}

export default function OriginTopology({
  nodes,
  edges,
  label,
}: {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  /** What the graph shows, for screen readers (the graph itself is hidden from them). */
  label: string;
}) {
  const wrap = React.useRef<HTMLDivElement>(null);
  const live = useLive(wrap);
  const theme = useThemeKey();
  const { placed, links, width, height } = React.useMemo(
    () => layout(nodes, edges),
    [nodes, edges],
  );
  // Narrow cards would shrink the graph past legibility (React Flow's fitView stops at its
  // minZoom and crops the sides instead): below MIN_SCALE the graph keeps that scale and the
  // card scrolls sideways; the frame's height follows the scale the graph gets.
  const [boxWidth, setBoxWidth] = React.useState(0);
  React.useEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const mark = () => markFade(element);
    const observer = new ResizeObserver(([entry]) => {
      setBoxWidth(Math.round((entry?.contentRect.width ?? 0) / 8) * 8);
      mark();
    });
    observer.observe(element);
    element.addEventListener("scroll", mark, { passive: true });
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", mark);
    };
  }, []);
  const span = width * (1 + 2 * FIT_PADDING);
  const innerWidth = boxWidth > 0 ? Math.max(boxWidth, Math.round(span * MIN_SCALE)) : 0;
  const scale = innerWidth > 0 ? Math.min(1, innerWidth / span) : 1;
  const frameHeight = Math.min(
    420,
    Math.max(scale < 1 ? 140 : 220, Math.round((height + 24) * scale)),
  );
  const tree = boxWidth > 0 && boxWidth < TREE_BELOW;
  const treeGraph = React.useMemo(
    () => (tree ? treeLayout(nodes, edges, boxWidth) : null),
    [tree, nodes, edges, boxWidth],
  );
  // The inner frame's width changes after the box is measured; mark the fade again then.
  React.useEffect(() => {
    if (innerWidth > 0 && wrap.current) markFade(wrap.current);
  }, [innerWidth]);
  return (
    <LiveContext.Provider value={live}>
      <div
        ref={wrap}
        role="img"
        aria-label={label}
        className="topology w-full overflow-x-auto overflow-y-hidden overscroll-x-contain scroll-fade [scrollbar-width:none]"
      >
        {treeGraph ? (
          <div style={{ width: boxWidth, height: treeGraph.height }}>
            <ReactFlow
              key={boxWidth}
              nodes={treeGraph.placed}
              edges={treeGraph.links}
              defaultViewport={{ x: 0, y: 0, zoom: 1 }}
              {...STATIC_FLOW}
              colorMode={theme === "dark" ? "dark" : "light"}
            />
          </div>
        ) : (
          <div style={{ width: innerWidth || "100%", height: frameHeight }}>
            <ReactFlow
              key={innerWidth}
              nodes={placed}
              edges={links}
              fitView
              minZoom={MIN_SCALE * 0.9}
              fitViewOptions={{ padding: FIT_PADDING, maxZoom: 1, minZoom: MIN_SCALE * 0.9 }}
              {...STATIC_FLOW}
              colorMode={theme === "dark" ? "dark" : "light"}
            />
          </div>
        )}
      </div>
    </LiveContext.Provider>
  );
}
