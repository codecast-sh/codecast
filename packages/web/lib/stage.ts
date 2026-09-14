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
  besideLeafId,
  countLeaves,
  findLeaf,
  MAX_STAGE_LEAVES,
  leavesOf,
  seedLeafId,
  type DropZone,
  type SplitEdge,
  type StageNode,
} from "../store/stageSplit";
import { tabNavigate } from "../src/compat/tabRouting";
import { isNonTabRoute } from "./tabRoutes";
import { inboxTabSessionId, pathLabel, tabNeedsUrlRestore } from "./pathLabel";
import { borrowsTabShell } from "./desktop";
import { browserRoutePath, hasPaneHost, postToPaneHost, type BrowserSource } from "./browserPane";
import { registerSplitOpener } from "./openIntent";
import { rememberBrowserPaneUrl } from "./browserPaneRecents";

// Dynamic on purpose: the tips module drags analytics into any import graph
// that touches it, and this module sits under TabContent (every tab pays for
// its imports). A milestone is fire-and-forget; async is fine.
function firstSplitMilestone() {
  void import("../tips/useTips").then((m) => m.checkMilestone("m-first-split")).catch(() => {});
}

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
  // Warm the split renderer's lazy chunk while the drag is still in the air,
  // so the first drop doesn't blank the stage waiting for it.
  void import("../components/stage/StageSplitView").catch(() => {});
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

/** The spelling a route takes as a pane. A session link may arrive in the
 *  tab deep-link form (/inbox?s=<id>); a pane shows the conversation itself,
 *  not an inbox around it, so it takes the /conversation form the pane
 *  renderer intercepts. Every other route is itself. */
export function panePath(path: string): string {
  const sid = inboxTabSessionId(path);
  return sid ? sessionPanePath(sid) : path;
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
  if (typeof window === "undefined" || !window.location || borrowsTabShell()) return;
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
  // Re-sync the address bar BEFORE opening the tab: openTab stamps the
  // source tab from window.location, which still shows the popped pane's
  // path — stamping that stale URL would write the popped content back over
  // the surviving pane. (openTab itself converts the /conversation spelling.)
  syncUrl();
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
    if (tab.layout) {
      // Point the target FIRST, then dissolve a moved source. The other order
      // is a trap: closing the source can collapse the layout to a single
      // pane, and every stage op after that no-ops — the source vanished but
      // the target never navigated.
      st.stageFocusLeaf(zone.leafId);
      st.stageSetLeafPath(zone.leafId, payload.path);
      if (from?.kind === "leaf") st.stageCloseLeaf(from.leafId);
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
    // A rearrange is ONE atomic tree move (stageMoveLeaf): closing first and
    // re-inserting passed a 2-pane split through the plain-tab collapse,
    // which respelled the stationary pane's path and remounted everything.
    if (zone.kind === "edge" && zone.leafId === from.leafId) return false;
    st.stageMoveLeaf(from.leafId, zone.kind === "root" ? "root" : { leafId: zone.leafId }, zone.edge);
    syncUrl();
    return true;
  }
  const leafId = st.stageInsertLeaf(
    zone.kind === "root" ? "root" : { leafId: zone.leafId },
    zone.edge,
    payload.path,
  );
  if (!leafId) return false;
  if (from?.kind === "tab" && from.tabId !== st.activeTabId) st.closeTab(from.tabId);
  syncUrl();
  firstSplitMilestone();
  return true;
}

/**
 * A navigation from OUTSIDE the stage (a sidebar section, a rail session
 * card) while the stage is split: rather than guessing a pane, hand the
 * choice to the user — the stage overlays its cells (StagePickLayer, the
 * same visual language as the drop preview) and the click picks the
 * destination. Returns false when there's nothing to choose (no split,
 * narrow screen, bad path) — the caller navigates normally.
 */
export function requestStagePlacement(path: string, title?: string): boolean {
  if (typeof window === "undefined" || window.innerWidth < 900 || borrowsTabShell()) return false;
  const tab = activeTab();
  if (!tab || !tabStageLayout(tab) || isNonTabRoute(path)) return false;
  useInboxStore.getState().setStagePick({ path, title });
  return true;
}

/** Resolve a pending placement into a pane (or a fresh tab). */
export function placeStagePick(target: { leafId: string } | "newTab") {
  const st = useInboxStore.getState();
  const pick = st.stagePick;
  st.setStagePick(null);
  if (!pick) return;
  if (target === "newTab") {
    st.saveCurrentTabState();
    st.openTab({ path: pick.path, title: pick.title ?? pathLabel(pick.path), makeActive: true });
    return;
  }
  // Same rule as a drop: a pane already showing this path is focused rather
  // than doubled — unless that pane is the one the user pointed at.
  const tab = activeTab();
  const existing = tab?.layout
    ? leavesOf(tab.layout).find((l) => l.path === pick.path && l.id !== target.leafId)
    : null;
  st.stageFocusLeaf(existing ? existing.id : target.leafId);
  // The focused pane's navigation is the tab's navigation (history, recents).
  tabNavigate(pick.path, "push");
}

/**
 * Open a route BESIDE what's on stage — the programmatic sibling of a drop
 * (the Files affordance, a thread's "open beside"). Splits along the stage's
 * right edge; a pane already showing the path is focused instead. False when
 * the stage can't host another pane (narrow screen, cap) — callers navigate
 * instead.
 */
export function openBeside(path: string, opts?: { reuse?: boolean }): boolean {
  if (!isNonTabRoute(path) && postToPaneHost({ type: "codecast:open-beside", path })) return true;
  if (!canOpenBeside()) return false;
  const st = useInboxStore.getState();
  const tab = activeTab();
  if (!tab || isNonTabRoute(path)) return false;
  if (opts?.reuse) return openBesideReused(tab, path);
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
  firstSplitMilestone();
  return true;
}

