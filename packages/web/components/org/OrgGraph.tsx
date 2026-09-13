"use client";
// The org canvas: React Flow over the tidy tree from orgLayout. Owns nothing
// but view geometry: the tree comes from the store, the view state (collapsed,
// expanded clusters, selection) from the page, and every gesture is reported
// upward as an intent (select, toggle, expand, reparent request, context menu).
import { useCallback, useMemo, useRef, useState } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useEventListener } from "../../hooks/useEventListener";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  useReactFlow,
  useOnViewportChange,
  useNodesState,
  type Viewport,
  useEdgesState,
  type Node,
  type Edge,
  type NodeMouseHandler,
  type OnNodeDrag,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useTheme } from "../ThemeProvider";
import { layoutOrgTree, parentRefOfNodeId, type OrgLayoutNode, type OrgLayoutView } from "./orgLayout";
import { ORG_NODE_TYPES } from "./OrgNodeCards";
import { sameParent, type OrgParentRef, type OrgTree } from "./orgTypes";

export type OrgReparentRequest = {
  subject: { kind: "session"; id: string; title: string } | { kind: "role"; id: string; title: string };
  target: OrgParentRef;
  targetTitle: string;
  /** Screen position of the drop, for the confirm popover. */
  at: { x: number; y: number };
};

export type OrgGraphProps = {
  tree: OrgTree;
  view: OrgLayoutView;
  selectedId: string | null;
  loadingClusters: ReadonlySet<string>;
  showMiniMap: boolean;
  onSelect: (id: string | null) => void;
  onToggleCollapse: (id: string) => void;
  onExpandCluster: (parentId: string) => void;
  onCollapseCluster: (parentId: string) => void;
  onReparentRequest: (req: OrgReparentRequest) => void;
  onNodeContextMenu: (e: React.MouseEvent, node: OrgLayoutNode) => void;
  onOpenSession?: (conversationId: string) => void;
  /** Bumped by the page after a cancelled move, to snap the card back. */
  resetKey?: number;
  /** Width of the panel overlaying the right edge of the canvas (0 = closed).
   *  The fit uses the canvas left of it. */
  panelWidth?: number;
};

/** Below this zoom a 13px session title renders under 12px: not readable.
 *  Rather than fit the whole tree that small, fit the root tier and pan. */
const MIN_READABLE_ZOOM = 0.92;
const FIT_PAD = 24;
const ROOT_KINDS = new Set(["person", "role", "anchor"]);

