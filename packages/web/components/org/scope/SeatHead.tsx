"use client";
// The controls a role's standing session adds to its own session header
// (docs/architecture/initiatives-projects-role-page.md I3). On the role page
// that header rests on one row: the live status, the session menu and these.
// Everything else the session page carries (owners, device, share, diff,
// model, branch) is the same header, one press away. The fold itself is CSS
// on `data-seat-head` (globals.css), so no action is ever rebuilt here.
import { ChevronsDownUp, ChevronsUpDown, MessagesSquare, PanelRight } from "lucide-react";
import { ShortcutTooltip } from "../../KeyboardShortcutsHelp";
import { cn } from "../../../lib/utils";

const ICON_BUTTON = "p-1 rounded hover:bg-sol-bg-alt text-sol-text-dim hover:text-sol-text-secondary transition-colors";
const TEXT_BUTTON = "h-[22px] inline-flex items-center gap-1 px-1.5 rounded text-[11px] text-sol-text-dim hover:text-sol-text-secondary hover:bg-sol-bg-alt transition-colors whitespace-nowrap";

/** What the resting row says it is, where the title would be. The role's
 *  header above already carries the face and the name. */
export function SeatHeadLabel() {
  return <span data-seat-label className="text-[11px] text-sol-text-dim select-none">Session</span>;
}

export function SeatHeadControls({ open, onToggle, onSessionView }: { open: boolean; onToggle: () => void; onSessionView: () => void }) {
  const Icon = open ? ChevronsDownUp : ChevronsUpDown;
  return (
    <div className="flex items-center gap-0.5 pr-1" data-seat-controls>
      <ShortcutTooltip label="Open the plain conversation, for this visit" side="bottom">
        <button type="button" onClick={onSessionView} className={TEXT_BUTTON} data-seat-session-view>
          <MessagesSquare className="w-3 h-3" /> Session view
        </button>
      </ShortcutTooltip>
      <ShortcutTooltip label={open ? "Fold the session's controls" : "Owners, device, share, diff and the rest"} side="bottom">
        <button type="button" onClick={onToggle} aria-expanded={open} aria-label={open ? "Fold the session's controls" : "Show the session's controls"} className={cn(ICON_BUTTON, open && "text-sol-cyan")} data-seat-head-toggle>
          <Icon className="w-3.5 h-3.5" />
        </button>
      </ShortcutTooltip>
    </div>
  );
}

/** The way back, on the plain conversation a person opened from a seat. */
export function RolePageControl({ onRolePage }: { onRolePage: () => void }) {
  return (
    <div className="flex items-center pr-1">
      <ShortcutTooltip label="Back to the role page: the conversation with the scope beside it" side="bottom">
        <button type="button" onClick={onRolePage} className={TEXT_BUTTON} data-seat-role-page>
          <PanelRight className="w-3 h-3" /> Role page
        </button>
      </ShortcutTooltip>
    </div>
  );
}
