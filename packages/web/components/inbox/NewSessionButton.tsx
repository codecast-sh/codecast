"use client";

// The visible way to start a session. Modern's rail had only a 14px plus on
// its Folders heading, and zen mode hides the rail and the top bar together,
// so with the inbox list on screen there was nothing to press. "row" heads
// the rail under the workspace switcher; "icon" heads the inbox list, which
// is on screen in zen too.

import { SquarePen } from "lucide-react";
import { useInboxStore } from "../../store/inboxStore";
import { useIsModernStyle } from "../../hooks/useVisualStyle";
import { ShortcutTooltip } from "../KeyboardShortcutsHelp";
import { Button } from "../ui/button";

const RING = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sol-cyan";

export function NewSessionButton({ variant }: { variant: "row" | "icon" }) {
  const openCompose = useInboxStore((s) => s.openCompose);
  if (variant === "row") {
    return (
      <ShortcutTooltip label="New session" action="session.compose" side="right">
        <button
          type="button"
          data-new-session="row"
          onClick={() => openCompose()}
          className={`flex h-8 w-full items-center gap-2 rounded-control border border-sol-border bg-sol-card px-2.5 text-ui font-medium text-sol-text shadow-sm transition-colors duration-press hover:border-sol-cyan/60 hover:text-sol-cyan ${RING}`}
        >
          <SquarePen aria-hidden className="size-4 shrink-0 text-sol-cyan" />
          <span className="min-w-0 truncate">New session</span>
        </button>
      </ShortcutTooltip>
    );
  }
  return (
    <ShortcutTooltip label="New session" action="session.compose" side="bottom">
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
