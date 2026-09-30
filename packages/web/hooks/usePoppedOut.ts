import { useHasAppWindow, useDesktopAppWindow } from "./useDesktopWindowRole";
import type { DesktopApp } from "../lib/desktopApps";

/** True while `app` (when given) lives in a window of its own and this is
 *  not that window: the rail's rows for it become doors. */
export function usePoppedOut(app: DesktopApp | undefined): boolean {
  const has = useHasAppWindow(app ?? "chat");
  const here = useDesktopAppWindow();
  return !!app && has && here !== app;
}
