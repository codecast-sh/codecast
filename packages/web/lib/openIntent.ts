// Modifier clicks on in-app objects — the browser's tab gestures, applied to
// the app's own tab strip and to detached windows. DESKTOP ONLY: on the web the
// browser keeps its own Cmd-click (a real browser tab), by decision; the shell
// has no browser tabs, so the app's tab strip and OS windows take that role.
//
//   Cmd/Ctrl-click, middle-click   → new in-app tab, opened in the BACKGROUND
//                                    and mounted hidden so it is warm on switch
//   Cmd/Ctrl-Shift-click           → detached OS window
//
// Object links reach navigation through a handful of chokepoints, not through
// their hundreds of call sites: anchors rendered by the `Link` shim, the
// `useRouter().push` shim, and the store's session actions (navigateToSession
// and friends). So instead of teaching every row about modifiers, a window
// CAPTURE listener records the modifiers of the click being dispatched right
// now, and each chokepoint asks `divertNavigation(path)` — "was this click a
// Cmd-click? then open the path over there and tell me to stand down". Anchors
// are resolved in the capture listener itself, because their path is on the
// element and the browser's own default (open in a new browser window, which
// the desktop shell forwards to the system browser) must be stopped.
//
// The intent lives exactly as long as the click's synchronous dispatch: it is
// consumed by the first navigation that claims it, and cleared on the next
// macrotask no matter what. A handler that navigates twice (navigateToSession
// then router.push("/inbox")) opens ONE tab: the second call sees the intent
// already consumed and is swallowed, so nothing moves in the current view.

import { useInboxStore } from "../store/inboxStore";
import { bridge, isDesktop, isDetachedTabWindow } from "./desktop";
import { pathLabel, conversationTabPath, inboxTabSessionId } from "./pathLabel";
import { isNonTabRoute, shouldUseTabRouting } from "../src/compat/tabRouting";

export type OpenTarget = "tab" | "window";

type Intent =
  | { kind: "none" }
  // A modified click is being dispatched; nothing has claimed it yet.
  | { kind: "pending"; target: OpenTarget }
  // A navigation already opened the target; later ones stand down.
  | { kind: "consumed" };

let intent: Intent = { kind: "none" };
let clearTimer: ReturnType<typeof setTimeout> | null = null;

/** Where a click with these modifiers wants to open, or null for a plain click. */
export function openTargetForClick(e: {
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  button?: number;
}): OpenTarget | null {
  if (e.altKey) return null;
  if (e.button === 1) return "tab";
  if (e.button !== undefined && e.button !== 0) return null;
  if (!(e.metaKey || e.ctrlKey)) return null;
  return e.shiftKey ? "window" : "tab";
}

/** Arm the intent for the click being dispatched now. Cleared on the next
 *  macrotask — after React's synchronous handlers and any effects it flushes
 *  for a discrete event have run. */
export function beginClickIntent(target: OpenTarget): void {
  intent = { kind: "pending", target };
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = setTimeout(endClickIntent, 0);
}

export function endClickIntent(): void {
  intent = { kind: "none" };
  if (clearTimer) { clearTimeout(clearTimer); clearTimer = null; }
}

/** The armed target, if this click is a modified click nobody has claimed. */
export function pendingOpenTarget(): OpenTarget | null {
  return intent.kind === "pending" ? intent.target : null;
}

/**
 * Called by a navigation chokepoint with the path it is about to open. Returns
 * true when the caller must NOT navigate: either this call claimed a pending
 * modified click (the path opens in a tab / window instead), or an earlier
 * call in the same click already did.
 *
 * `openable: false` marks a navigation that only canonicalizes the current URL
 * (router.replace) — it never claims the intent, but still stands down once
 * a sibling navigation has claimed it (its page never became current).
 */
export function divertNavigation(path: string, opts?: { openable?: boolean }): boolean {
  if (intent.kind === "consumed") return true;
  if (intent.kind !== "pending") return false;
  if (opts?.openable === false) return false;
  const target = intent.target;
  intent = { kind: "consumed" };
  openIn(target, path);
  return true;
}

/** Session chokepoints (navigateToSession & co) resolve their id to the path a
 *  session tab holds. Returns true when the caller must stand down. */
export function divertSessionOpen(sessionId: string, opts?: { messageId?: string | null }): boolean {
  if (intent.kind === "consumed") return true;
  if (intent.kind !== "pending") return false;
  // A detached window loads its URL for real, so a message target rides the
  // universal /conversation/<id>#msg-<id> form and lands on the message. A tab
  // pane can't (its route is the inbox), so it opens on the session's tail.
  const path = intent.target === "window" && opts?.messageId
    ? `/conversation/${sessionId}#msg-${opts.messageId}`
    : `/inbox?s=${sessionId}`;
  return divertNavigation(path);
}

