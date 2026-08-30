// Stage-split gestures and the pane drag protocol.
//
// The store owns the tree (stageInsertLeaf & co.); this module is the layer
// components talk to — it pairs each store op with its URL side (the address
// bar mirrors the focused pane) and speaks one drag vocabulary for every
// source: a tab, a session card, a list row, a sidebar item, a pane strip.
// Native HTML5 drag, matching the app's existing drags (`codecast/session-id`
// on session cards, kanban's column type): any element becomes a source by
// calling startPaneDrag in its onDragStart, and the stage's drop layer
// understands it with no further wiring.

import { useInboxStore, type AppTab } from "../store/inboxStore";
import {
  countLeaves,
  leavesOf,
  type DropZone,
  type SplitEdge,
  type StageNode,
} from "../store/stageSplit";
import { tabNavigate } from "../src/compat/tabRouting";
import { isNonTabRoute } from "./tabRoutes";
import { pathLabel, tabNeedsUrlRestore } from "./pathLabel";
import { isDetachedTabWindow } from "./desktop";

// ---------------------------------------------------------------------------
// Drag protocol
// ---------------------------------------------------------------------------

/** JSON payload: { path, title?, from? }. */
export const PANE_DRAG_TYPE = "codecast/pane";
/** The session cards' existing type; a bare session id. */
export const SESSION_DRAG_TYPE = "codecast/session-id";

export type PaneDragSource =
  | { kind: "tab"; tabId: string }
  | { kind: "leaf"; leafId: string };

export type PaneDragPayload = {
  /** The route the drop opens. Must be a shell tab route. */
  path: string;
  title?: string;
  /** Where the pane came from, when the drop is a MOVE rather than a copy. */
  from?: PaneDragSource;
};

// dataTransfer contents are unreadable during dragover (only types are), so
// the live payload also rides module state for the preview's benefit. Cleared
// on dragend; a drag from another window simply has no module copy.
let liveDrag: PaneDragPayload | null = null;

export function startPaneDrag(e: React.DragEvent | DragEvent, payload: PaneDragPayload) {
  const dt = "dataTransfer" in e ? e.dataTransfer : null;
  if (!dt) return;
  dt.setData(PANE_DRAG_TYPE, JSON.stringify(payload));
  dt.effectAllowed = "copyMove";
  liveDrag = payload;
  const clear = () => {
    liveDrag = null;
    window.removeEventListener("dragend", clear);
    window.removeEventListener("drop", clear);
  };
  window.addEventListener("dragend", clear);
  window.addEventListener("drop", clear);
}

/** The in-flight payload, when the drag started in this window. */
export function activePaneDrag(): PaneDragPayload | null {
  return liveDrag;
}

/** Is this drag something the stage can host? Checked from `types` alone, so
 *  it works during dragover when data is sealed. */
export function dragCarriesPane(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return dt.types.includes(PANE_DRAG_TYPE) || dt.types.includes(SESSION_DRAG_TYPE);
}

/** Decode a drop. A bare session drag becomes its conversation route. */
export function readPaneDrop(dt: DataTransfer): PaneDragPayload | null {
  const raw = dt.getData(PANE_DRAG_TYPE);
  if (raw) {
    try {
      const p = JSON.parse(raw) as PaneDragPayload;
      if (p && typeof p.path === "string" && p.path.startsWith("/")) return p;
    } catch {
      // fall through to the session spelling
    }
  }
  const sid = dt.getData(SESSION_DRAG_TYPE);
  if (sid) return { path: sessionPanePath(sid) };
  return null;
}

/** The route a session renders at inside a pane. The pane renderer intercepts
 *  this spelling (no redirect fires); a tab that collapses onto it converts to
 *  /inbox?s= (see stageCloseLeaf). */
export function sessionPanePath(sessionId: string): string {
  return `/conversation/${sessionId}`;
}

