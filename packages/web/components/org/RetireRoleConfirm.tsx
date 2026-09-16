"use client";
// The one retire confirm (docs/architecture/org-staffing.md S16). Unseating
// the chief of staff asks what becomes of the agent the person already talks
// to; keeping it is the default, so nobody is left without the assistant they
// had. Any other seat has no such thread and gets the plain confirm. The
// role's settings page and the org page's panel both draw this, so no retire
// surface can skip the question.
import { useState } from "react";
import { CHIEF_OF_STAFF_HANDLE } from "./orgStaffingTypes";

export type UnseatChoice = "keep" | "retire";

export const UNSEAT_CHOICES: readonly (readonly [UnseatChoice, string, string])[] = [
  ["keep", "Keep it running as a plain agent", "It gets its old title back and stops answering as the role."],
  ["retire", "Retire it with the seat", "The thread is kept and stops waking."],
];

/** The choice a retire carries: asked for the chief of staff, absent for any other seat. */
export function isChiefOfStaff(role: { handle: string }): boolean {
  return role.handle === CHIEF_OF_STAFF_HANDLE;
}

/** What the toast says after a retire, the same words on every surface. */
export function retireToastText(roleName: string, choice: UnseatChoice | undefined): string {
  return choice === "keep"
    ? `Retired ${roleName}; its agent keeps running as a plain agent`
    : choice === "retire"
      ? `Retired ${roleName} and its standing agent; the thread is kept`
      : `Retired ${roleName}`;
}

export function RetireRoleConfirm({ role, lead, onRetire, onCancel }: {
  role: { name: string; handle: string };
  /** The sentence about what a retire does to sessions and reports, when the
   *  surface has not already said it above the confirm. */
  lead?: React.ReactNode;
  onRetire: (choice: UnseatChoice | undefined) => void;
  onCancel: () => void;
}) {
  const chief = isChiefOfStaff(role);
  const [choice, setChoice] = useState<UnseatChoice>("keep");
  return (
    <div className="flex flex-col gap-2" data-retire-confirm={chief ? "chief" : "role"}>
      {lead && <p className="text-[12px]" style={{ color: "var(--sol-text-secondary)" }}>{lead}</p>}
      {chief && (
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label="What happens to its standing agent">
          {UNSEAT_CHOICES.map(([value, label, sub]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={choice === value}
              aria-pressed={choice === value}
              onClick={() => setChoice(value)}
              className="text-left rounded-lg border px-2.5 py-2"
              data-unseat-choice={value}
              style={{ borderColor: choice === value ? "var(--sol-red)" : "color-mix(in srgb, var(--sol-border) 40%, transparent)", background: choice === value ? "color-mix(in srgb, var(--sol-red) 8%, transparent)" : undefined }}
            >
              <span className="text-[12px] font-semibold" style={{ color: "var(--sol-text)" }}>{label}</span>
              <span className="block text-[11px] mt-0.5" style={{ color: "var(--sol-text-muted)" }}>{sub}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => onRetire(chief ? choice : undefined)} className="h-7 px-3 rounded-md text-[12px] font-semibold" style={{ background: "var(--sol-red)", color: "var(--sol-bg)" }} data-retire-submit>Retire {role.name}</button>
        <button type="button" onClick={onCancel} className="h-7 px-3 rounded-md text-[12px]" style={{ color: "var(--sol-text-muted)" }}>Cancel</button>
      </div>
    </div>
  );
}
