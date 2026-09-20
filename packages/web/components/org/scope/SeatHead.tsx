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

/** What is wrong with the session, said in the row's own words: the one
 *  thing that replaces the state word at rest. Null when nothing is. */
export type SeatStall = { word: string; action?: { label: string; onClick: () => void } } | null;

/** The resting row's first slot. It mounts at rest and leaves when the
 *  header opens: a DOM change inside the header's row, which is what makes
 *  the row's squeeze (useSqueezeToFit) measure again. With a stall it carries
 *  the notice; the live status word is hidden then (globals.css), so the row
 *  never says "Connected" beside "unresponsive". */
export function SeatHeadState({ stall }: { stall: SeatStall }) {
  if (!stall) return <span data-seat-label hidden />;
  return (
    <span data-seat-label data-seat-stall className="inline-flex items-center gap-1.5 text-[11px] whitespace-nowrap" style={{ color: stall.action ? "var(--sol-orange)" : "var(--sol-text-muted)" }}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: "currentColor" }} />
      {stall.word}
      {stall.action && (
        <button type="button" onClick={stall.action.onClick} className="h-[18px] px-1.5 rounded text-[10.5px] font-medium border transition-colors hover:brightness-110" style={{ borderColor: "color-mix(in srgb, currentColor 45%, transparent)" }} data-seat-stall-action>
          {stall.action.label}
        </button>
      )}
    </span>
  );
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
