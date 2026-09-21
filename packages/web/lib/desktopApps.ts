// The desktop's apps: Chat and Work, each a window of its own.
//
// The table of which routes belong to which app is packages/electron/
// appWindows.mjs, shared with the shell so the two sides can never disagree
// about where a path lands. This module is the web's side of it: which app
// THIS document is, which app windows exist, how to open one, and the rule
// every navigation chokepoint asks before it moves the view — "does this path
// belong to another window?" (routeElsewhere).
//
// Outside the desktop nothing here fires: there are no app windows in a
// browser, and the rule answers "no" everywhere it is asked.
import {
  DESKTOP_APPS,
  appForRoute,
  isDesktopApp,
  placeRoute,
  sectionForRoute,
} from "../../electron/appWindows.mjs";
import { bridge, getDesktopWindowRole, isDetachedTabWindow, isElectron } from "./desktop";
import { appWindowPresence, requestAppWindowOpen } from "./appWindowRegistry";
import { isNonTabRoute } from "./tabRoutes";

export { DESKTOP_APPS, appForRoute, isDesktopApp, sectionForRoute };
export type DesktopApp = keyof typeof DESKTOP_APPS;

/**
 * The app this document IS: the window was opened as Chat or Work. Null in the
 * main window, a plain breakout, a browser.
 *
 * Three sources, one fact. A window built cold carries it in its preload
 * arguments, so its first frame is already right. A window made from the
 * shell's warm spare (the instant path) was built before anyone knew what it
 * would become, so it reads it off its window role. And on a shell from
 * before app windows existed, the popout falls down the ladder to a plain
 * breakout (lib/popOut): that window has no flag and no role to say what it
 * is, so it is the app's window exactly when it SHOWS the app's routes — the
 * one fact such a shell can offer, and enough for the bar and the rails. The
 * founder pressed the Chat popout on the shipped build and got the whole
 * dashboard in a second window (2026-09-19).
 *
 * Anything that DRAWS this goes through useDesktopAppWindow, which re-renders
 * when the role changes or the route moves.
 */
export function desktopAppWindow(path?: string): DesktopApp | null {
  if (typeof window === "undefined") return null;
  let app = window.__CODECAST_ELECTRON__?.appWindow ?? getDesktopWindowRole().app;
  if (!app && isDetachedTabWindow() && !canOpenDesktopApp()) {
    app = appForRoute(path ?? window.location.pathname);
  }
  return isDesktopApp(app) ? (app as DesktopApp) : null;
}

/** Which app windows exist: the shell's word where it has one, and the
 *  windows' own word (lib/appWindowRegistry) everywhere, so a breakout on an
 *  older shell counts the moment it shows chat. */
export function openAppWindows(): Partial<Record<DesktopApp, boolean>> {
  return { ...appWindowPresence(), ...getDesktopWindowRole().apps } as Partial<Record<DesktopApp, boolean>>;
}

/** An app window exists somewhere — this one or another. */
export function hasAppWindow(app: DesktopApp): boolean {
  return desktopAppWindow() === app || openAppWindows()[app] === true;
}

/** Where `path` belongs, asked without acting: this window, the main window,
 *  or an app window that exists (lib/appWindowRegistry, the role). */
export function routeOwner(path: string): "here" | "main" | DesktopApp {
  if (!isElectron() || isNonTabRoute(path)) return "here";
  return placeRoute(path, desktopAppWindow(), openAppWindows());
}

/** Bring an app's window to the front, wherever the verb for that lives. */
export function raiseDesktopApp(app: DesktopApp): boolean {
  const open = bridge("openAppWindow");
  if (open) {
    void open(app, null);
    return true;
  }
  return requestAppWindowOpen(app, null);
}

/** Whether this shell can open app windows at all (an older build cannot;
 *  the ladder in lib/popOut then breaks the route out as a plain window). */
export function canOpenDesktopApp(): boolean {
  return typeof bridge("openAppWindow") === "function";
}

/** Open (or raise) an app's window, on `path` when given. False on a shell
 *  without the verb, so the caller can fall back. */
export async function openDesktopApp(app: DesktopApp, path?: string): Promise<boolean> {
  const open = bridge("openAppWindow");
  if (!open) return false;
  return (await open(app, path ?? null)) === true;
}

// A navigation the SHELL placed in this window (`codecast-navigate` with
// `placed`): it already chose the window, so the rule below must not send
// the path back. Set for the synchronous span of applying that navigation.
let placedByShell = false;
export function runPlaced<T>(fn: () => T): T {
  const prev = placedByShell;
  placedByShell = true;
  try {
    return fn();
  } finally {
    placedByShell = prev;
  }
}

/**
 * The rule at every chokepoint: true when `path` belongs to another window and
 * has been handed to the shell to land there, so the caller must not move this
 * view. A Chat window asked for a session hands it to the main window; a main
 * window asked for a channel while a Chat window exists hands it there.
 *
 * Routes outside the tab shell (settings, which opens as a modal; the people
 * and call windows; the marketing site) are never handed off: they are not a
 * place one window owns.
 */
export function routeElsewhere(path: string): boolean {
  if (placedByShell) return false;
  const place = routeOwner(path);
  if (place === "here") return false;
  const route = bridge("routeNavigate");
  if (route) {
    void route(path);
    return true;
  }
  // A shell from before app windows cannot land a path in one. The windows
  // can still do it among themselves: an app window takes the path over the
  // registry's channel, and the main window takes it through the verb the
  // people and voice windows already use for that (navigateFromHere).
  if (place !== "main") return requestAppWindowOpen(place, path);
  const toMain = bridge("paletteNavigate");
  if (!toMain) return false;
  toMain(path);
  return true;
}
