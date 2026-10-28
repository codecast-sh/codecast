"use client";
// Who holds a decision in the team's inbox, and the control that gives it to a
// teammate: on a row its face (an empty ring when nobody holds it), in the
// reader its face and name, over a selection a button for all of them.
// Picking a person passes each decision to them (store passDecision, convex
// passCore): it enters their queue, everyone still sees it in the team's list,
// and the face changes at once. A note typed above the list rides the pass;
// with one, Escalate sends them up to the owner's manager, else the admins
// (escalateDecision). Unassign takes a pass back (unassignDecision): the
// decision is routed as its session would route it now.
import { useRef, useState } from "react";
import { ArrowUp, ChevronDown, UserRoundPlus, UserRoundX } from "lucide-react";
import { useInboxStore } from "../../../../store/inboxStore";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { FilterOptionList, type FilterOption } from "../../../FilterDropdown";
import { KeyCap } from "../../../KeyCap";
import type { AssigneeOption } from "../../../../hooks/useRolesAndPeopleOptions";

const UNASSIGN = "\u0000unassign";

export function AssignDecision({ ids, assignee, people, variant = "face", open, onOpenChange, keyHint, onDone }: {
  /** The decisions' row ids: one, or a selection. */
  ids: ReadonlyArray<string>;
  /** Who holds them, when they share one holder; null when nobody or several. */
  assignee: string | null;
  /** The team's people (useRolesAndPeopleOptions), read once by the list. */
  people: ReadonlyArray<AssigneeOption>;
  /** "face": a row's face alone; "cell": a table cell's face and name, a quiet mark when nobody holds it; "named": the
   *  reader's face and name, or Assign; "button": a selection's Assign button. */
  variant?: "face" | "cell" | "named" | "button";
  /** The picker is open; the host opens it from a key too. Unassign is offered when any of them is assigned. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The key that opens it here, drawn on the control. */
  keyHint?: string;
  /** Called once a pick lands (a selection clears itself then). */
  onDone?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const passDecision = useInboxStore((s) => s.passDecision);
  const unassignDecision = useInboxStore((s) => s.unassignDecision);
  const escalateDecision = useInboxStore((s) => s.escalateDecision);
  const [note, setNote] = useState("");
  const anyAssigned = useInboxStore((s) => ids.some((id) => s.sessionDecisions[id]?.passed_to?.kind === "user"));
  const holder = assignee ? people.find((p) => p.key === assignee) ?? null : null;
  const name = holder?.label ?? (assignee ? "Someone" : null);

  useWatchEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); } };
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", away); window.removeEventListener("keydown", esc, true); };
  }, [open, onOpenChange]);

  const close = () => { setNote(""); onOpenChange(false); };
  const pick = (key: string) => {
    close();
    if (key === UNASSIGN) { for (const id of ids) unassignDecision(id); onDone?.(); return; }
    if (!key) return;
    const said = note.trim() || undefined;
    for (const id of ids) passDecision(id, { kind: "user", id: key }, said);
    onDone?.();
  };
  const escalate = () => {
    if (!note.trim()) return;
    for (const id of ids) escalateDecision(id, note);
    close();
    onDone?.();
  };
  const options: FilterOption[] = [
    ...people.map((p) => ({ ...p, section: undefined })),
    ...(anyAssigned ? [{ key: UNASSIGN, label: "Unassign", icon: UserRoundX, section: " " }] : []),
  ];

  return (
    <div ref={ref} className="fy-assign" data-variant={variant} data-line-foryou-assign={assignee ?? ""}>
      <button type="button" className="fy-assign-btn" aria-expanded={open} aria-haspopup="listbox" onClick={(e) => { e.stopPropagation(); onOpenChange(!open); }}
        title={variant === "button" ? undefined : name ? `Assigned to ${name}` : "Assign"} aria-label={variant === "button" ? `Assign ${ids.length}` : name ? `Assigned to ${name}; reassign` : "Assign"}>
        {variant === "button" ? <UserRoundPlus className="w-3.5 h-3.5" aria-hidden /> : holder ? <span className="fy-face">{holder.face}</span> : <UserRoundPlus className="fy-assign-none" aria-hidden />}
        {(variant === "named" || (variant === "cell" && name)) && <span className="fy-assign-name">{name ?? "Assign"}</span>}
        {variant === "button" && <span>Assign</span>}
        {(variant === "named" || variant === "button") && keyHint && <KeyCap size="xs">{keyHint}</KeyCap>}
        {(variant === "named" || variant === "button") && <ChevronDown className="w-3 h-3 opacity-60" aria-hidden />}
      </button>
      {open && (
        <div className="fy-assign-menu" role="listbox" onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-1">
            <input value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && note.trim()) { e.preventDefault(); escalate(); } }}
              placeholder="Note (optional)" aria-label="Note" data-decision-handoff-note
              className="flex-1 min-w-0 rounded border border-sol-border bg-sol-bg-alt px-1.5 py-1 text-[12px] text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-blue" />
            <button type="button" onClick={escalate} disabled={!note.trim()} data-decision-escalate
              className="shrink-0 flex items-center gap-1 px-1.5 py-1 rounded border border-sol-orange/40 text-sol-orange text-[11px] disabled:opacity-40"
              title={note.trim() ? "Send it up to the owner's manager, else the admins" : "Write why it goes up first"}>
              <ArrowUp className="w-3 h-3" aria-hidden />Escalate
            </button>
          </div>
          <FilterOptionList options={options} value={assignee ?? ""} onChange={pick} searchable={people.length > 8} />
        </div>
      )}
    </div>
  );
}
