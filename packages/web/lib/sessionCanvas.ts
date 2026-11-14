// The session canvas: one stage pane per tab that keeps a session's published
// page open beside the conversation and follows it as the agent republishes.
// It is an ordinary stage leaf under a named id (canvasLeafId), opened
// unfocused, so what the person is reading never moves.

import { useInboxStore, type AppTab, type ClientUI } from "../store/inboxStore";
import { findLeaf } from "../store/stageSplit";
import { browserRoutePath } from "./browserPane";
import { pageFrameSrc } from "./publishedPageUrls";
import { stageHasRoom } from "./stage";

export type CanvasState = NonNullable<ClientUI["session_canvas"]>;
export type CanvasPage = { slug: string; created_at: number };
export type CanvasPageInfo = { version?: number; missing?: true; gateKeys: string };

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
 *  remounts the frame on a republish; `i` signs the viewer in to the page. */
export function canvasPageUrl(slug: string, version: number | undefined, gateKeys: string, identity?: string | null): string {
  const query = `${version != null ? `r=v${version}` : ""}${gateKeys}`.replace(/^&/, "");
  return `${pageFrameSrc(slug)}${query ? `?${query}` : ""}${identity ? `#i=${identity}` : ""}`;
}

export function canvasPanePath(url: string, conversationId: string): string {
  return browserRoutePath({ kind: "url", url, session: conversationId });
}

export type CanvasStep = "insert" | "set" | "close" | "none";

/** What the stage should do for the session in view: dock its page, re-point
 *  the pane, or take another session's page away. */
export function planCanvas({ on, leafPath, wantPath }: { on: boolean; leafPath: string | null; wantPath: string | null }): CanvasStep {
  if (!on) return leafPath ? "close" : "none";
  if (!wantPath) return "none";
  if (!leafPath) return "insert";
  return leafPath === wantPath ? "none" : "set";
}

function activeTab(): AppTab | null {
  const st = useInboxStore.getState();
  return st.tabs.find((t) => t.id === st.activeTabId) ?? null;
}

export function canvasLeafPath(tab: Pick<AppTab, "id" | "layout"> | null = activeTab()): string | null {
  if (!tab?.layout) return null;
  return findLeaf(tab.layout, canvasLeafId(tab.id))?.path ?? null;
}

/** Carry one step out on the active tab's stage. False when there was no room. */
export function applyCanvasStep(step: CanvasStep, path: string | null): boolean {
  const tab = activeTab();
  if (!tab || step === "none") return true;
  const st = useInboxStore.getState();
  const id = canvasLeafId(tab.id);
  if (step === "close") st.stageCloseLeaf(id);
  else if (step === "set" && path) st.stageSetLeafPath(id, path);
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
