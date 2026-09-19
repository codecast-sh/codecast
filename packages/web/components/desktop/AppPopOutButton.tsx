"use client";
// The sidebar's gesture for the desktop's apps: pop Chat (chat and calls) or
// Work (projects, tasks, docs, initiatives) out into a window of its own, and
// while that window exists, say so — the same control turns into the mark
// that the group lives in another window, and pressing it raises that
// window. One mark per app, on the row or heading that owns the group: a
// mark on every row read as four switches for one window.
import { AppWindowMac, PictureInPicture2 } from "lucide-react";
import { toast } from "sonner";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { useDesktopAppWindow, useDesktopWindowRole } from "../../hooks/useDesktopWindowRole";
import { DESKTOP_APPS, openDesktopApp, type DesktopApp } from "../../lib/desktopApps";
import { bridge } from "../../lib/desktop";
import { explainPopOut, popOutWindow } from "../../lib/popOut";
import { cn } from "../../lib/utils";

/** Open (or raise) an app's window from anywhere, with the ladder every
 *  popout climbs: the shell's app window, a plain breakout on an older
 *  shell, a named popup in a browser — and a sentence when a rung is missing. */
export async function popOutApp(app: DesktopApp, path?: string): Promise<void> {
  const route = path ?? DESKTOP_APPS[app].home;
  const popup = { name: `codecast-${app}`, width: 1100, height: 760 };
  const shellOpen = bridge("openAppWindow") ? async () => { await openDesktopApp(app, route); } : undefined;
  const outcome = await popOutWindow(route, shellOpen, popup);
  explainPopOut(outcome, { thing: `the ${DESKTOP_APPS[app].title} window`, route, name: popup.name }, toast);
}

export function AppPopOutButton({ app, className }: { app: DesktopApp; className?: string }) {
  const popped = useDesktopWindowRole().apps[app] === true;
  // Inside the app's own window there is no gesture to make.
  if (useDesktopAppWindow() === app) return null;
  const title = DESKTOP_APPS[app].title;
  // The label names what pressing does; the glyph alone carries the state.
  const label = popped ? `Raise the ${title} window` : `Open ${title} in its own window`;
  return (
    <ShortcutTooltip label={label}>
      <button
        type="button"
        onClick={(e) => {
          // In the rail this sits inside a row that is itself a link.
          e.preventDefault();
          e.stopPropagation();
          void popOutApp(app);
        }}
        className={cn(
          "rounded p-1 transition-opacity focus-visible:opacity-100",
          // The mark of a popped section stays visible; the gesture to pop
          // one out appears on hover, like every other row action.
          popped
            ? "text-sol-cyan opacity-100"
            : "text-sol-text-dim opacity-0 hover:text-sol-text group-hover/nav:opacity-100 group-hover/rail:opacity-100",
          className,
        )}
        aria-label={label}
        aria-pressed={popped}
      >
        {popped ? <AppWindowMac className="h-3.5 w-3.5" /> : <PictureInPicture2 className="h-3.5 w-3.5" />}
      </button>
    </ShortcutTooltip>
  );
}
