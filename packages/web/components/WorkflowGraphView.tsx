import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useInternalNode,
  type InternalNode,
  type Node,
  type Edge,
  type EdgeTypes,
  type NodeTypes,
  BackgroundVariant,
  MarkerType,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useTheme } from "./ThemeProvider";
import { STILL_FLOW_PROPS } from "../lib/stillFlow";

export interface WFNode {
  id: string;
  label: string;
  shape: string;
  type: string;
  prompt?: string;
  script?: string;
  goal_gate?: boolean;
  retry_target?: string;
  max_visits?: number;
  reasoning_effort?: string;
  model?: string;
}

export interface WFEdge {
  from: string;
  to: string;
  label?: string;
  condition?: string;
}

export type NodeStatus = "pending" | "running" | "completed" | "failed";

interface WorkflowGraphViewProps {
  nodes: WFNode[];
  edges: WFEdge[];
  onNodeSelect?: (node: WFNode | null) => void;
  selectedNodeId?: string | null;
  nodeStatuses?: Record<string, NodeStatus>;
  currentNodeId?: string;
  // False draws the graph as a still picture: no zoom controls or minimap, and
  // no pan, zoom or wheel capture (the marketing hero shows it inside a page
  // that must keep scrolling). Default true.
  chrome?: boolean;
  /** The margin fitView keeps around the graph, as a fraction of the box. Default 0.2. */
  fitPadding?: number;
  /** Nodes tagged "edited" (a customized line's stations that differ from shipped). */
  markedNodeIds?: ReadonlySet<string>;
  /** Open fitted to the first N layers instead of the whole graph, so a long
   *  chain (the line's ~30 stations) opens readable at its start and pans. */
  fitLayers?: number;
  /** Draw the minimap (default: with chrome). A one-row chain makes it a blank strip. */
  minimap?: boolean;
}

// Solarized palette
const SOL = {
  dark: {
    bg:        "#002b36",
    bgAlt:     "#073642",
    bgHighlight:"#094959",
    border:    "#586e75",
    text:      "#fdf6e3",
    textMuted: "#93a1a1",
    textDim:   "#657b83",
    cyan:      "#2aa198",
    blue:      "#268bd2",
    green:     "#859900",
    yellow:    "#b58900",
    orange:    "#cb4b16",
    magenta:   "#d33682",
    violet:    "#6c71c4",
    red:       "#dc322f",
  },
  light: {
    bg:        "#fdf6e3",
    bgAlt:     "#eee8d5",
    bgHighlight:"#e4ddc8",
    border:    "#93a1a1",
    text:      "#002b36",
    textMuted: "#586e75",
    textDim:   "#657b83",
    cyan:      "#2aa198",
    blue:      "#268bd2",
    green:     "#859900",
    yellow:    "#b58900",
    orange:    "#cb4b16",
    magenta:   "#d33682",
    violet:    "#6c71c4",
    red:       "#dc322f",
  },
};

type SolPalette = typeof SOL.dark;

function getNodeColors(type: string, p: SolPalette): { bg: string; border: string; text: string } {
  switch (type) {
    case "start":
    case "exit":          return { bg: p.bgAlt,  border: p.blue,    text: p.blue };
    case "agent":         return { bg: p.bgAlt,  border: p.border,  text: p.text };
    case "prompt":        return { bg: p.bgAlt,  border: p.violet,  text: p.violet };
    case "command":       return { bg: p.bgAlt,  border: p.green,   text: p.green };
    case "human":         return { bg: p.bgAlt,  border: p.magenta, text: p.magenta };
    case "conditional":   return { bg: p.bgAlt,  border: p.yellow,  text: p.yellow };
    case "parallel_fanout":
    case "parallel_fanin":return { bg: p.bgAlt,  border: p.cyan,    text: p.cyan };
    default:              return { bg: p.bgAlt,  border: p.border,  text: p.text };
  }
}

const NODE_W = 160;
const NODE_H = 48;
const GAP_X = 100;
const GAP_Y = 36;
const PAD = 60;

