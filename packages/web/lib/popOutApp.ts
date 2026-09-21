import { toast } from "sonner";
import { DESKTOP_APPS, hasAppWindow, openDesktopApp, raiseDesktopApp, type DesktopApp } from "./desktopApps";
import { bridge } from "./desktop";
import { explainPopOut, popOutWindow } from "./popOut";

/** Open (or raise) an app's window from anywhere, with the ladder every
 *  popout climbs: the shell's app window, a plain breakout on an older
 *  shell, a named popup in a browser — and a sentence when a rung is missing. */
export async function popOutApp(app: DesktopApp, path?: string): Promise<void> {
  if (hasAppWindow(app) && raiseDesktopApp(app)) return;
  const route = path ?? DESKTOP_APPS[app].home;
  const popup = { name: `codecast-${app}`, width: 1100, height: 760 };
  const shellOpen = bridge("openAppWindow") ? async () => { await openDesktopApp(app, route); } : undefined;
  const outcome = await popOutWindow(route, shellOpen, popup);
  explainPopOut(outcome, { thing: `the ${DESKTOP_APPS[app].title} window`, route, name: popup.name }, toast);
}
