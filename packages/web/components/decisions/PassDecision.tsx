"use client";

import { useMemo, useRef } from "react";
import { useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useTeamRosterIdentity } from "../../hooks/useTeamRoster";
import { useRolesAndPeopleOptions } from "../../hooks/useRolesAndPeopleOptions";
import { FilterOptionList } from "../FilterDropdown";
import { KeyCap } from "../KeyboardShortcutsHelp";

// Hand an open question to someone else: a teammate (it moves to their queue)
// or a role (it is woken on it and may answer). People and roles come from the
// one list every picker shares; the current holder is left out.
export function PassDecision({ decisionId, open, onOpenChange, onPassed, keys = true, label = "Pass to…" }: {
  decisionId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPassed?: () => void;
  /** Draw the p keycap: only where the surface claims the key. */
  keys?: boolean;
  /** In the surface's own casing ("dismiss" beside it, or "Dismiss"). */
  label?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const roster = useTeamRosterIdentity();
  const { people, roles } = useRolesAndPeopleOptions(roster);
  const meId = useInboxStore((s) => s.currentUser?._id as string | undefined);
  const holderKey = useInboxStore((s) => (s.sessionDecisions[decisionId] ?? s.decisionDetails[decisionId]?.decision)?.holder_key);
  const passDecision = useInboxStore((s) => s.passDecision);

  const options = useMemo(() => [
    ...people.filter((p) => p.key !== meId && holderKey !== `user:${p.key}`).map((p) => ({ ...p, section: "People" })),
    ...roles.filter((r) => holderKey !== `role:${r.key}`).map((r) => ({ ...r, label: `${r.label} ${r.hint ?? ""}`.trim() })),
  ], [people, roles, meId, holderKey]);
  const roleIds = useMemo(() => new Set(roles.map((r) => r.key)), [roles]);

  useWatchEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onOpenChange(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); onOpenChange(false); } };
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", away); window.removeEventListener("keydown", esc, true); };
  }, [open, onOpenChange]);

  const pick = (key: string) => {
    passDecision(decisionId, { kind: roleIds.has(key) ? "role" : "user", id: key });
    onOpenChange(false);
    onPassed?.();
  };

  return (
    <div ref={ref} className="relative">
      <button onClick={() => onOpenChange(!open)} className="flex items-center gap-1.5 hover:text-sol-text transition-colors" aria-expanded={open}>
        {keys && <KeyCap size="xs">p</KeyCap>}<span>{label}</span>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-max min-w-[13rem] max-w-[20rem] bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[250] py-1 max-h-72 overflow-y-auto">
          <FilterOptionList options={options} value="" onChange={pick} searchable />
        </div>
      )}
    </div>
  );
}