type Rect = { x: number; y: number; w: number; h: number };
function boundsOf(nodes: OrgLayoutNode[]): Rect | null {
  if (nodes.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.w); y1 = Math.max(y1, n.y + n.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * The viewport for a canvas of `width` x `height` with `panelWidth` covered on
 * the right. The tree is anchored to the TOP of the free area, never centred
 * vertically: the root row belongs next to the toolbar. If the whole tree only
 * fits below MIN_READABLE_ZOOM, the root tier (people, roles, anchors) is
 * fitted instead, at readable size, centred on `focusId` when it is wider than
 * the free area.
 */
export function computeOrgViewport(
  nodes: OrgLayoutNode[],
  width: number,
  height: number,
  panelWidth: number,
  focusId: string | null,
): { x: number; y: number; zoom: number; whole: boolean } | null {
  const all = boundsOf(nodes);
  if (!all || width <= 0 || height <= 0) return null;
  const freeW = Math.max(120, width - panelWidth - FIT_PAD * 2);
  const freeH = Math.max(120, height - FIT_PAD * 2);
  let zoom = Math.min(1, freeW / all.w, freeH / all.h);
  let target = all;
  let whole = true;
  if (zoom < MIN_READABLE_ZOOM) {
    const roots = boundsOf(nodes.filter((n) => ROOT_KINDS.has(n.kind))) ?? all;
    target = roots;
    whole = false;
    zoom = Math.max(MIN_READABLE_ZOOM, Math.min(1, freeW / roots.w));
  }
  const tw = target.w * zoom;
  let x: number;
  if (tw <= freeW) {
    x = FIT_PAD + (freeW - tw) / 2 - target.x * zoom;
  } else {
    // Wider than the free area: start from the left edge so as many roots as
    // possible show (the viewer sorts first), unless the focus node would then
    // be off screen, in which case bring it into view at the left.
    const focus = focusId ? nodes.find((n) => n.id === focusId) : undefined;
    const startX = focus && (focus.x + focus.w) * zoom > freeW ? focus.x : target.x;
    x = FIT_PAD - startX * zoom;
  }
  const y = FIT_PAD - target.y * zoom;
  return { x, y, zoom, whole };
}

const DRAGGABLE = new Set(["session", "role"]);
const DROP_TARGETS = new Set(["person", "role"]);

function titleOf(n: OrgLayoutNode): string {
  switch (n.kind) {
    case "person": return n.person.name;
    case "role": return n.role.name;
    case "anchor": return n.anchor.name;
    case "session": return n.session.title || n.session.short_id;
    case "cluster": return `+${n.remaining} sessions`;
  }
}

function toFlowNodes(layout: OrgLayoutNode[], selectedId: string | null, dropTargetId: string | null, draggingId: string | null, loading: ReadonlySet<string>, handlers: {
  onToggleCollapse: (id: string) => void; onExpandCluster: (id: string) => void; onCollapseCluster: (id: string) => void;
}): Node[] {
  return layout.map((n) => {
    const base = {
      id: n.id,
      type: n.kind,
      position: { x: n.x, y: n.y },
      width: n.w,
      height: n.h,
      draggable: DRAGGABLE.has(n.kind),
      selectable: true,
      connectable: false,
      zIndex: n.id === draggingId ? 1000 : n.kind === "session" || n.kind === "cluster" ? 1 : 2,
    };
    const common = { selected: n.id === selectedId, dropTarget: n.id === dropTargetId, dragging: n.id === draggingId, ...handlers };
    switch (n.kind) {
      case "person": return { ...base, data: { ...common, person: n.person, collapsed: n.collapsed, hidden: n.hidden, overflow: n.overflow } };
      case "role": return { ...base, data: { ...common, role: n.role, collapsed: n.collapsed, hidden: n.hidden, overflow: n.overflow } };
      case "anchor": return { ...base, data: { ...common, anchor: n.anchor } };
      case "session": return { ...base, data: { ...common, session: n.session, parent: n.parent } };
      case "cluster": {
        const parentId = n.id.slice("cluster:".length);
        return { ...base, data: { ...common, parent: n.parent, parentId, remaining: n.remaining, loaded: n.loaded, total: n.total, counts: n.counts, fullyLoaded: n.fullyLoaded, loadingCluster: loading.has(parentId) } };
      }
    }
  });
}

/** Root cards fully outside the free canvas on each side, for the edge cues. */
export function hiddenRoots(nodes: OrgLayoutNode[], vp: Viewport, freeW: number): { left: OrgLayoutNode[]; right: OrgLayoutNode[] } {
  const roots = nodes.filter((n) => n.y === 0);
  const left: OrgLayoutNode[] = [];
  const right: OrgLayoutNode[] = [];
  for (const n of roots) {
    const x0 = n.x * vp.zoom + vp.x;
    const x1 = (n.x + n.w) * vp.zoom + vp.x;
    if (x1 <= 0) left.push(n);
    else if (x0 >= freeW) right.push(n);
  }
  left.sort((a, b) => b.x - a.x);
  right.sort((a, b) => a.x - b.x);
  return { left, right };
}

function OrgGraphInner(props: OrgGraphProps) {
  const { tree, view, selectedId, loadingClusters, showMiniMap, onSelect, onToggleCollapse, onExpandCluster, onCollapseCluster, onReparentRequest, onNodeContextMenu, onOpenSession, resetKey, panelWidth = 0 } = props;
  const { theme } = useTheme();
  const rf = useReactFlow();

  const layout = useMemo(() => layoutOrgTree(tree, view), [tree, view]);
  const byId = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);

  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const handlers = useMemo(() => ({ onToggleCollapse, onExpandCluster, onCollapseCluster }), [onToggleCollapse, onExpandCluster, onCollapseCluster]);
  const flowNodes = useMemo(
    () => toFlowNodes(layout.nodes, selectedId, dropTargetId, draggingId, loadingClusters, handlers),
    [layout, selectedId, dropTargetId, draggingId, loadingClusters, handlers],
  );
  const flowEdges = useMemo<Edge[]>(
    () => layout.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: e.kind === "stack" ? "straight" : "smoothstep",
      selectable: false,
      focusable: false,
      style: e.kind === "stack"
        ? { stroke: "color-mix(in srgb, var(--sol-border) 45%, transparent)", strokeWidth: 1.25, strokeDasharray: "3 4" }
        : { stroke: "color-mix(in srgb, var(--sol-border) 70%, transparent)", strokeWidth: 1.5 },
      pathOptions: e.kind === "stack" ? undefined : { borderRadius: 14 },
    } as Edge)),
    [layout],
  );

  // Controlled nodes so a drag moves the card; every layout change re-seeds.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>(flowNodes);
  const [edges, setEdges] = useEdgesState<Edge>(flowEdges);
  useWatchEffect(() => { setNodes(flowNodes); }, [flowNodes, setNodes, resetKey]);
  useWatchEffect(() => { setEdges(flowEdges); }, [flowEdges, setEdges]);

  // Fit to the FREE canvas (left of the panel), top anchored, readable zoom
  // floor (computeOrgViewport). Runs once nodes are measured, again when the
  // root row changes (a person joins, a top level role is added), and on
  // every panel open/close. A container resize refits only until the user
  // pans or zooms; a panel change always refits.
  // The layout carries every card's size, so the fit never waits on React
  // Flow's own measurement (which a hidden tab never delivers).
  const wrapRef = useRef<HTMLDivElement>(null);
  const userMoved = useRef(false);
  const rootSig = layout.nodes.filter((n) => n.y === 0).map((n) => n.id).join("|");
  const fitted = useRef<string | null>(null);
  const focusId = useMemo(() => layout.nodes.find((n) => n.kind === "person" && n.person.is_me)?.id ?? null, [layout]);
  // Which root cards sit past the free canvas' edges: drives the fades and the
  // "+N more" pills. A programmatic setViewport does not fire the viewport
  // change hook, so fit and pan compute the cue from their TARGET viewport;
  // the hook covers the user's own pans and zooms.
  const [edgeCue, setEdgeCue] = useState<{ left: OrgLayoutNode[]; right: OrgLayoutNode[] }>({ left: [], right: [] });
  const recomputeCue = useCallback((vp: Viewport) => {
    const el = wrapRef.current;
    if (!el) return;
    const cue = hiddenRoots(layout.nodes, vp, el.clientWidth - panelWidth);
    setEdgeCue(cue);
  }, [layout, panelWidth]);
  useOnViewportChange({ onChange: recomputeCue, onEnd: recomputeCue });
  const fit = useCallback((animate: boolean): boolean => {
    const el = wrapRef.current;
    if (!el || el.clientWidth === 0) return false;
    const vp = computeOrgViewport(layout.nodes, el.clientWidth, el.clientHeight, panelWidth, focusId);
    if (!vp) return false;
    // Animated viewport moves ride frame timers, which a hidden tab never gets.
    rf.setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom }, { duration: animate && !document.hidden ? 280 : 0 });
    recomputeCue({ x: vp.x, y: vp.y, zoom: vp.zoom });
    return true;
  }, [layout, panelWidth, focusId, rf, recomputeCue]);
  const panTo = useCallback((n: OrgLayoutNode, side: "left" | "right") => {
    const el = wrapRef.current;
    if (!el) return;
    const vp = rf.getViewport();
    const freeW = el.clientWidth - panelWidth;
    // Shift just enough that the hidden card lands fully inside the free area.
    const delta = side === "right"
      ? (n.x + n.w) * vp.zoom + vp.x - (freeW - FIT_PAD)
      : n.x * vp.zoom + vp.x - FIT_PAD;
    userMoved.current = true;
    const next = { ...vp, x: vp.x - delta };
    rf.setViewport(next, { duration: document.hidden ? 0 : 280 });
    recomputeCue(next);
  }, [rf, panelWidth, recomputeCue]);
  // Synchronous on purpose: a fit deferred to requestAnimationFrame is lost
  // when the effect re-runs before the frame (fit changes identity on every
  // tree push) or when the tab is hidden (no frames at all), and a key stamped
  // ahead of the fit would then block every retry.
  // rf.viewportInitialized: setViewport is a no-op until the pane's zoom
  // controller is attached, so a fit before that would stamp the key and
  // leave the tree at the identity transform.
  const viewportReady = rf.viewportInitialized;
  useWatchEffect(() => {
    if (!viewportReady || layout.nodes.length === 0) return;
    const key = `${rootSig}|${panelWidth}`;
    if (fitted.current === key) return;
    const first = fitted.current === null;
    if (!first) userMoved.current = false;
    if (fit(!first)) fitted.current = key;
  }, [viewportReady, rootSig, panelWidth, layout.nodes.length, fit]);
  useWatchEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (!userMoved.current && viewportReady) fit(false); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, viewportReady]);

  // Escape clears the selection unless the user is typing somewhere.
  useEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    if (selectedId) onSelect(null);
  });

  const findDropTarget = useCallback((node: Node): OrgLayoutNode | null => {
    const hits = rf.getIntersectingNodes(node).filter((n) => DROP_TARGETS.has(n.type ?? "") && n.id !== node.id);
    if (hits.length === 0) return null;
    // A role dropped on its own subtree is not a move.
    const subject = byId.get(node.id);
    const candidates = hits.filter((h) => {
      const ref = parentRefOfNodeId(h.id);
      if (!ref) return false;
      if (subject?.kind === "session") return !sameParent(subject.parent, ref);
      if (subject?.kind === "role") {
        if (ref.kind === "role" && ref.role_id === subject.role._id) return false;
        return !sameParent(subject.role.reports_to, ref);
      }
      return true;
    });
    if (candidates.length === 0) return null;
    // Prefer the one whose centre is nearest the dragged card's centre.
    const cx = node.position.x + (node.measured?.width ?? node.width ?? 0) / 2;
    const cy = node.position.y + (node.measured?.height ?? node.height ?? 0) / 2;
    candidates.sort((a, b) => {
      const da = Math.hypot(a.position.x + (a.width ?? 0) / 2 - cx, a.position.y + (a.height ?? 0) / 2 - cy);
      const db = Math.hypot(b.position.x + (b.width ?? 0) / 2 - cx, b.position.y + (b.height ?? 0) / 2 - cy);
      return da - db;
    });
    return byId.get(candidates[0].id) ?? null;
  }, [rf, byId]);

  const onNodeDragStart: OnNodeDrag = useCallback((_e, node) => { setDraggingId(node.id); }, []);
  const onNodeDrag: OnNodeDrag = useCallback((_e, node) => {
    const t = findDropTarget(node);
    setDropTargetId(t?.id ?? null);
  }, [findDropTarget]);
  const onNodeDragStop: OnNodeDrag = useCallback((e, node) => {
    const target = findDropTarget(node);
    setDropTargetId(null);
    setDraggingId(null);
    const subject = byId.get(node.id);
    if (!target || !subject || (subject.kind !== "session" && subject.kind !== "role")) {
      // No target: snap back to the layout position.
      setNodes(flowNodes);
      return;
    }
    const ref = parentRefOfNodeId(target.id)!;
    const me = e as unknown as { clientX: number; clientY: number };
    onReparentRequest({
      subject: subject.kind === "session"
        ? { kind: "session", id: subject.session._id, title: subject.session.title || subject.session.short_id }
        : { kind: "role", id: subject.role._id, title: subject.role.name },
      target: ref,
      targetTitle: titleOf(target),
      at: { x: me.clientX, y: me.clientY },
    });
  }, [findDropTarget, byId, onReparentRequest, setNodes, flowNodes]);

  const onNodeClick: NodeMouseHandler = useCallback((_e, node) => {
    if (node.type === "cluster") return;
    onSelect(node.id === selectedId ? null : node.id);
  }, [onSelect, selectedId]);
  const onNodeDoubleClick: NodeMouseHandler = useCallback((_e, node) => {
    const n = byId.get(node.id);
    if (n?.kind === "session") onOpenSession?.(n.session._id);
    else if (n && (n.kind === "person" || n.kind === "role")) onToggleCollapse(n.id);
  }, [byId, onOpenSession, onToggleCollapse]);
  const onContext: NodeMouseHandler = useCallback((e, node) => {
    const n = byId.get(node.id);
    if (n) onNodeContextMenu(e, n);
  }, [byId, onNodeContextMenu]);

  return (
    <div ref={wrapRef} className="relative w-full h-full">
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={ORG_NODE_TYPES}
      onNodesChange={onNodesChange}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={onNodeDoubleClick}
      onNodeContextMenu={onContext}
      onPaneClick={() => onSelect(null)}
      onMoveStart={(event) => { if (event) userMoved.current = true; }}
      onNodeDragStart={onNodeDragStart}
      onNodeDrag={onNodeDrag}
      onNodeDragStop={onNodeDragStop}
      colorMode={theme === "dark" ? "dark" : "light"}
      nodesConnectable={false}
      elementsSelectable
      selectNodesOnDrag={false}
      panOnScroll
      zoomOnDoubleClick={false}
      minZoom={0.25}
      maxZoom={1.75}
      proOptions={{ hideAttribution: true }}
      className="org-flow"
      style={{ background: "transparent" }}
    >
      <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="color-mix(in srgb, var(--sol-border) 40%, transparent)" />
      <Controls showInteractive={false} position="bottom-left" className="!shadow-none !border !rounded-lg overflow-hidden" style={{ borderColor: "color-mix(in srgb, var(--sol-border) 40%, transparent)" }} />
      {showMiniMap && (
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          nodeStrokeWidth={0}
          nodeColor={(n) => n.type === "person" ? "var(--sol-cyan)" : n.type === "role" ? "var(--sol-violet)" : n.type === "anchor" ? "var(--sol-orange)" : "color-mix(in srgb, var(--sol-border) 60%, transparent)"}
          maskColor="color-mix(in srgb, var(--sol-bg) 70%, transparent)"
          style={{ background: "var(--sol-bg-alt)", border: "1px solid color-mix(in srgb, var(--sol-border) 40%, transparent)", borderRadius: 10 }}
        />
      )}
    </ReactFlow>
    <EdgeCue side="left" hidden={edgeCue.left} onPan={panTo} offset={0} />
    <EdgeCue side="right" hidden={edgeCue.right} onPan={panTo} offset={panelWidth} />
    </div>
  );
}

