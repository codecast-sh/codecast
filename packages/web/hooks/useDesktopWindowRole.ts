import { useSyncExternalStore } from "react";
import { useLocation } from "react-router";
import { desktopAppWindow, hasAppWindow, type DesktopApp } from "../lib/desktopApps";
import { appWindowPresence, subscribeAppWindowPresence } from "../lib/appWindowRegistry";
import {
  getDesktopWindowRole,
  subscribeWindowRole,
  type DesktopWindowRole,
} from "../lib/desktop";

/**
 * This window's role among the desktop's windows, as a React value.
 *
 * The role is pushed by the shell into a module variable; the sound paths read
 * it on demand, but anything that DRAWS it needs to re-render when it changes.
 * Outside the desktop nothing ever pushes, so this is a constant and the
 * subscription costs one Set entry.
 */
export function useDesktopWindowRole(): DesktopWindowRole {
  return useSyncExternalStore(subscribeWindowRole, getDesktopWindowRole, getDesktopWindowRole);
}

/** The app this window is (lib/desktopApps), as a React value: a window made
 *  from the shell's warm spare learns it from its role after it has mounted,
 *  and a breakout on an older shell is the app's window while it shows the
 *  app's routes, so the route is a dependency too. */
export function useDesktopAppWindow(): DesktopApp | null {
  const { pathname } = useLocation();
  useSyncExternalStore(subscribeWindowRole, getDesktopWindowRole, getDesktopWindowRole);
  return desktopAppWindow(pathname);
}

/** Which app windows the windows themselves report (lib/appWindowRegistry). */
export function useAppWindowPresence() {
  return useSyncExternalStore(subscribeAppWindowPresence, appWindowPresence, appWindowPresence);
}

/** Whether `app` has a window anywhere, by either the shell's or the windows'
 *  own word, as a React value. */
export function useHasAppWindow(app: DesktopApp): boolean {
  const { pathname } = useLocation();
  useSyncExternalStore(subscribeWindowRole, getDesktopWindowRole, getDesktopWindowRole);
  useAppWindowPresence();
  return desktopAppWindow(pathname) === app || hasAppWindow(app);
}
