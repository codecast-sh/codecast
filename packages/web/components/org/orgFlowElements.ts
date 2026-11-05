// The org canvas's React Flow elements (OrgGraph.tsx): the people chart's
// nodes, the goals map's nodes and edges, and the health map's edges. Pure.
import type { Node, Edge } from "@xyflow/react";
import { ORG_SIZES, type OrgLayoutEdge, type OrgLayoutNode } from "./orgLayout";
import type { OrgHealth } from "./orgStaffingTypes";
import type { FlowEdgeData, FlowSendData } from "./OrgFlowEdges";
import type { FlowMap } from "./orgFlow";
import { goalFocusedChange, goalsAnchor, type GoalsLayout, type GoalsNode } from "./goalsLayout";
import type { GoalsEdgeData } from "./GoalsNodeCards";

/** The health map's card size, which its spine edges are drawn against. */
const SPINE = { w: ORG_SIZES.healthRole.w, h: ORG_SIZES.healthRole.h };

export const DRAGGABLE = new Set(["session", "role", "person"]);

export type GhostHandlers = {
  focusChangeId: string | null;
  onFocusChange: (changeId: string) => void;
};

/** Cards to keep lit while the rest dim: a drag's targets (dashed) or a find's matches (`current` ringed). */
export type Emphasis = { lit: ReadonlySet<string>; dashed: boolean; current?: string };

/** A card an edge cue counts: a root of the people chart, or an owner of the goals map. */
export type CueCard = OrgLayoutNode | GoalsNode;

export function toFlowNodes(layout: OrgLayoutNode[], selectedId: string | null, marked: ReadonlySet<string>, emphasis: Emphasis | null, dropTargetId: string | null, draggingId: string | null, loading: ReadonlySet<string>, handlers: {
  onToggleCollapse: (id: string) => void; onExpandCluster: (id: string) => void; onCollapseCluster: (id: string) => void; onToggleOpen?: (id: string) => void;
}, canDrag: ((node: OrgLayoutNode) => boolean) | undefined, arrange: boolean, ghosts: GhostHandlers, flags: Record<string, OrgHealth["roles"][number]["flags"]>, ledgers: Record<string, OrgHealth["roles"][number]["ledger"]>): Node[] {
  return layout.map((n) => {
    // A ghost stub is not a card the page can move: nothing to reparent yet.
    const stub = n.kind === "person" || n.kind === "role" || n.kind === "session" ? n.ghost : undefined;
    const base = {
      id: n.id,
      type: n.kind,
      position: { x: n.x, y: n.y },
      width: n.w,
      height: n.h,
      // On a chart the person arranges, every card can be placed; elsewhere only
      // a card they may move to a new parent picks up.
      draggable: !stub && n.kind !== "cluster" && (arrange || (DRAGGABLE.has(n.kind) && (canDrag ? canDrag(n) : true))),
      selectable: true,
      // React Flow drags every selected node together: the marked cards are the selection.
      selected: marked.has(n.id),
      connectable: false,
      zIndex: n.id === draggingId ? 1000 : n.kind === "session" || n.kind === "cluster" ? 1 : 2,
      // A drag in progress (the cards it may land on wear a dashed ring; the
      // rest stay, since a drop on open canvas places the card) or a find (the
      // matches stay lit and the rest step back).
      ...(emphasis ? { style: emphasis.lit.has(n.id)
        ? emphasis.dashed ? { outline: "2px dashed color-mix(in srgb, var(--sol-cyan) 70%, transparent)", outlineOffset: 5, borderRadius: 14, transition: "opacity 150ms" } : { transition: "opacity 150ms" }
        : emphasis.dashed || n.id === draggingId || marked.has(n.id) ? undefined : { opacity: 0.3, transition: "opacity 150ms" } } : {}),
    };
    // The change in focus lights the card that carries it (its stub, its retire or move, one of its chips), the way a click would.
    const carries = !!ghosts.focusChangeId && (n.kind === "person" || n.kind === "role" || n.kind === "session") && (n.ghost?.change_id === ghosts.focusChangeId || n.retire?.change_id === ghosts.focusChangeId || n.move?.change_id === ghosts.focusChangeId || !!n.chips?.some((c) => c.change_id === ghosts.focusChangeId));
    const common = { selected: n.id === selectedId || marked.has(n.id) || n.id === emphasis?.current || carries, dropTarget: n.id === dropTargetId, dragging: n.id === draggingId, ...handlers, flags: flags[n.id] };
    const decor = n.kind === "person" || n.kind === "role" || n.kind === "session"
      ? (n.ghost || n.retire || n.move || n.chips ? { ghost: n.ghost, retire: n.retire, move: n.move, chips: n.chips, ...ghosts } : {})
      : {};
    switch (n.kind) {
      case "person": return { ...base, data: { ...common, ...decor, person: n.person, collapsed: n.collapsed, hidden: n.hidden, overflow: n.overflow } };
      case "role": return { ...base, data: { ...common, ...decor, role: n.role, collapsed: n.collapsed, hidden: n.hidden, overflow: n.overflow, tenure: n.tenure, ledger: ledgers[n.id], opened: n.opened, open: n.open } };
      case "session": return { ...base, data: { ...common, ...decor, session: n.session, parent: n.parent, detail: n.detail, opened: n.opened } };
      case "group": return { ...base, data: { selected: common.selected, label: n.label, count: n.count } };
      // The product layer draws with the goals map's own cards; the mission is a goal card or the company card.
      case "goal": case "project": return { ...base, data: { ...n.data, selected: common.selected } };
      case "mission": return { ...base, type: n.data.card === "goal" ? "goal" : "company", data: { ...n.data, selected: common.selected } };
      case "cluster": {
        const parentId = n.id.slice("cluster:".length);
        return { ...base, data: { ...common, parent: n.parent, parentId, remaining: n.remaining, loaded: n.loaded, total: n.total, counts: n.counts, fullyLoaded: n.fullyLoaded, loadingCluster: loading.has(parentId) } };
      }
    }
    return { ...base, data: {} };
  });
}

