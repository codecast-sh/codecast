"use client";
// Who holds a decision in the team's inbox, and the control that gives it to a
// teammate: on a row its face (an empty ring when nobody holds it), in the
// reader its face and name. Picking a person passes the decision to them
// (store passDecision, convex passCore): it enters their queue, everyone still
// sees it in the team's list, and the face changes at once.
import { useRef, useState } from "react";
import { ChevronDown, UserRoundPlus } from "lucide-react";
import { useInboxStore } from "../../../../store/inboxStore";
import { useWatchEffect } from "../../../../hooks/useWatchEffect";
import { FilterOptionList } from "../../../FilterDropdown";
import type { AssigneeOption } from "../../../../hooks/useRolesAndPeopleOptions";

export function AssignDecision({ decisionId, assignee, people, compact }: {
  decisionId: string;
  assignee: string | null;
  /** The team's people (useRolesAndPeopleOptions), read once by the list. */
  people: ReadonlyArray<AssigneeOption>;
  /** A row's face alone; the reader's carries the name too. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const passDecision = useInboxStore((s) => s.passDecision);
  const holder = assignee ? people.find((p) => p.key === assignee) ?? null : null;
  const name = holder?.label ?? (assignee ? "Someone" : null);

  useWatchEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); } };
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", away); window.removeEventListener("keydown", esc, true); };
  }, [open]);

  const pick = (key: string) => {
    setOpen(false);
    if (key && key !== assignee) passDecision(decisionId, { kind: "user", id: key });
  };

  return (
    <div ref={ref} className="fy-assign" data-compact={compact ? "" : undefined} data-line-foryou-assign={assignee ?? ""}>
      <button type="button" className="fy-assign-btn" aria-expanded={open} aria-haspopup="listbox" onClick={() => setOpen(!open)}
        title={name ? `Assigned to ${name}` : "Assign"} aria-label={name ? `Assigned to ${name}; reassign` : "Assign"}>
        {holder ? <span className="fy-face">{holder.face}</span> : <UserRoundPlus className="fy-assign-none" aria-hidden />}
        {!compact && <span className="fy-assign-name">{name ?? "Assign"}</span>}
        {!compact && <ChevronDown className="w-3 h-3 opacity-60" aria-hidden />}
      </button>
      {open && (
        <div className="fy-assign-menu" role="listbox">
          <FilterOptionList options={people.map((p) => ({ ...p, section: undefined }))} value={assignee ?? ""} onChange={pick} searchable={people.length > 8} />
        </div>
      )}
    </div>
  );
}
