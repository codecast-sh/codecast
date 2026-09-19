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
import { bridge, getDesktopWindowRole, isElectron } from "./desktop";
import { isNonTabRoute } from "./tabRoutes";

export { DESKTOP_APPS, appForRoute, isDesktopApp, sectionForRoute };
export type DesktopApp = keyof typeof DESKTOP_APPS;

/**
 * The app this document IS: the window was opened as Chat or Work. Null in the
 * main window, a plain breakout, a browser.
 *
 * Two sources, one fact. A window built cold carries it in its preload
 * arguments, so its first frame is already right. A window made from the
 * shell's warm spare (the instant path) was built before anyone knew what it
 * would become, so it reads it off its window role — which is why anything
 * that DRAWS this goes through useDesktopAppWindow, and re-renders when the
 * spare is claimed.
 */
export function desktopAppWindow(): DesktopApp | null {
  if (typeof window === "undefined") return null;
  const app = window.__CODECAST_ELECTRON__?.appWindow ?? getDesktopWindowRole().app;
  return isDesktopApp(app) ? (app as DesktopApp) : null;
}

/** An app window exists somewhere — this one or another. */
export function hasAppWindow(app: DesktopApp): boolean {
  return desktopAppWindow() === app || getDesktopWindowRole().apps[app] === true;
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
  if (placedByShell || !isElectron()) return false;
  if (isNonTabRoute(path)) return false;
  const route = bridge("routeNavigate");
  if (!route) return false;
  if (placeRoute(path, desktopAppWindow(), getDesktopWindowRole().apps) === "here") return false;
  void route(path);
  return true;
}
