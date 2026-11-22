// The session canvas: one stage pane per tab that keeps a session's published
// page open beside the conversation and follows it as the agent republishes.
// It is an ordinary stage leaf under a named id (canvasLeafId), opened
// unfocused, so what the person is reading never moves.

import { useInboxStore, type AppTab, type ClientUI } from "../store/inboxStore";
import { findLeaf } from "../store/stageSplit";
import { browserRoutePath, parseBrowserRoute } from "./browserPane";
import { pageFrameSrc } from "./publishedPageUrls";
import { stageHasRoom } from "./stage";

export type CanvasState = NonNullable<ClientUI["session_canvas"]>;
export type CanvasPage = { slug: string; created_at: number };
export type CanvasPageInfo = { version?: number; missing?: true };

// Old entries fall off so the map stays small; the newest ones are the
// sessions a person is still talking through.
export const CANVAS_STATE_CAP = 50;

export function canvasLeafId(tabId: string): string {
  return `sl_canvas_${tabId}`;
}

export function withCanvas(state: CanvasState | undefined, conversationId: string, pin: string | null, now = Date.now()): CanvasState {
  const next: CanvasState = { ...(state ?? {}), [conversationId]: { pin, at: now } };
  const keys = Object.keys(next);
  if (keys.length <= CANVAS_STATE_CAP) return next;
  keys.sort((a, b) => next[b].at - next[a].at);
  return Object.fromEntries(keys.slice(0, CANVAS_STATE_CAP).map((k) => [k, next[k]]));
}

export function withoutCanvas(state: CanvasState | undefined, conversationId: string): CanvasState {
  const { [conversationId]: _off, ...rest } = state ?? {};
  return rest;
}

/** The page the canvas shows: the pinned one while it exists, else the newest
 *  page that still exists. Null until the pages are known. */
export function canvasTarget(pages: CanvasPage[], pin: string | null, info: (slug: string) => CanvasPageInfo | undefined): string | null {
  const live = pages.filter((p) => !info(p.slug)?.missing);
  if (pin && live.some((p) => p.slug === pin)) return pin;
  let latest: CanvasPage | null = null;
  for (const p of live) if (!latest || p.created_at >= latest.created_at) latest = p;
  return latest?.slug ?? null;
}

/** The address the pane frames: the serving page with its own bar, so comments
 *  go where they go on the page itself. `r` changes with the version, which
 *  remounts the frame on a republish. It carries no token of any kind (gate
 *  keys, identity): the pane shows, copies and opens this address, so a gated
 *  page asks for its gate in the pane as it does anywhere else. */
export function canvasPageUrl(slug: string, version: number | undefined): string {
  return `${pageFrameSrc(slug)}${version != null ? `?r=v${version}` : ""}`;
}

export function canvasPanePath(url: string, conversationId: string): string {
  return browserRoutePath({ kind: "url", url, session: conversationId });
}

/** The session a canvas pane path was docked for; null when the pane no longer
 *  shows a published page (the person navigated it elsewhere). */
export function canvasPathSession(path: string): string | null {
  const source = parseBrowserRoute(path);
  if (source?.kind !== "url" || !source.url.startsWith(pageFrameSrc(""))) return null;
  return source.session ?? null;
}

export type CanvasStep = "insert" | "set" | "close" | "release" | "none";

/** What the stage should do for the conversation that owns the canvas.
 *  `pending`: its page is known but the page's version has not arrived.
 *  `docked`: the canvas has shown its page in this pane since it last came on. */
export function planCanvas({ on, conversationId, leafPath, wantPath, pending, docked }: {
  on: boolean;
  conversationId: string;
  leafPath: string | null;
  wantPath: string | null;
  pending: boolean;
  docked: boolean;
}): CanvasStep {
  const leafSession = leafPath ? canvasPathSession(leafPath) : null;
  // A pane the person pointed somewhere else is theirs now; turning the
  // canvas on again takes it back.
  if (leafPath && !leafSession) {
    if (!on) return "none";
    if (docked) return "release";
    return wantPath ? "set" : "none";
  }
  if (!on) return leafPath ? "close" : "none";
  if (wantPath) return !leafPath ? "insert" : leafPath === wantPath ? "none" : "set";
  if (!leafPath) return "none";
  return pending && leafSession === conversationId ? "none" : "close";
}