// Custom node — theme aware via CSS variables
function getStatusOverride(status: NodeStatus | undefined, isCurrent: boolean, p: SolPalette): { border?: string; bg?: string; shadow?: string } | null {
  if (!status) return null;
  switch (status) {
    case "running":  return { border: p.cyan, bg: p.bgAlt, shadow: `0 0 8px ${p.cyan}44` };
    case "completed": return { border: p.green };
    case "failed":    return { border: p.red };
    default:          return null;
  }
}

function WorkflowNode({ data, selected }: { data: any; selected?: boolean }) {
  const node = data.wfNode as WFNode;
  const nodeStatus = data.nodeStatus as NodeStatus | undefined;
  const isCurrent = data.isCurrent as boolean;
  const marked = data.marked as boolean;
  const { theme } = useTheme();
  const p = SOL[theme];
  const colors = getNodeColors(node.type, p);
  const shapeStyle = getClipPath(node.shape);
  const statusOverride = getStatusOverride(nodeStatus, isCurrent, p);

  const borderColor = statusOverride?.border ?? (selected ? colors.border : colors.border + "99");
  const bgColor = statusOverride?.bg ?? colors.bg;
  const shadow = isCurrent && nodeStatus === "running"
    ? `0 0 12px ${p.cyan}66, 0 0 4px ${p.cyan}33`
    : statusOverride?.shadow ?? (selected ? `0 0 0 3px ${colors.border}33` : "none");

  return (
    <div
      style={{
        width: NODE_W,
        height: NODE_H,
        background: bgColor,
        border: `${selected ? 2 : 1.5}px solid ${borderColor}`,
        color: colors.text,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 2,
        boxShadow: shadow,
        position: "relative",
        animation: isCurrent && nodeStatus === "running" ? "pulse 2s ease-in-out infinite" : undefined,
        ...shapeStyle,
      }}
    >
      <Handle id="left"   type="target" position={Position.Left}   style={{ background: colors.border, width: 5, height: 5, border: "none" }} />
      <Handle id="right"  type="source" position={Position.Right}  style={{ background: colors.border, width: 5, height: 5, border: "none" }} />
      <Handle id="bottom-source" type="source" position={Position.Bottom} style={{ background: "transparent", border: "none", width: 1, height: 1 }} />
      <Handle id="bottom-target" type="target" position={Position.Bottom} style={{ background: "transparent", border: "none", width: 1, height: 1 }} />
      <div style={{ fontSize: 9, opacity: 0.5, fontFamily: "monospace", lineHeight: 1, color: p.textDim }}>
        {node.id}
      </div>
      <div style={{ fontSize: 11, fontWeight: 600, lineHeight: 1.2, textAlign: "center", padding: "0 8px", color: p.text }}>
        {node.label.length > 22 ? node.label.slice(0, 20) + "…" : node.label}
      </div>
      {marked && (
        <div data-marked style={{ position: "absolute", top: 2, left: 6, fontSize: 7, color: p.magenta, fontFamily: "monospace", letterSpacing: 0.3 }}>
          edited
        </div>
      )}
      {node.goal_gate && (
        <div style={{ position: "absolute", top: 2, right: 5, fontSize: 7, color: p.yellow, opacity: 0.8, fontFamily: "monospace" }}>
          gate
        </div>
      )}
    </div>
  );
}

function getClipPath(shape: string): React.CSSProperties {
  switch (shape) {
    case "Mdiamond":
    case "diamond":      return { clipPath: "polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)", borderRadius: 0 };
    case "hexagon":      return { clipPath: "polygon(12% 0%, 88% 0%, 100% 50%, 88% 100%, 12% 100%, 0% 50%)", borderRadius: 0 };
    case "parallelogram":return { clipPath: "polygon(8% 0%, 100% 0%, 92% 100%, 0% 100%)", borderRadius: 0 };
    case "Msquare":      return { borderRadius: 3, outline: "2px solid currentColor", outlineOffset: 3 };
    default:             return { borderRadius: 6 };
  }
}

/**
 * Where an edge meets a node, from the node's laid-out box rather than from
 * React Flow's handle measurement, which reads screen rects and divides by
 * its own zoom only: under any outer CSS transform (a scaled panel, the
 * marketing hero's camera) it would put every end off its node.
 */
