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
  useNodesInitialized,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeMouseHandler,
  type OnNodeDrag,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
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
};

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
      case "person": return { ...base, data: { ...common, person: n.person, collapsed: n.collapsed, hidden: n.hidden } };
      case "role": return { ...base, data: { ...common, role: n.role, collapsed: n.collapsed, hidden: n.hidden } };
      case "anchor": return { ...base, data: { ...common, anchor: n.anchor } };
      case "session": return { ...base, data: { ...common, session: n.session, parent: n.parent } };
      case "cluster": {
        const parentId = n.id.slice("cluster:".length);
        return { ...base, data: { ...common, parent: n.parent, parentId, remaining: n.remaining, loaded: n.loaded, total: n.total, counts: n.counts, fullyLoaded: n.fullyLoaded, loadingCluster: loading.has(parentId) } };
      }
    }
  });
}

function OrgGraphInner(props: OrgGraphProps) {
  const { tree, view, selectedId, loadingClusters, showMiniMap, onSelect, onToggleCollapse, onExpandCluster, onCollapseCluster, onReparentRequest, onNodeContextMenu, onOpenSession, resetKey } = props;
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

  // Fit once the first layout is measured, and again when the root count
  // changes (a person joins, a role is added at the top level). Waiting for
  // useNodesInitialized matters: fitView before measurement fits nothing.
  const initialized = useNodesInitialized();
  const rootSig = layout.nodes.filter((n) => n.y === 0).map((n) => n.id).join("|");
  const fitted = useRef<string | null>(null);
  useWatchEffect(() => {
    if (!initialized || fitted.current === rootSig || layout.nodes.length === 0) return;
    const first = fitted.current === null;
    fitted.current = rootSig;
    const raf = requestAnimationFrame(() => rf.fitView({ padding: 0.1, duration: first ? 0 : 300, maxZoom: 1 }));
    return () => cancelAnimationFrame(raf);
  }, [initialized, rootSig, layout.nodes.length, rf]);

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
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={ORG_NODE_TYPES}
      onNodesChange={onNodesChange}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={onNodeDoubleClick}
      onNodeContextMenu={onContext}
      onPaneClick={() => onSelect(null)}
      onNodeDragStart={onNodeDragStart}
      onNodeDrag={onNodeDrag}
      onNodeDragStop={onNodeDragStop}
      colorMode={theme === "dark" ? "dark" : "light"}
      nodesConnectable={false}
      elementsSelectable
      selectNodesOnDrag={false}
      panOnScroll
      zoomOnDoubleClick={false}
      minZoom={0.15}
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
  );
}

export function OrgGraph(props: OrgGraphProps) {
  return (
    <ReactFlowProvider>
      <OrgGraphInner {...props} />
    </ReactFlowProvider>
  );
}
