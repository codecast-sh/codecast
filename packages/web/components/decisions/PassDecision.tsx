"use client";

import { useMemo, useRef, useState } from "react";
import { ArrowUp } from "lucide-react";
import { rosterEscalationTargets, useInboxStore } from "../../store/inboxStore";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useTeamRosterIdentity } from "../../hooks/useTeamRoster";
import { useRolesAndPeopleOptions } from "../../hooks/useRolesAndPeopleOptions";
import { FilterOptionList } from "../FilterDropdown";
import { KeyCap } from "../KeyboardShortcutsHelp";

type Step = { kind: "pick" } | { kind: "note"; to: { kind: "user" | "role"; id: string; label: string } } | { kind: "escalate" };

// Hand an open question to someone else: a teammate (it moves to their queue)
// or a role (it is woken on it and may answer), with an optional note for
// them. Escalate sits beside it: up to the owner's manager, else the admins,
// with a note it cannot go without. People and roles come from the one list
// every picker shares; the current holder is left out.
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
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [note, setNote] = useState("");
  const roster = useTeamRosterIdentity();
  const { people, roles } = useRolesAndPeopleOptions(roster);
  const meId = useInboxStore((s) => s.currentUser?._id as string | undefined);
  const holderKey = useInboxStore((s) => (s.sessionDecisions[decisionId] ?? s.decisionDetails[decisionId]?.decision)?.holder_key);
  const passDecision = useInboxStore((s) => s.passDecision);
  const escalateDecision = useInboxStore((s) => s.escalateDecision);
  const orgPeople = useInboxStore((s) => s.orgTree?.people);
  const members = useInboxStore((s) => s.teamMembers);

  const options = useMemo(() => [
    ...people.filter((p) => p.key !== meId && holderKey !== `user:${p.key}`).map((p) => ({ ...p, section: "People" })),
    ...roles.filter((r) => holderKey !== `role:${r.key}`).map((r) => ({ ...r, label: `${r.label} ${r.hint ?? ""}`.trim() })),
  ], [people, roles, meId, holderKey]);
  const roleIds = useMemo(() => new Set(roles.map((r) => r.key)), [roles]);
  // Whom Escalate reaches, named on the panel before it is sent.
  const upTo = useMemo(() => {
    const owner = holderKey?.startsWith("user:") ? holderKey.slice(5) : String(meId ?? "");
    const ids = rosterEscalationTargets(owner, orgPeople, members);
    return ids.map((id) => people.find((p) => p.key === id)?.label ?? "a teammate");
  }, [holderKey, meId, orgPeople, members, people]);

  const setOpen = (next: boolean, at: Step = { kind: "pick" }) => {
    setStep(at);
    setNote("");
    onOpenChange(next);
  };

  useWatchEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); setOpen(false); } };
    document.addEventListener("mousedown", away);
    window.addEventListener("keydown", esc, true);
    return () => { document.removeEventListener("mousedown", away); window.removeEventListener("keydown", esc, true); };
  }, [open, onOpenChange]);

  const pick = (key: string) => {
    const option = options.find((o) => o.key === key);
    setStep({ kind: "note", to: { kind: roleIds.has(key) ? "role" : "user", id: key, label: option?.label ?? "them" } });
  };
  const send = () => {
    if (step.kind === "note") passDecision(decisionId, { kind: step.to.kind, id: step.to.id }, note);
    else if (step.kind === "escalate") {
      if (!note.trim()) return;
      escalateDecision(decisionId, note);
    } else return;
    setOpen(false);
    onPassed?.();
  };
  const escalating = step.kind === "escalate";
  const canSend = step.kind === "note" || (escalating && !!note.trim() && upTo.length > 0);

  return (
    <div ref={ref} className="relative flex items-center gap-3">
      <button onClick={() => (open && !escalating ? setOpen(false) : setOpen(true))} className="flex items-center gap-1.5 hover:text-sol-text transition-colors" aria-expanded={open && !escalating}>
        {keys && <KeyCap size="xs">p</KeyCap>}<span>{label}</span>
      </button>
      <button onClick={() => (open && escalating ? setOpen(false) : setOpen(true, { kind: "escalate" }))} className="flex items-center gap-1 hover:text-sol-orange transition-colors" aria-expanded={open && escalating} data-decision-escalate>
        <ArrowUp className="w-3 h-3" aria-hidden /><span>{/^[a-z]/.test(label) ? "escalate" : "Escalate"}</span>
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-max min-w-[15rem] max-w-[22rem] bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[250] py-1 max-h-80 overflow-y-auto">
          {step.kind === "pick" ? (
            <FilterOptionList options={options} value="" onChange={pick} searchable />
          ) : (
            <form className="flex flex-col gap-2 p-2" onSubmit={(e) => { e.preventDefault(); send(); }} data-decision-handoff-form={step.kind}>
              <div className="flex items-center gap-1.5 text-[11px] text-sol-text-dim">
                <span className={escalating ? "text-sol-orange" : ""}>{escalating ? "Escalate to" : "Pass to"}</span>
                <span className="text-sol-text truncate">{escalating ? (upTo.join(", ") || "nobody above you") : step.to.label}</span>
              </div>
              <textarea
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                rows={3}
                placeholder={escalating ? "Why it goes up" : "Note for them (optional)"}
                aria-label={escalating ? "Why it goes up" : "Note"}
                className="w-full resize-none rounded border border-sol-border bg-sol-bg-alt px-2 py-1.5 text-[12px] text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-blue"
              />
              <div className="flex items-center justify-end gap-2 text-[11px]">
                <button type="button" onClick={() => (escalating ? setOpen(false) : setStep({ kind: "pick" }))} className="text-sol-text-dim hover:text-sol-text">{escalating ? "Cancel" : "Back"}</button>
                <button type="submit" disabled={!canSend} className={`flex items-center gap-1.5 px-2 py-1 rounded border ${escalating ? "border-sol-orange/40 text-sol-orange" : "border-sol-blue/40 text-sol-blue"} disabled:opacity-40`}>
                  {escalating ? "Escalate" : "Pass"}<KeyCap size="xs">↵</KeyCap>
                </button>
              </div>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
