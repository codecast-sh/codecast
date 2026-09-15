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
import { ghostNodeIdFor, ghostsFor, layoutOrgTree, parentRefOfNodeId, type OrgGhostOptions, type OrgGhostPlan, type OrgLayoutNode, type OrgLayoutView } from "./orgLayout";
import { AnchorCard, ClusterCard, PersonCard, RoleCard, SessionCard } from "./OrgNodeCards";
import { computeOrgViewport, FIT_PAD, hiddenRoots } from "./orgViewport";
import { sameParent, type OrgParentRef, type OrgTree } from "./orgTypes";
import { changeLine, GHOST, healthFlagsByNode } from "./orgMeta";
import type { OrgHealth, OrgProposalChange } from "./orgStaffingTypes";
import { EditChangeForm } from "./StaffingPane";
import { orgRoleReparentMakesCycle } from "../../store/orgSlice";

const ORG_NODE_TYPES = { person: PersonCard, role: RoleCard, anchor: AnchorCard, session: SessionCard, cluster: ClusterCard };

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
  /** Which cards may be picked up. A card the page would refuse on drop is
   *  not draggable at all, so nothing ever snaps back silently. */
  canDrag?: (node: OrgLayoutNode) => boolean;
  // Staffing (org-staffing.md S5): the open proposal's changes are drawn into
  // the tree as ghosts; org.health's flags as dots on the nodes.
  changes?: readonly OrgProposalChange[];
  health?: OrgHealth | null;
  /** The session the viewer is looking from, for an adopt ghost's "this session". */
  viewerSession?: OrgGhostOptions["viewerSession"];
  /** The change the chart is focused on (the orgFocusChangeId scalar): the
   *  canvas pans to its ghost and the card shows its action row. */
  focusChangeId?: string | null;
  onFocusChange?: (changeId: string | null) => void;
  onDecideChange?: (changeId: string, verdict: "accept" | "skip", edits?: Record<string, unknown>) => void;
  /** Edit on a role change opens the hire dialog prefilled (the page owns
   *  it); every other kind gets the inline form here on the canvas. */
  onEditRoleChange?: (change: OrgProposalChange) => void;
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

type GhostHandlers = {
  focusChangeId: string | null;
  onFocusChange: (changeId: string) => void;
  onDecideChange: (changeId: string, verdict: "accept" | "skip") => void;
  onEditChange: (changeId: string, at: { x: number; y: number }) => void;
};

/** A stable key for the flags on the chart: node, code and severity of each,
 *  so the cards re-render on a flag change and never on a spend counter. */
function flagsSigOf(flags: Record<string, OrgHealth["roles"][number]["flags"]>): string {
  return Object.keys(flags).sort().map((id) => `${id}:${flags[id].map((f) => `${f.code}/${f.severity}`).join(",")}`).join("|");
}

function toFlowNodes(layout: OrgLayoutNode[], selectedId: string | null, dropTargetId: string | null, draggingId: string | null, loading: ReadonlySet<string>, handlers: {
  onToggleCollapse: (id: string) => void; onExpandCluster: (id: string) => void; onCollapseCluster: (id: string) => void;
}, canDrag: ((node: OrgLayoutNode) => boolean) | undefined, ghosts: GhostHandlers, flags: Record<string, OrgHealth["roles"][number]["flags"]>): Node[] {
  return layout.map((n) => {
    // A ghost stub is not a card the page can move: nothing to reparent yet.
    const stub = n.kind === "person" || n.kind === "role" || n.kind === "session" ? n.ghost : undefined;
    const base = {
      id: n.id,
      type: n.kind,
      position: { x: n.x, y: n.y },
      width: n.w,
      height: n.h,
      draggable: !stub && DRAGGABLE.has(n.kind) && (canDrag ? canDrag(n) : true),
      selectable: true,
      connectable: false,
      zIndex: n.id === draggingId ? 1000 : n.kind === "session" || n.kind === "cluster" ? 1 : 2,
    };
    const common = { selected: n.id === selectedId, dropTarget: n.id === dropTargetId, dragging: n.id === draggingId, ...handlers, flags: flags[n.id] };
    const decor = n.kind === "person" || n.kind === "role" || n.kind === "session"
      ? (n.ghost || n.retire || n.move || n.chips ? { ghost: n.ghost, retire: n.retire, move: n.move, chips: n.chips, ...ghosts } : {})
      : {};
    switch (n.kind) {
      case "person": return { ...base, data: { ...common, ...decor, person: n.person, collapsed: n.collapsed, hidden: n.hidden, overflow: n.overflow } };
      case "role": return { ...base, data: { ...common, ...decor, role: n.role, collapsed: n.collapsed, hidden: n.hidden, overflow: n.overflow } };
      case "anchor": return { ...base, data: { ...common, anchor: n.anchor } };
      case "session": return { ...base, data: { ...common, ...decor, session: n.session, parent: n.parent } };
      case "cluster": {
        const parentId = n.id.slice("cluster:".length);
        return { ...base, data: { ...common, parent: n.parent, parentId, remaining: n.remaining, loaded: n.loaded, total: n.total, counts: n.counts, fullyLoaded: n.fullyLoaded, loadingCluster: loading.has(parentId) } };
      }
    }
  });
}