/** A soft fade at one edge of the canvas plus a pill that pans the next hidden
 *  root card into view. Nothing when every root is on screen. */
function EdgeCue({ side, hidden, onPan, offset }: { side: "left" | "right"; hidden: OrgLayoutNode[]; onPan: (n: OrgLayoutNode, side: "left" | "right") => void; offset: number }) {
  if (hidden.length === 0) return null;
  const people = hidden.filter((n) => n.kind === "person").length;
  const label = people === hidden.length
    ? `${hidden.length} more ${hidden.length === 1 ? "person" : "people"}`
    : `${hidden.length} more`;
  const Icon = side === "right" ? ChevronRight : ChevronLeft;
  return (
    <>
      <div
        aria-hidden
        className="pointer-events-none absolute top-0 bottom-0 w-20 z-10"
        style={{
          [side]: offset,
          background: `linear-gradient(to ${side === "right" ? "right" : "left"}, transparent, color-mix(in srgb, var(--sol-bg) 85%, transparent))`,
        }}
      />
      <button
        type="button"
        onClick={() => onPan(hidden[0], side)}
        className="absolute top-3 z-10 inline-flex items-center gap-1 h-7 pl-2.5 pr-2 rounded-full border text-[11.5px] font-medium transition-colors hover:bg-sol-bg-highlight backdrop-blur"
        style={{
          [side]: offset + 12,
          background: "color-mix(in srgb, var(--sol-card) 92%, transparent)",
          borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)",
          color: "var(--sol-text-muted)",
        }}
        title={`Pan to ${hidden[0].kind === "person" ? (hidden[0] as any).person.name : "the next card"}`}
      >
        {side === "left" && <Icon className="w-3.5 h-3.5" />}
        <span>{label}</span>
        {side === "right" && <Icon className="w-3.5 h-3.5" />}
      </button>
    </>
  );
}

export function OrgGraph(props: OrgGraphProps) {
  return (
    <ReactFlowProvider>
      <OrgGraphInner {...props} />
    </ReactFlowProvider>
  );
}
