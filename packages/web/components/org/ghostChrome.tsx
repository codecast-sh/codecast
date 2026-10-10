// The ghost chrome a proposal's changes wear (docs/architecture/org-staffing.md
// S5): the per-status border and colour, the small tag ("proposed",
// "retire", "accepted"), and the frame of a stub. Shared by the chart's node
// cards and the proposal card a conversation draws (S24), which must not pull
// React Flow into the message bundle: everything here is plain React.
import React from "react";
import { cn } from "../../lib/utils";
import { CHIP_STATUS } from "./orgMeta";
import type { OrgChangeStatus } from "./orgStaffingTypes";
import { CHANGE_STATUS_META } from "./staffingModel";

/** A small tag: "proposed", "retire", "this session", "accepted". Framed and dashed on the proposal card's role rows; `quiet` (every chart card, a goal row) is the word alone. */
export function GhostTag({ label, status = "proposed", tone, quiet, className }: { label: string; status?: OrgChangeStatus; /** A colour of its own (a retire reads red, not the proposal violet). */ tone?: string; /** The word alone, no frame: for rows that would otherwise be all dashes. */ quiet?: boolean; className?: string }) {
  const m = tone && status === "proposed" ? { border: `1.5px dashed color-mix(in srgb, ${tone} 70%, transparent)`, color: tone } : CHIP_STATUS[status];
  return (
    <span className={cn("inline-flex items-center h-[16px] whitespace-nowrap font-medium", quiet ? "text-[10.5px]" : "px-1 rounded-sm text-[9.5px] uppercase tracking-[0.06em]", className)} style={{ border: quiet ? undefined : m.border, color: m.color }} data-ghost-tag={label}>
      {label}
    </span>
  );
}



/** A change's status as a filled pill ("applied", "skipped", "failed"). */
export function StatusPill({ status }: { status: OrgChangeStatus }) {
  const m = CHANGE_STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-1 h-[18px] px-1.5 rounded-md text-[10px] font-medium shrink-0" style={{ background: `color-mix(in srgb, ${m.color} 14%, transparent)`, color: m.color }} data-status={status}>
      <span className="w-1.5 h-1.5 rounded-full" style={{ background: m.color }} />
      {m.label}
    </span>
  );
}