/** The goals outline as React Flow nodes: nothing drags, a card carries its
 *  own ghost. Under the Projects filter the goal cards step back. */
export function goalsFlowNodes(goals: GoalsLayout, selectedId: string | null, ghosts: GhostHandlers, dimGoals = false, movable = false, dropTargetId: string | null = null): Node[] {
  return goals.nodes.map((n) => {
    // The card carrying the change in focus is lit the way a selected one is, and rises over the tight row beneath it.
    // A new goal's own project rows share its change: the goal is lit, not every row; a row an initiative_projects change added is lit on its own.
    const f = ghosts.focusChangeId;
    const focused = !!f && (n.kind === "goal" ? !!goalFocusedChange(f, n.goal.ghost, n.goal.chips)
      : n.kind === "project" ? n.project.ghost?.kind === "initiative_projects" && !!goalFocusedChange(f, n.project.ghost)
      : n.kind === "owner" ? n.ghost?.change_id === f || n.retire?.change_id === f || n.move?.change_id === f || !!n.chips?.some((c) => c.change_id === f)
      : false);
    const dim = dimGoals && (n.kind === "goal" || n.kind === "company") && n.id !== selectedId;
    const base = { id: n.id, type: n.kind, position: { x: n.x, y: n.y }, width: n.w, height: n.h, draggable: false, selectable: true, connectable: false, zIndex: focused ? 10 : 2, ...(dim ? { style: { opacity: 0.45 } } : {}) };
    const selected = n.id === selectedId || focused;
    // A live role's card can be picked up and dropped on whoever it should report to.
    const draggable = movable && n.kind === "owner" && n.owner.kind === "role" && !n.ghost;
    switch (n.kind) {
      case "company": return { ...base, data: { selected, name: n.name, goals: n.goals, projects: n.projects, mission: n.mission } };
      case "loose": return { ...base, data: { selected, projects: n.projects } };
      case "goal": return { ...base, data: { selected, goal: n.goal, metrics: n.metrics, rows: n.rows, refs: n.refs, running: n.running, mission: n.mission, root: n.root, hasChildren: n.hasChildren, ...ghosts } };
      case "project": return { ...base, data: { selected, project: n.project, counts: n.counts, ...ghosts } };
      case "owner": return { ...base, draggable, data: { selected, dropTarget: n.id === dropTargetId, owner: n.owner, owns: n.owns, line: n.line, counts: n.counts, reportsTo: n.reportsTo, ghost: n.ghost, retire: n.retire, move: n.move, was: n.was, chips: n.chips, ...ghosts } };
    }
  });
}

