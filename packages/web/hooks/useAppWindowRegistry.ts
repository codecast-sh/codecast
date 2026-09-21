import { useMountEffect } from "./useMountEffect";
import { useWatchEffect } from "./useWatchEffect";
import { useAppWindowPresence, useDesktopAppWindow, useDesktopWindowRole } from "./useDesktopWindowRole";
import { announceAppWindow, appWindowPresence, installAppWindowRegistry } from "../lib/appWindowRegistry";
import { borrowsTabShell, getDesktopWindowRole } from "../lib/desktop";
import { desktopAppWindow } from "../lib/desktopApps";
import { yieldOwnedRoutes } from "../lib/stage";

export function useAppWindowRegistry() {
  const appWindow = useDesktopAppWindow();
  useMountEffect(() => {
    installAppWindowRegistry((path) => {
      if (path) window.dispatchEvent(new CustomEvent("codecast-navigate", { detail: { path, tabId: null, placed: true } }));
      window.focus();
    });
    (window as any).__appWindows = () => ({ self: desktopAppWindow(), role: getDesktopWindowRole().apps, presence: appWindowPresence() });
  });
  useWatchEffect(() => (appWindow ? announceAppWindow(appWindow) : undefined), [appWindow]);
  const presence = useAppWindowPresence();
  const roleApps = useDesktopWindowRole().apps;
  useWatchEffect(() => {
    if (appWindow || borrowsTabShell()) return;
    if (Object.values(presence).some(Boolean) || Object.values(roleApps ?? {}).some(Boolean)) yieldOwnedRoutes();
  }, [appWindow, presence, roleApps]);
  return appWindow;
}