function OrgGraphInner(props: OrgGraphProps) {
  const { tree, view, selectedId, loadingClusters, showMiniMap, onSelect, onToggleCollapse, onExpandCluster, onCollapseCluster, onReparentRequest, onNodeContextMenu, onOpenSession, resetKey, panelWidth = 0, panelHeight = 0, canDrag, changes, health, viewerSession, focusChangeId = null, focusNodeId: focusNodeProp = null, onFocusChange, onDecideChange, onEditRoleChange } = props;
  const { theme } = useTheme();
  const rf = useReactFlow();

  // Ghosts merge into the tree before layout (org-staffing.md S5), so a
  // proposed role takes a real slot under its proposed parent.
  const ghosts = useMemo<OrgGhostPlan | undefined>(
    () => (changes?.length ? ghostsFor(tree, changes, { viewerSession }) : undefined),
    [tree, changes, viewerSession?.id, viewerSession?.short_id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const layout = useMemo(() => layoutOrgTree(tree, view, ghosts), [tree, view, ghosts]);
  const byId = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
  // Flags reach the cards by identity, so they are rebuilt only when a flag
  // changes (the signature), not on every health push (spend counters move).
  const flagsSig = useMemo(() => flagsSigOf(healthFlagsByNode(health)), [health]);
  const flagsByNode = useMemo(() => healthFlagsByNode(health), [flagsSig]); // eslint-disable-line react-hooks/exhaustive-deps

  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // The inline edit form for a non-role change, at the Edit click.
  const [editing, setEditing] = useState<{ change: OrgProposalChange; at: { x: number; y: number } } | null>(null);

  const handlers = useMemo(() => ({ onToggleCollapse, onExpandCluster, onCollapseCluster }), [onToggleCollapse, onExpandCluster, onCollapseCluster]);
  const changeById = useMemo(() => new Map((changes ?? []).map((c) => [c._id, c])), [changes]);
  const ghostHandlers = useMemo<GhostHandlers>(() => ({
    focusChangeId,
    onFocusChange: (id) => onFocusChange?.(id),
    onDecideChange: (id, verdict) => { setEditing(null); onDecideChange?.(id, verdict); },
    onEditChange: (id, at) => {
      const c = changeById.get(id);
      if (!c) return;
      onFocusChange?.(id);
      if (c.change.kind === "role") onEditRoleChange?.(c);
      else setEditing({ change: c, at });
    },
  }), [focusChangeId, onFocusChange, onDecideChange, onEditRoleChange, changeById]);
  const flowNodes = useMemo(
    () => toFlowNodes(layout.nodes, selectedId, dropTargetId, draggingId, loadingClusters, handlers, canDrag, ghostHandlers, flagsByNode),
    [layout, selectedId, dropTargetId, draggingId, loadingClusters, handlers, canDrag, ghostHandlers, flagsByNode],
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
        : e.kind === "ghost"
          // A proposal's edge: the page's violet, dashed, at the ghost's opacity.
          ? { stroke: GHOST.color, strokeWidth: 1.5, strokeDasharray: "6 4", opacity: GHOST.opacity }
          : { stroke: "color-mix(in srgb, var(--sol-border) 70%, transparent)", strokeWidth: 1.5, opacity: e.faded ? 0.3 : 1 },
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
    const vp = computeOrgViewport(layout.nodes, el.clientWidth, el.clientHeight, panelWidth, focusId, null, panelHeight);
    if (!vp) return false;
    // Animated viewport moves ride frame timers, which a hidden tab never gets.
    rf.setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom }, { duration: animate && !document.hidden ? 280 : 0 });
    recomputeCue({ x: vp.x, y: vp.y, zoom: vp.zoom });
    return true;
  }, [layout, panelWidth, panelHeight, focusId, rf, recomputeCue]);
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
  // The focused change (a change row click in the pane, a ghost click here)
  // or the node the pane asked for (a flag row): computed here because the
  // fit below stands down while one is set, and the focus pan re-centres on
  // a panel change instead. Without that, the first ghost click with the
  // pane closed was panned to, then refit over as the panel opened.
  const focusNodeId = useMemo(() => ghostNodeIdFor(ghosts, focusChangeId) ?? focusNodeProp, [ghosts, focusChangeId, focusNodeProp]);
  useWatchEffect(() => {
    if (!viewportReady || layout.nodes.length === 0) return;
    const key = `${rootSig}|${panelWidth}|${panelHeight}`;
    if (fitted.current === key) return;
    const first = fitted.current === null;
    if (!first && focusNodeId) { fitted.current = key; return; }
    if (!first) userMoved.current = false;
    if (fit(!first)) fitted.current = key;
  }, [viewportReady, rootSig, panelWidth, panelHeight, layout.nodes.length, fit, focusNodeId]);
  useWatchEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => { if (!userMoved.current && viewportReady) fit(false); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fit, viewportReady]);

  // The focus target pans to the centre of the free canvas (left of the
  // panel, above the phone sheet) at the current zoom, and again when the
  // panel opens or closes around it. A programmatic move, so the cue
  // recomputes from the target viewport.
  useWatchEffect(() => {
    const el = wrapRef.current;
    if (!focusNodeId || !el || !viewportReady) return;
    const vp = computeOrgViewport(layout.nodes, el.clientWidth, el.clientHeight, panelWidth, focusId, { id: focusNodeId, zoom: rf.getViewport().zoom }, panelHeight);
    if (!vp) return;
    userMoved.current = true;
    rf.setViewport({ x: vp.x, y: vp.y, zoom: vp.zoom }, { duration: document.hidden ? 0 : 280 });
    recomputeCue({ x: vp.x, y: vp.y, zoom: vp.zoom });
  }, [focusNodeId, viewportReady, panelWidth, panelHeight]);

  // Escape clears the selection unless the user is typing somewhere.
  useEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    if (editing) { setEditing(null); return; }
    if (selectedId) onSelect(null);
  });

  const findDropTarget = useCallback((node: Node): OrgLayoutNode | null => {
    // A ghost stub has the type of a role but is a change, not a seat: a drop
    // on it would confirm a move to a change id, so it never lights up.
    const isStub = (id: string) => { const n = byId.get(id); return !!n && (n.kind === "person" || n.kind === "role" || n.kind === "session") && !!n.ghost; };
    const hits = rf.getIntersectingNodes(node).filter((n) => DROP_TARGETS.has(n.type ?? "") && n.id !== node.id && !isStub(n.id));
    if (hits.length === 0) return null;
    // A role dropped on its own subtree is not a move.
    const subject = byId.get(node.id);
    const candidates = hits.filter((h) => {
      const ref = parentRefOfNodeId(h.id);
      if (!ref) return false;
      if (subject?.kind === "session") return !sameParent(subject.parent, ref);
      if (subject?.kind === "role") {
        if (ref.kind === "role" && ref.role_id === subject.role._id) return false;
        // Its own descendant would close a loop: the server refuses it, so the
        // halo must not offer it.
        if (orgRoleReparentMakesCycle(tree, subject.role._id, ref)) return false;
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
  }, [rf, byId, tree]);

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
    // A ghost stub is a change, not a node the page holds: a click focuses the
    // change (the pane opens on its rationale) instead of selecting.
    const n = byId.get(node.id);
    const stub = n && (n.kind === "person" || n.kind === "role" || n.kind === "session") ? n.ghost : undefined;
    if (stub) { onFocusChange?.(stub.change_id === focusChangeId ? null : stub.change_id); return; }
    onSelect(node.id === selectedId ? null : node.id);
  }, [onSelect, selectedId, byId, onFocusChange, focusChangeId]);
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
    {editing && (
      <EditChangePopover
        change={editing.change}
        at={editing.at}
        wrap={wrapRef.current}
        onCancel={() => setEditing(null)}
        onAccept={(edits) => { setEditing(null); onDecideChange?.(editing.change._id, "accept", edits); }}
      />
    )}
    </div>
  );
}

/** The inline edit for a non-role change (org-staffing.md S5), floated next
 *  to the Edit click and kept inside the canvas. The pane's own form. */
function EditChangePopover({ change, at, wrap, onCancel, onAccept }: { change: OrgProposalChange; at: { x: number; y: number }; wrap: HTMLDivElement | null; onCancel: () => void; onAccept: (edits: Record<string, unknown>) => void }) {
  const W = 300;
  const box = wrap?.getBoundingClientRect() ?? { left: 0, top: 0, width: W + 32, height: 600 };
  const left = Math.max(8, Math.min(at.x - box.left - W / 2, box.width - W - 8));
  const top = Math.max(8, Math.min(at.y - box.top + 12, box.height - 260));
  return (
    <div
      className="absolute z-30 rounded-xl border shadow-xl org-pop-in"
      style={{ left, top, width: W, background: "var(--sol-card)", borderColor: "color-mix(in srgb, var(--sol-violet) 45%, transparent)" }}
      data-edit-popover={change._id}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="px-3 pt-2.5 pb-1 text-[12px] font-medium leading-snug" style={{ color: "var(--sol-text)" }}>{changeLine(change.change)}</div>
      <EditChangeForm change={change} onCancel={onCancel} onAccept={onAccept} />
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
