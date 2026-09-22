import { useState } from "react";
import { escalationFirstLine, type RoleEscalation } from "@codecast/shared/contracts";
import { EntityIdPill } from "./EntityIdPill";
import { useInboxStore } from "../store/inboxStore";
import { formatDateFull, formatRelative } from "../lib/utils";

// The lines a role's card carries (org-roles-run-work.md R1, revised): one
// per session the role put in front of the person through its own card,
// newest first. The strip shows the first line of the reason; hover shows all
// of it and a click unfolds it. Hand back per line takes that session back
// under the role, in the same tick, through the one gesture the row has.
export function RoleEscalationLines({ escalations, coarseNow, canHandBack, onOpen }: { escalations: RoleEscalation[]; coarseNow: number; canHandBack: boolean; onOpen?: (id: string) => void }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) => setOpen((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  return (
    <div data-role-escalations className="flex flex-col gap-1 mt-1 mr-5">
      {escalations.map((e) => {
        const unfolded = open.has(e.conversation_id);
        const firstLine = escalationFirstLine(e.line);
        return (
          <div key={e.conversation_id} data-role-escalation={e.conversation_id} className="flex items-start gap-1.5 px-1.5 py-1 rounded-md bg-sol-violet/10 border border-sol-violet/30">
            <span className="flex-shrink-0 mt-px" onClick={(ev) => { ev.stopPropagation(); onOpen?.(e.conversation_id); }}>
              <EntityIdPill id={e.conversation_id} type="session" compact />
            </span>
            <button
              type="button"
              onClick={(ev) => { ev.stopPropagation(); toggle(e.conversation_id); }}
              title={e.line}
              className={`min-w-0 flex-1 text-left text-[11px] leading-snug text-sol-text ${unfolded ? "whitespace-pre-wrap break-words" : "truncate"}`}
            >
              {unfolded ? e.line : firstLine}
              <span className="text-sol-text-dim whitespace-nowrap" title={formatDateFull(e.at)}>{" · "}{formatRelative(e.at, coarseNow)}</span>
            </button>
            {canHandBack && (
              <button
                type="button"
                data-role-gesture="hand-back"
                onClick={(ev) => { ev.stopPropagation(); useInboxStore.getState().handSessionBackToRole(e.conversation_id); }}
                title="Take it out of your needs input. The role looks after it again and decides if it comes back."
                className="flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium bg-sol-violet/20 text-sol-violet border border-sol-violet/40 hover:bg-sol-violet/30 transition-colors whitespace-nowrap"
              >
                Hand back
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