/** The goals lens' edges: every spine, and the owner edges of one card (the
 *  one under the pointer, else the selected one). Each goal wears its owner's
 *  face, so the resting chart draws no line across the canvas; pointing at a
 *  goal shows its owner, pointing at an owner shows everything it owns. */
export function goalsFlowEdges(goals: GoalsLayout, litId: string | null): Edge[] {
  const box = new Map(goals.nodes.map((n) => [n.id, { x: n.x, y: n.y, w: n.w, h: n.h, a: goalsAnchor(n) }]));
  return goals.edges
    .filter((e) => e.kind === "spine" || e.source === litId || e.target === litId)
    .map((e) => {
      const data: GoalsEdgeData = { s: box.get(e.source)!, t: box.get(e.target)!, ghost: e.ghost, faded: e.faded, ...(e.kind === "owner" ? { lane: goals.ownerLane } : {}) };
      return { id: e.id, source: e.source, target: e.target, type: e.kind === "spine" ? "goalSpine" : "goalOwner", selectable: false, focusable: false, zIndex: e.kind === "owner" ? 1 : 0, data } as Edge;
    });
}

/** The health map's edges: a reporting edge into a role carries what reached
 *  it this week, every other tree edge stays a thin line, and each handoff
 *  between roles is its own curve, laned when a pair has more than one. */
export function flowModeEdges(edges: OrgLayoutEdge[], map: FlowMap, focus: string | null): Edge[] {
  const columns = edges.some((e) => e.spine);
  const lit = (a: string, b: string) => !focus || a === focus || b === focus;
  const out: Edge[] = edges.filter((e) => e.kind !== "ghost").map((e) => {
    const w = e.kind === "tree" ? map.into[e.target] : undefined;
    if (w) {
      const data: FlowEdgeData = { n: w.n, max: map.max, hot: w.atLimit, dim: !lit(e.source, e.target), focus: !!focus && e.target === focus, ...(e.spine ? { spine: SPINE } : {}) };
      return { id: e.id, source: e.source, target: e.target, type: "flow", selectable: false, focusable: false, data } as Edge;
    }
    if (e.spine) {
      const data: FlowEdgeData = { n: 0, max: map.max, hot: false, dim: !lit(e.source, e.target), focus: false, spine: SPINE };
      return { id: e.id, source: e.source, target: e.target, type: "flow", selectable: false, focusable: false, data } as Edge;
    }
    return { id: e.id, source: e.source, target: e.target, type: "smoothstep", selectable: false, focusable: false, style: { stroke: "color-mix(in srgb, var(--sol-border) 60%, transparent)", strokeWidth: 1.25, opacity: lit(e.source, e.target) ? 0.8 : 0.2 }, pathOptions: { borderRadius: 14 } } as Edge;
  });
  const lanes = new Map<string, number>();
  for (const s of map.sends) {
    const pair = [s.source, s.target].sort().join("|");
    const lane = lanes.get(pair) ?? 0;
    lanes.set(pair, lane + 1);
    const data: FlowSendData = { n: s.n, max: map.max, dim: !lit(s.source, s.target), focus: !!focus && (s.source === focus || s.target === focus), lane, ...(columns ? { spine: SPINE } : {}) };
    out.push({ id: s.id, source: s.source, target: s.target, type: "flowSend", selectable: false, focusable: false, zIndex: 1, data } as Edge);
  }
  return out;
}