// Tabs opened in the background this window lifetime, still unvisited. TabContent
// mounts these hidden (a background tab is otherwise a cold shell until first
// shown), and forgets one the moment it is switched to. Deliberately NOT
// persisted: tabs restored at boot must not all mount at once.
const prewarmTabIds: Set<string> = ((globalThis as any).__codecastPrewarmTabs ??= new Set());
export function isPrewarmTab(id: string): boolean { return prewarmTabIds.has(id); }
export function clearPrewarmTab(id: string): void { prewarmTabIds.delete(id); }

/** Open `path` in a background in-app tab, or in a detached window. */
export function openIn(target: OpenTarget, path: string): void {
  if (target === "tab" && shouldUseTabRouting(path)) {
    const tabPath = conversationTabPath(path);
    const store = useInboxStore.getState();
    // The intent may be claimed from inside a store action's draft (the
    // session chokepoints). A nested action there would commit against the
    // pre-action state and be overwritten when the outer action lands, so the
    // open runs on the microtask after it — before any paint either way.
    queueMicrotask(() => {
      const id = store.openTab({
        path: tabPath,
        title: pathLabel(tabPath),
        sessionId: inboxTabSessionId(tabPath) ?? undefined,
        makeActive: false,
      });
      if (id) prewarmTabIds.add(id);
    });
    return;
  }
  // A window: the desktop breakout. The browser's own new tab is the fallback
  // for an older shell without the verb, and for a Cmd-click with no tab shell
  // to open into (a detached window, a route outside the shell).
  const detach = bridge("detachTab");
  if (detach) { void detach(path); return; }
  window.open(path, "_blank");
}

/** Break a tab out into its own OS window: the window loads the tab's path and
 *  the tab leaves this strip — a move, not a copy (the last tab stays, since a
 *  window with no tab is unrenderable). False when the shell lacks the verb. */
export function detachTab(tab: { id: string; path: string }): boolean {
  const fn = bridge("detachTab");
  if (!fn) return false;
  void fn(tab.path);
  const state = useInboxStore.getState();
  if (state.tabs.length > 1) state.closeTab(tab.id);
  return true;
}

/** Pop the current view out (Cmd+N / File › New Window): the active tab in a
 *  windowed shell, or the page itself in a detached window, which has no strip. */
export function detachCurrentView(): boolean {
  if (isDetachedTabWindow()) {
    const fn = bridge("detachTab");
    if (!fn) return false;
    void fn(window.location.pathname + window.location.search + window.location.hash);
    return true;
  }
  const state = useInboxStore.getState();
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  return tab ? detachTab(tab) : false;
}

/** An anchor's href as an in-app path, or null when the browser should keep
 *  the click: external, hash-only, explicitly targeted, downloads. */
export function anchorAppPath(a: HTMLAnchorElement): string | null {
  const href = a.getAttribute("href");
  if (!href || href.startsWith("#") || href.startsWith("//")) return null;
  if (a.target && a.target !== "_self") return null;
  if (a.hasAttribute("download")) return null;
  if (href.startsWith("/")) return href;
  // Absolute URL on our own origin (entity links are sometimes rendered full).
  try {
    const u = new URL(href, window.location.href);
    if (u.origin !== window.location.origin) return null;
    return u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}

function onCaptureClick(e: MouseEvent): void {
  if (!isDesktop()) return;
  const target = openTargetForClick(e);
  if (!target) return;
  const el = e.target as Element | null;
  const a = el?.closest?.("a[href]") as HTMLAnchorElement | null;
  const path = a ? anchorAppPath(a) : null;
  if (a && !path) return; // the browser's link to keep (external, _blank…)
  beginClickIntent(target);
  if (!path) return; // a row/button: its handler's navigation claims the intent
  // Routes outside the shell (settings, marketing) have no tab to open into;
  // let the browser handle those the way it always did.
  if (target === "tab" && isNonTabRoute(path)) { endClickIntent(); return; }
  e.preventDefault();
  divertNavigation(path);
}

/** Install for the window (DashboardLayout mounts it). Reference-counted, so
 *  a second shell mount (HMR, a nested layout) never doubles the listener.
 *  Returns the uninstaller. */
let installs = 0;
export function installOpenIntent(): () => void {
  // Capture phase, on window: runs before React's root listener, so the
  // intent is armed before any handler and the browser default is stopped
  // before RRLink or the desktop shell can act on a modified anchor click.
  if (installs++ === 0) {
    window.addEventListener("click", onCaptureClick, true);
    window.addEventListener("auxclick", onCaptureClick, true);
  }
  return () => {
    if (--installs > 0) return;
    window.removeEventListener("click", onCaptureClick, true);
    window.removeEventListener("auxclick", onCaptureClick, true);
    endClickIntent();
  };
}