// Which conversation drives each tab's canvas: the one whose pane was last
// focused, or whose visible pane last changed to it (the inbox switching
// sessions). Two conversations on one stage never fight over the pane.
const owners = new Map<string, string>();
const ownerListeners = new Set<() => void>();

export function claimCanvas(tabId: string, conversationId: string) {
  if (owners.get(tabId) === conversationId) return;
  owners.set(tabId, conversationId);
  for (const l of ownerListeners) l();
}

export function canvasOwner(tabId: string): string | null {
  return owners.get(tabId) ?? null;
}

export function subscribeCanvasOwner(listener: () => void): () => void {
  ownerListeners.add(listener);
  return () => ownerListeners.delete(listener);
}

function activeTab(): AppTab | null {
  const st = useInboxStore.getState();
  return st.tabs.find((t) => t.id === st.activeTabId) ?? null;
}

export function canvasLeafPath(tab: Pick<AppTab, "id" | "layout"> | null = activeTab()): string | null {
  if (!tab?.layout) return null;
  return findLeaf(tab.layout, canvasLeafId(tab.id))?.path ?? null;
}

function tabById(tabId: string): AppTab | null {
  return useInboxStore.getState().tabs.find((t) => t.id === tabId) ?? null;
}

/** Carry one step out on the owner's tab, which must be the tab on screen
 *  (every stage op acts on the active tab). False when there was no room. */
export function applyCanvasStep(step: CanvasStep, path: string | null, owner: { tabId: string; conversationId: string; ownerLeafId?: string }): boolean {
  const st = useInboxStore.getState();
  if (step === "none" || step === "release" || st.activeTabId !== owner.tabId) return true;
  const id = canvasLeafId(owner.tabId);
  if (step === "close") {
    // A focused canvas leaves the tab's stored inbox address behind the view
    // (the inbox keeps `?s=` current only while it is focused), and the close
    // collapses the tab onto that address: point it at the session in view.
    const tab = tabById(owner.tabId);
    const ownerLeaf = owner.ownerLeafId && tab?.layout ? findLeaf(tab.layout, owner.ownerLeafId) : null;
    const inView = `/inbox?s=${owner.conversationId}`;
    if (ownerLeaf && ownerLeaf.path.split("?")[0] === "/inbox" && ownerLeaf.path !== inView) st.stageSetLeafPath(ownerLeaf.id, inView);
    st.stageCloseLeaf(id);
  } else if (step === "set" && path) st.stageSetLeafPath(id, path);
  else if (step === "insert" && path) {
    if (!stageHasRoom()) return false;
    return st.stageInsertLeaf("root", "right", path, { id, focus: false }) !== null;
  }
  return true;
}

export function setSessionCanvas(conversationId: string, on: boolean, pin: string | null = null) {
  const st = useInboxStore.getState();
  const current = st.clientState.ui?.session_canvas;
  st.updateClientUI({ session_canvas: on ? withCanvas(current, conversationId, pin) : withoutCanvas(current, conversationId) });
}

/** True while the person is working inside the docked page (typing a comment,
 *  reading a panel): a frame holding focus. Re-pointing then would reload the
 *  page under them and drop what they typed, so the update waits. */
export function canvasHasFocus(tabId: string | undefined, doc: Pick<Document, "activeElement"> | undefined = typeof document === "undefined" ? undefined : document): boolean {
  const el = doc?.activeElement as (Element & { closest?: (s: string) => Element | null }) | null | undefined;
  if (!tabId || !el || el.tagName !== "IFRAME" || !el.closest) return false;
  return !!el.closest(`[data-stage-leaf="${canvasLeafId(tabId)}"]`);
}