/**
 * The Option-click form of "beside": ONE stable target pane per tab, and
 * what is on stage does not move. The first gesture opens the target pane
 * (besideLeafId) beside the stage; every later one re-points that same pane.
 * The pane opens UNFOCUSED, so the focused leaf, `tab.path` and the URL stay
 * exactly as they were: the page the reader clicked in neither re-renders
 * for a focus change nor sees its address rewritten. A path already on
 * stage is left where it is — nothing to open, nothing to move.
 */
function openBesideReused(tab: AppTab, path: string): boolean {
  const st = useInboxStore.getState();
  const targetId = besideLeafId(tab.id);
  const target = findLeaf(tab.layout, targetId);
  if (target) {
    if (target.path !== path) {
      st.stageSetLeafPath(targetId, path);
      // Re-pointing the focused pane moves `tab.path`; mirror it (a no-op
      // when the target is unfocused, the ordinary case).
      syncUrl();
    }
    return true;
  }
  if (leavesOf(tab.layout).some((l) => l.path === path)) return true;
  const leafId = st.stageInsertLeaf("root", "right", path, { id: targetId, focus: false });
  if (!leafId) return false;
  firstSplitMilestone();
  return true;
}

/**
 * Open a web page as a pane: the one entry point every browser-pane gesture
 * goes through (a URL pill, a preview affordance, an agent's tab).
 *
 * Beside by default, because a page is something you look at NEXT TO your
 * work. Returns what openBeside returns — true when the page opened as a
 * second pane, false when the stage could not take one (a narrow window, the
 * four-pane cap) and the tab navigated to it instead, which is the honest
 * fallback: the page still opens, just not beside.
 *
 * `beside: "only"` removes that fallback: no pane, no navigation, false. It
 * exists for gestures NOBODY CLICKED — an agent's pane offer opening itself
 * under a preference. Navigating there would move what the reader is looking
 * at without them asking, which is the move store/viewNav.ts refuses for
 * every other machine-initiated change of view.
 */
export function openBrowserPane(
  source: BrowserSource,
  opts?: { beside?: boolean | "only"; native?: boolean },
): boolean {
  // A pane's page has no stage; the window framing it places the pane. Only a
  // gesture somebody made: that window runs its own unattended offers.
  if (opts?.beside === "only" && hasPaneHost()) return false;
  // `native` rides the path, so that gesture goes up as the path below rather
  // than as a source the message would strip it from.
  if (opts?.beside !== false && !opts?.native && postToPaneHost({ type: "codecast:open-pane", source })) {
    return true;
  }
  const path = browserRoutePath(source, { native: opts?.native });
  // Every gesture funnels through here, so this is the one place that knows
  // what a person actually opened — which is what a blank pane offers back.
  if (source.kind === "url") rememberBrowserPaneUrl(source.url);
  if (opts?.beside === false) {
    tabNavigate(path, "push");
    return false;
  }
  if (openBeside(path)) return true;
  if (opts?.beside === "only") return false;
  tabNavigate(path, "push");
  return false;
}

/** True when this window's stage may take another pane at all: wide enough
 *  to show two, and a real tab shell (a detached window has none). A pane's
 *  page answers yes: its gestures go to the window framing it. The pane cap
 *  and the route's eligibility are openBeside's own answer. */
export function canOpenBeside(): boolean {
  if (hasPaneHost()) return true;
  return typeof window !== "undefined" && window.innerWidth >= 900 && !borrowsTabShell();
}

/**
 * True when the stage would really take another pane right now: wide enough,
 * a real tab shell, AND under the four-pane cap.
 *
 * canOpenBeside answers the first two only, which is enough for a gesture that
 * can fall back to navigating. It is NOT enough for one that must stay silent
 * when there is no room: a full stage passes the width test, so a caller
 * reading width alone believes it has a pane coming and acts as if it did.
 */
export function stageHasRoom(): boolean {
  if (!canOpenBeside()) return false;
  const tab = activeTab();
  if (!tab) return false;
  return countLeaves(tab.layout) < MAX_STAGE_LEAVES;
}

/** The layout to render for a tab: its tree when it really is a split. */
export function tabStageLayout(tab: Pick<AppTab, "layout">): StageNode | null {
  return tab.layout && countLeaves(tab.layout) > 1 ? tab.layout : null;
}

/**
 * What the stage renders for a tab, ALWAYS as a tree: a plain tab is a single
 * leaf under the seed id the first split will keep (stageInsertLeaf), so the
 * split changes that cell's rect and nothing else — the page in it is never
 * remounted, never reloaded, and keeps its scroll. A narrow stage renders the
 * focused leaf alone, under its own id, so widening again keeps that cell too.
 */
export function stageRenderLayout(tab: Pick<AppTab, "id" | "path" | "layout" | "focusedLeafId">, narrow: boolean): StageNode {
  const split = tabStageLayout(tab);
  if (!split) return { type: "leaf", id: seedLeafId(tab.id), path: tab.path };
  if (!narrow) return split;
  const focused = (tab.focusedLeafId && findLeaf(split, tab.focusedLeafId)) || leavesOf(split)[0];
  return focused;
}

export type { DropZone, SplitEdge };

// The "open beside" target (lib/openIntent) is served from here so the store
// side never imports the stage; see registerSplitOpener.
// `reuse`: one stable target pane per tab, re-pointed by each Option-click,
// opened unfocused so the page clicked in does not move (openBesideReused).
registerSplitOpener((path) => openBeside(panePath(path), { reuse: true }));