function handlePoint(node: InternalNode | undefined, handle: string | null | undefined): { x: number; y: number } | null {
  if (!node) return null;
  const { x, y } = node.internals.positionAbsolute;
  const w = node.measured.width ?? NODE_W;
  const h = node.measured.height ?? NODE_H;
  if (handle === "right") return { x: x + w, y: y + h / 2 };
  if (handle === "left") return { x, y: y + h / 2 };
  return { x: x + w / 2, y: y + h };
}

function WorkflowEdge({ source, target, sourceHandleId, targetHandleId, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, markerEnd, style }: any) {
  const from = handlePoint(useInternalNode(source), sourceHandleId) ?? { x: sourceX, y: sourceY };
  const to = handlePoint(useInternalNode(target), targetHandleId) ?? { x: targetX, y: targetY };
  const [edgePath, labelX, labelY] = getSmoothStepPath({ sourceX: from.x, sourceY: from.y, sourcePosition, targetX: to.x, targetY: to.y, targetPosition });
  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={style} />
      {data?.label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: "absolute",
              left: labelX,
              top: labelY,
              transform: "translate(-50%, -50%)",
              fontSize: 9,
              color: data.labelColor,
              fontFamily: "monospace",
              background: data.bg,
              border: `1px solid ${data.labelColor}44`,
              padding: "1px 5px",
              borderRadius: 3,
              pointerEvents: "none",
              whiteSpace: "nowrap",
            }}
            className="nodrag nopan"
          >
            {data.label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes: NodeTypes = { workflow: WorkflowNode };
const edgeTypes: EdgeTypes = { workflowEdge: WorkflowEdge };

function bfsLayers(nodes: WFNode[], edges: WFEdge[]): WFNode[][] {
  const inDeg = new Map<string, number>();
  const outEdges = new Map<string, string[]>();
  for (const n of nodes) { inDeg.set(n.id, 0); outEdges.set(n.id, []); }

  // Detect back-edges
  const visited = new Set<string>(), inStack = new Set<string>(), backSet = new Set<string>();
  function dfs(id: string) {
    visited.add(id); inStack.add(id);
    for (const e of edges) {
      if (e.from !== id) continue;
      const k = `${e.from}->${e.to}`;
      if (inStack.has(e.to)) { backSet.add(k); continue; }
      if (!visited.has(e.to)) dfs(e.to);
    }
    inStack.delete(id);
  }
  const start = nodes.find(n => n.type === "start") || nodes[0];
  if (start) dfs(start.id);

  for (const e of edges) {
    if (backSet.has(`${e.from}->${e.to}`)) continue;
    outEdges.get(e.from)?.push(e.to);
    inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
  }

  const layers: WFNode[][] = [];
  const remaining = new Set(nodes.map(n => n.id));
  while (remaining.size > 0) {
    const layer = nodes.filter(n => remaining.has(n.id) && (inDeg.get(n.id) || 0) === 0);
    if (!layer.length) { layers.push(nodes.filter(n => remaining.has(n.id))); break; }
    layers.push(layer);
    for (const n of layer) {
      remaining.delete(n.id);
      for (const next of outEdges.get(n.id) || []) inDeg.set(next, (inDeg.get(next) || 0) - 1);
    }
  }
  return layers;
}

function buildGraph(wfNodes: WFNode[], wfEdges: WFEdge[], p: SolPalette, nodeStatuses?: Record<string, NodeStatus>, currentNodeId?: string, markedNodeIds?: ReadonlySet<string>) {
  const layers = bfsLayers(wfNodes, wfEdges);

  // Re-detect back-edges for edge styling
  const visited = new Set<string>(), inStack = new Set<string>(), backSet = new Set<string>();
  function dfs(id: string) {
    visited.add(id); inStack.add(id);
    for (const e of wfEdges) {
      if (e.from !== id) continue;
      if (inStack.has(e.to)) { backSet.add(`${e.from}->${e.to}`); continue; }
      if (!visited.has(e.to)) dfs(e.to);
    }
    inStack.delete(id);
  }
  const start = wfNodes.find(n => n.type === "start") || wfNodes[0];
  if (start) dfs(start.id);

  let maxH = 0;
  for (const l of layers) maxH = Math.max(maxH, l.length);

  const pos = new Map<string, { x: number; y: number }>();
  for (let col = 0; col < layers.length; col++) {
    const layer = layers[col];
    const totalH = layer.length * NODE_H + (layer.length - 1) * GAP_Y;
    const startY = PAD + (maxH * (NODE_H + GAP_Y) - totalH) / 2;
    for (let row = 0; row < layer.length; row++) {
      pos.set(layer[row].id, { x: PAD + col * (NODE_W + GAP_X), y: startY + row * (NODE_H + GAP_Y) });
    }
  }

  const nodes: Node[] = wfNodes.map(n => ({
    id: n.id,
    type: "workflow",
    position: pos.get(n.id) || { x: 0, y: 0 },
    data: {
      wfNode: n,
      label: n.label,
      nodeStatus: nodeStatuses?.[n.id],
      isCurrent: currentNodeId === n.id,
      marked: markedNodeIds?.has(n.id) ?? false,
    },
    style: { width: NODE_W, height: NODE_H },
  }));

  const edges: Edge[] = wfEdges.map((e, i) => {
    const isBack = backSet.has(`${e.from}->${e.to}`);
    const stroke = isBack ? p.orange : p.border;
    const label = e.condition?.replace("outcome=", "") || e.label || undefined;
    return {
      id: `e${i}`,
      source: e.from,
      target: e.to,
      sourceHandle: isBack ? "bottom-source" : "right",
      targetHandle: isBack ? "bottom-target" : "left",
      type: "workflowEdge",
      style: { stroke, strokeWidth: 1.5, strokeDasharray: isBack ? "5 3" : undefined },
      markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 10 },
      data: { label, labelColor: isBack ? p.orange : p.textMuted, bg: p.bgAlt },
    };
  });

  return { nodes, edges, layers };
}

