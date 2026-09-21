// Which app windows (Chat, Work) exist, known to every window of this profile
// WITHOUT the shell.
//
// The shell knows its own app windows and says so in the window role, but
// the web ships ahead of the shell: on a build from before app windows the
// popout is a plain breakout the shell knows nothing about, and on any build
// a breakout can become the Chat window by showing chat (lib/desktopApps).
// So the fact lives here, held the way the sync host election is held:
//
//   - a window that IS an app holds a Web Lock named for the app for as long
//     as it lives. The browser releases the lock when the window closes or
//     its renderer dies, so presence can never go stale on a crash;
//   - it announces itself on a BroadcastChannel so the other windows learn
//     at once, and says goodbye on the way out; a window arriving late asks
//     the lock manager once at boot, and again whenever a hello lands or the
//     window comes back into view, since a goodbye can be lost with the
//     window that meant to send it;
//   - the same channel carries an "open" request: a path handed to an app
//     window by a window that has no shell verb to do it with. The receiver
//     applies it as a navigation the shell placed (DesktopProvider), so the
//     path is never bounced back.
//
// Pure module: no React, no store. The role tracker in lib/desktop is the
// model for the snapshot and its watchers.
import { isDesktopApp } from "../../electron/appWindows.mjs";
import type { DesktopApp } from "./desktopApps";

const CHANNEL = "codecast-app-windows";
const LOCK_PREFIX = "codecast-app-window:";

type Message =
  | { type: "hello"; app: DesktopApp }
  | { type: "bye"; app: DesktopApp }
  // A path for the app's window, or null: just come to the front.
  | { type: "open"; app: DesktopApp; path: string | null };

let present: Partial<Record<DesktopApp, boolean>> = {};
const watchers = new Set<() => void>();
let channel: BroadcastChannel | null = null;
let installed = false;
// The app THIS window announced, so an "open" for it is applied here.
let announced: DesktopApp | null = null;

// The channel is the floor; the lock manager is the crash guard on top of
// it. Without locks the windows still tell each other hello and goodbye.
function hasChannel(): boolean {
  return typeof window !== "undefined" && typeof BroadcastChannel !== "undefined";
}
function locks(): { request: Function; query: () => Promise<{ held?: { name?: string }[] }> } | null {
  const l = typeof navigator !== "undefined" ? (navigator as any).locks : null;
  return l && typeof l.request === "function" && typeof l.query === "function" ? l : null;
}

function setPresent(next: Partial<Record<DesktopApp, boolean>>): void {
  const same =
    Object.keys({ ...present, ...next }).every((k) => !!present[k as DesktopApp] === !!next[k as DesktopApp]);
  if (same) return;
  present = { ...next };
  for (const cb of watchers) cb();
}

/** Which app windows exist right now, as far as this profile's windows know. */
export function appWindowPresence(): Partial<Record<DesktopApp, boolean>> {
  return present;
}

export function subscribeAppWindowPresence(cb: () => void): () => void {
  watchers.add(cb);
  return () => {
    watchers.delete(cb);
  };
}

/** Ask the lock manager which apps are held, and take that as the truth. */
export async function refreshAppWindowPresence(): Promise<void> {
  const l = locks();
  if (!l) return;
  try {
    const state = await l.query();
    const next: Partial<Record<DesktopApp, boolean>> = {};
    for (const lock of state.held ?? []) {
      const name = String(lock.name ?? "");
      if (!name.startsWith(LOCK_PREFIX)) continue;
      const app = name.slice(LOCK_PREFIX.length);
      if (isDesktopApp(app)) next[app as DesktopApp] = true;
    }
    setPresent(next);
  } catch {
    // A lock manager that will not answer leaves the last snapshot standing.
  }
}

function post(msg: Message): void {
  try {
    channel?.postMessage(msg);
  } catch {}
}

/**
 * Open the channel and start listening. Idempotent; every window calls it
 * once (DashboardLayout). `onOpen` receives a path another window handed to
 * THIS app window.
 */
export function installAppWindowRegistry(onOpen: (path: string | null) => void): void {
  if (installed || !hasChannel()) return;
  installed = true;
  channel = new BroadcastChannel(CHANNEL);
  channel.addEventListener("message", (e: MessageEvent<Message>) => {
    const msg = e.data;
    if (!msg || typeof msg !== "object" || !isDesktopApp(msg.app)) return;
    if (msg.type === "hello") setPresent({ ...present, [msg.app]: true });
    else if (msg.type === "bye") setPresent({ ...present, [msg.app]: false });
    else if (msg.type === "open" && msg.app === announced) onOpen(typeof msg.path === "string" ? msg.path : null);
    // A hello or a bye is a moment to re-read the truth: a goodbye may have
    // died with its window, and two windows may have raced for one app.
    if (msg.type !== "open") void refreshAppWindowPresence();
  });
  void refreshAppWindowPresence();
  window.addEventListener?.("focus", () => void refreshAppWindowPresence());
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void refreshAppWindowPresence();
    });
  }
}

/**
 * This window is `app`'s window: hold its lock and say so. Returns the
 * release, for when the window stops being that app (a breakout on an older
 * shell that navigates away). The lock is also the crash guard: it goes with
 * the renderer whether or not the release ever runs.
 */
export function announceAppWindow(app: DesktopApp): () => void {
  if (!hasChannel()) return () => {};
  let release: (() => void) | null = null;
  let released = false;
  announced = app;
  const hello = () => {
    setPresent({ ...present, [app]: true });
    post({ type: "hello", app });
  };
  const l = locks();
  if (l) {
    void l.request(LOCK_PREFIX + app, { ifAvailable: true }, (lock: unknown) => {
      // Another window already IS this app (two breakouts on an older
      // shell): hold nothing, announce nothing, and stay a plain window as
      // far as the registry is concerned.
      if (!lock || released) return;
      hello();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
  } else hello();
  const bye = () => {
    if (released) return;
    released = true;
    if (announced === app) announced = null;
    post({ type: "bye", app });
    release?.();
  };
  window.addEventListener?.("pagehide", bye, { once: true });
  return () => {
    window.removeEventListener?.("pagehide", bye);
    bye();
    setPresent({ ...present, [app]: false });
    void refreshAppWindowPresence();
  };
}

/** Hand `path` to `app`'s window over the channel (null: raise it). True
 *  when one exists to take it; the caller then stands down. */
export function requestAppWindowOpen(app: DesktopApp, path: string | null): boolean {
  if (!present[app] || !channel) return false;
  post({ type: "open", app, path });
  return true;
}

/** Test seam: forget everything. */
export function resetAppWindowRegistryForTests(): void {
  present = {};
  announced = null;
  installed = false;
  channel?.close();
  channel = null;
}
