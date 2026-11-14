"use client";

// The visible way to start a session. Modern's rail had only a 14px plus on
// its Folders heading, and zen mode hides the rail and the top bar together,
// so with the inbox list on screen there was nothing to press. "row" heads
// the rail under the workspace switcher; "icon" heads the inbox list, which
// is on screen in zen too.
//
// The row is the rail's one filled button and carries its key on its face.
// Drawn as an outlined card it read as one more row of the list under it
// (Inbox, Decisions, Threads, ...), and its key was only in a hover tooltip.

import { SquarePen } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useIsModernStyle } from "../../hooks/useVisualStyle";
import { KeyCap, ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { formatAcceleratorParts, useShortcutParts } from "../../shortcuts";
import { isDesktopShell } from "../../lib/desktop";
import { Button } from "../ui/button";

/** The key that starts a session here. The desktop app's File › New Session
 *  takes Cmd+N (Ctrl+N off a Mac) before the page sees it; a browser keeps
 *  Cmd+N for itself, so the page's own binding (Ctrl+N) is the key there. */
function useNewSessionKeys(): string[] | null {
  const pageKeys = useShortcutParts("session.compose");
  return isDesktopShell() ? formatAcceleratorParts("CommandOrControl+N") : pageKeys;
}

export function NewSessionButton({ variant }: { variant: "row" | "icon" }) {
  const openCompose = useInboxStore((s) => s.openCompose);
  const keys = useNewSessionKeys();
  if (variant === "row") {
    return (
      <Button
        type="button"
        variant="primary"
        size="md"
        data-new-session="row"
        onClick={() => openCompose()}
        className="w-full justify-start gap-2 px-2.5"
      >
        <SquarePen aria-hidden />
        <span className="min-w-0 flex-1 truncate text-left">New session</span>
        {keys && (
          <span aria-hidden className="flex shrink-0 items-center gap-[2px]">
            {keys.map((part, i) => <KeyCap key={i} size="xs" tone="ink">{part}</KeyCap>)}
          </span>
        )}
      </Button>
    );
  }
  return (
    <ShortcutTooltip label="New session" {...(isDesktopShell() ? { accel: "CommandOrControl+N" } : { action: "session.compose" as const })} side="bottom">
      <Button
        type="button"
        variant="primary"
        size="icon-sm"
        data-new-session="icon"
        aria-label="New session"
        onClick={() => openCompose()}
        className="shrink-0"
      >
        <SquarePen aria-hidden />
      </Button>
    </ShortcutTooltip>
  );
}

/** The inbox list's own New session button. Modern only: Classic and Minimal
 *  keep their list head as it is. */
export function ListHeadNewSession() {
  const modern = useIsModernStyle();
  if (!modern) return null;
  return <NewSessionButton variant="icon" />;
}