export function WorkflowGraphView({ nodes: wfNodes, edges: wfEdges, onNodeSelect, selectedNodeId, nodeStatuses, currentNodeId, chrome = true, fitPadding = 0.2, markedNodeIds, fitLayers, minimap = chrome }: WorkflowGraphViewProps) {
  const { theme } = useTheme();
  const p = SOL[theme];

  const { nodes: graphNodes, edges: graphEdges, layers } = useMemo(
    () => buildGraph(wfNodes, wfEdges, p, nodeStatuses, currentNodeId, markedNodeIds),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wfNodes, wfEdges, theme, nodeStatuses, currentNodeId, markedNodeIds]
  );

  const fitViewOptions = useMemo(() => ({
    padding: fitPadding,
    ...(fitLayers && layers.length > fitLayers ? { nodes: layers.slice(0, fitLayers).flat().map((n) => ({ id: n.id })) } : {}),
  }), [fitPadding, fitLayers, layers]);

  const nodesWithSelection = useMemo(() =>
    graphNodes.map(n => ({ ...n, selected: n.id === selectedNodeId })),
    [graphNodes, selectedNodeId]
  );

  if (wfNodes.length === 0) return null;

  return (
    <div style={{ width: "100%", height: "100%", background: p.bg }}>
      <ReactFlow
        nodes={nodesWithSelection}
        edges={graphEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={(_, node) => {
          const wf = wfNodes.find(n => n.id === node.id) || null;
          onNodeSelect?.(wf?.id === selectedNodeId ? null : wf);
        }}
        onPaneClick={() => onNodeSelect?.(null)}
        fitView
        fitViewOptions={fitViewOptions}
        minZoom={0.15}
        maxZoom={2}
        colorMode={theme}
        proOptions={{ hideAttribution: true }}
        style={{ background: p.bg }}
        {...(chrome ? {} : STILL_FLOW_PROPS)}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={20}
          size={1}
          color={p.bgHighlight}
          style={{ background: p.bg }}
        />
        {chrome && <Controls
          showInteractive={false}
          style={{
            background: p.bgAlt,
            border: `1px solid ${p.border}40`,
            borderRadius: 6,
          }}
        />}
        {chrome && minimap && <MiniMap
          nodeColor={(n) => {
            const wf = wfNodes.find(w => w.id === n.id);
            return getNodeColors(wf?.type || "agent", p).border;
          }}
          maskColor={`${p.bg}99`}
          style={{ background: p.bgAlt, border: `1px solid ${p.border}40` }}
        />}
      </ReactFlow>
    </div>
  );
}