export function paneSessionId(path: string): string | null {
  const m = path.split("?")[0].match(/^\/conversation\/([^/#]+)$/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Gestures
// ---------------------------------------------------------------------------

function activeTab(): AppTab | null {
  const st = useInboxStore.getState();
  return st.tabs.find((t) => t.id === st.activeTabId) ?? null;
}

/** Mirror the focused pane into the address bar after a stage op. Replace,
 *  never push — focusing or closing a pane is arrangement, not navigation.
 *  Stands down when the live URL is the tab's content in the other spelling
 *  (the inbox's /conversation canonicalization; see tabNeedsUrlRestore). */
function syncUrl() {
  if (typeof window === "undefined" || isDetachedTabWindow()) return;
  const tab = activeTab();
  if (!tab) return;
  const live = window.location.pathname + window.location.search;
  if (tab.path === live) return;
  if (isNonTabRoute(window.location.pathname)) return;
  if (!tabNeedsUrlRestore(window.location.pathname, tab.path)) return;
  window.history.replaceState({ tabNav: true, tabId: tab.id }, "", tab.path);
}

export function stageFocus(leafId: string) {
  useInboxStore.getState().stageFocusLeaf(leafId);
  syncUrl();
}

export function stageClose(leafId: string) {
  useInboxStore.getState().stageCloseLeaf(leafId);
  syncUrl();
}

/** The pane takes the whole stage (its route becomes the tab). */
export function stageExpand(leafId: string) {
  useInboxStore.getState().stageExpandLeaf(leafId);
  syncUrl();
}

/** Pane-local navigation: the focused pane navigates like the tab (history,
 *  recents); an unfocused pane just re-points its own leaf. */
export function stageNavigateLeaf(leafId: string, path: string, mode: "push" | "replace") {
  const tab = activeTab();
  if (!tab) return;
  if (tab.focusedLeafId === leafId) {
    tabNavigate(path, mode);
  } else {
    useInboxStore.getState().stageSetLeafPath(leafId, path);
  }
}

/** Pop a pane out into its own top-level tab. */
export function stageMoveLeafToTab(leafId: string) {
  const st = useInboxStore.getState();
  const tab = activeTab();
  const leaf = tab?.layout && leavesOf(tab.layout).find((l) => l.id === leafId);
  if (!leaf) return;
  st.stageCloseLeaf(leafId);
  st.openTab({ path: leaf.path, title: pathLabel(leaf.path), makeActive: true });
  syncUrl();
}

/**
 * Execute a drop on the stage. One entry point for every source:
 *  - center: that pane opens the path (a move also dissolves its source)
 *  - edge/root: a new pane splits in; a dragged-in TAB dissolves (move),
 *    unless it IS the active tab — dragging your own tab in duplicates the
 *    view, which is the honest reading of that gesture.
 * A path already on stage is focused instead of duplicated.
 */
export function performStageDrop(zone: DropZone, payload: PaneDragPayload): boolean {
  const st = useInboxStore.getState();
  const tab = activeTab();
  if (!tab || isNonTabRoute(payload.path)) return false;
  const from = payload.from;

  if (zone.kind === "center") {
    const isSelf = from?.kind === "leaf" && from.leafId === zone.leafId;
    if (isSelf) return false;
    if (from?.kind === "leaf") st.stageCloseLeaf(from.leafId);
    if (tab.layout) {
      st.stageFocusLeaf(zone.leafId);
      st.stageSetLeafPath(zone.leafId, payload.path);
      if (from?.kind === "tab" && from.tabId !== st.activeTabId) st.closeTab(from.tabId);
      syncUrl();
    } else {
      // A plain tab's center drop is ordinary navigation.
      if (from?.kind === "tab" && from.tabId !== st.activeTabId) st.closeTab(from.tabId);
      tabNavigate(payload.path, "push");
    }
    return true;
  }

  // A pane already showing this path: focus it rather than doubling it —
  // unless this drop is a MOVE of that very pane (a rearrange).
  if (tab.layout && (!from || from.kind === "tab")) {
    const existing = leavesOf(tab.layout).find((l) => l.path === payload.path);
    if (existing) {
      st.stageFocusLeaf(existing.id);
      if (from?.kind === "tab" && from.tabId !== st.activeTabId) st.closeTab(from.tabId);
      syncUrl();
      return true;
    }
  }

  if (from?.kind === "leaf") {
    if (zone.kind === "edge" && zone.leafId === from.leafId) return false;
    st.stageCloseLeaf(from.leafId);
  }
  const leafId = st.stageInsertLeaf(
    zone.kind === "root" ? "root" : { leafId: zone.leafId },
    zone.edge,
    payload.path,
  );
  if (!leafId) return false;
  if (from?.kind === "tab" && from.tabId !== st.activeTabId) st.closeTab(from.tabId);
  syncUrl();
  return true;
}

/**
 * Open a route BESIDE what's on stage — the programmatic sibling of a drop
 * (the Files affordance, a thread's "open beside"). Splits along the stage's
 * right edge; a pane already showing the path is focused instead. False when
 * the stage can't host another pane (narrow screen, cap) — callers navigate
 * instead.
 */
export function openBeside(path: string): boolean {
  if (typeof window === "undefined" || window.innerWidth < 900 || isDetachedTabWindow()) return false;
  const st = useInboxStore.getState();
  const tab = activeTab();
  if (!tab || isNonTabRoute(path)) return false;
  if (tab.layout) {
    const existing = leavesOf(tab.layout).find((l) => l.path === path);
    if (existing) {
      st.stageFocusLeaf(existing.id);
      syncUrl();
      return true;
    }
  }
  const leafId = st.stageInsertLeaf("root", "right", path);
  if (!leafId) return false;
  syncUrl();
  return true;
}

/** The layout to render for a tab: its tree when it really is a split. */
export function tabStageLayout(tab: Pick<AppTab, "layout">): StageNode | null {
  return tab.layout && countLeaves(tab.layout) > 1 ? tab.layout : null;
}

export type { DropZone, SplitEdge };
