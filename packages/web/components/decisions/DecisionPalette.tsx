"use client";
// The command palette over a selection of decisions (the Decisions list's
// Cmd+K, the actions key, a right-click): assign them, take an assignment back,
// pass them with a note, escalate them, answer them with an option they all
// offer, dismiss them. A verb that needs a choice
// (who, which answer, the note) opens its step in place; Esc closes the whole
// palette, the house rule, and Backspace in an empty field steps back.
import { useMemo, useState, type ReactNode } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { ArrowUpRight, Check, CornerUpRight, MessageSquareText, UserRound, UserRoundX, X } from "lucide-react";
import { toast } from "sonner";
import { rosterEscalationTargets, useInboxStore, type SessionDecisionItem } from "../../store/inboxStore";
import { windowOrgTree } from "../../store/orgSlice";
import { useTeamRosterIdentity } from "../../hooks/useTeamRoster";
import { useRolesAndPeopleOptions } from "../../hooks/useRolesAndPeopleOptions";
import { PaletteSearchBar } from "../PaletteRows";
import { KeyCap } from "../KeyCap";
import { groupClass, itemClass, paletteClass, paletteInputClass } from "../paletteStyles";
import { answerDecisions, assignDecisions, dismissDecisions, escalateDecisions, passDecisions, sharedAnswers, unassignDecisions } from "../../lib/decisions/decisionBulk";
import { isOpen, type DecisionOwner } from "../../lib/decisions/decisionRows";

type Step = "root" | "assign" | "answer" | "pass" | "pass_note" | "escalate";
const STEPS = new Set<string>(["root", "assign", "answer", "pass", "escalate"]);

const counted = (n: number) => `${n} ${n === 1 ? "decision" : "decisions"}`;

export function DecisionPalette({ targets, mode, standalone, onClose }: { targets: SessionDecisionItem[]; mode: string; standalone?: boolean; onClose: () => void }) {
  // A target is read live from the store, so a row answered elsewhere while the palette is open drops out of the count.
  const statusSig = useInboxStore((s) => targets.map((t) => s.sessionDecisions[t._id]?.status ?? t.status).join(","));
  const rows = useMemo(() => {
    const coll = useInboxStore.getState().sessionDecisions;
    return targets.map((t) => coll[t._id] ?? t).filter(isOpen);
  }, [targets, statusSig]); // eslint-disable-line react-hooks/exhaustive-deps -- the signature stands in for the rows
  const [step, setStep] = useState<Step>(STEPS.has(mode) ? (mode as Step) : "root");
  const [query, setQuery] = useState("");
  const [note, setNote] = useState("");
  const [passTo, setPassTo] = useState<DecisionOwner | null>(null);
  const roster = useTeamRosterIdentity();
  const { people, roles } = useRolesAndPeopleOptions(roster);
  const answers = useMemo(() => sharedAnswers(rows), [rows]);
  // Who an escalation reaches: each owner's manager, else the admins, as the store's escalateDecision picks them.
  const escalateTo = useMemo(() => {
    if (step !== "escalate") return [];
    const st = useInboxStore.getState();
    const me = String(st.currentUser?._id ?? "");
    const ids = new Set(rows.flatMap((d) => rosterEscalationTargets(d.holder?.kind === "user" ? d.holder.id : me, windowOrgTree(st)?.people, st.teamMembers, me)));
    return people.filter((p) => ids.has(p.key));
  }, [step, rows, people]);
  const label = rows.length === 1 ? rows[0].question : `${counted(rows.length)} selected`;

  const done = (msg: string) => { toast.success(msg); onClose(); };
  const go = (next: Step) => { setStep(next); setQuery(""); };
  const pickOwner = (to: DecisionOwner) => {
    if (step === "pass") { setPassTo(to); setStep("pass_note"); return; }
    const n = assignDecisions(rows, to);
    const name = (to.kind === "user" ? people : roles).find((p) => p.key === to.id)?.label ?? "a teammate";
    done(`Assigned ${counted(n)} to ${name}`);
  };

  const item = (key: string, icon: ReactNode, text: string, onSelect: () => void, value = text) => (
    <CommandPrimitive.Item key={key} value={value} onSelect={onSelect} className={itemClass} data-decision-palette-item={key}>
      {icon}<span className="flex-1 truncate">{text}</span>
    </CommandPrimitive.Item>
  );

  let body: ReactNode;
  if (step === "pass_note" || step === "escalate") {
    const send = () => {
      const text = note.trim();
      if (!text) return;
      const n = step === "escalate" ? escalateDecisions(rows, text) : passDecisions(rows, passTo!, text);
      done(step === "escalate" ? `Escalated ${counted(n)}` : `Passed ${counted(n)}`);
    };
    body = (
      <form className="p-3 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); send(); }} data-decision-palette-note={step}>
        <textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} rows={3}
          placeholder={step === "escalate" ? "Why it goes up" : "A note for them"}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            if (e.key === "Backspace" && !note) go(step === "escalate" ? "root" : "pass");
          }}
          className="w-full resize-none rounded-md bg-sol-bg-alt border border-sol-border/40 px-2.5 py-2 text-sm text-sol-text placeholder:text-sol-text-dim outline-none focus:border-sol-cyan/50" />
        <div className="flex items-center justify-end gap-2 text-xs text-sol-text-dim">
          {step === "escalate" && (
            <span className="mr-auto flex items-center gap-1.5 min-w-0" data-decision-palette-escalate-to>
              <ArrowUpRight className="w-3.5 h-3.5 flex-shrink-0" />
              {escalateTo.length ? escalateTo.map((p) => <span key={p.key} className="flex items-center gap-1 truncate"><span className="w-4 h-4 flex items-center justify-center">{p.face}</span>{p.label}</span>) : "Nobody to escalate to"}
            </span>
          )}
          <button type="submit" disabled={!note.trim() || (step === "escalate" && escalateTo.length === 0)} className="flex items-center gap-1.5 h-7 px-2.5 rounded-md border border-sol-cyan/40 text-sol-cyan disabled:opacity-40">
            {step === "escalate" ? "Escalate" : "Pass"} {counted(rows.length)}<KeyCap size="xs">↵</KeyCap>
          </button>
        </div>
      </form>
    );
  } else {
    const groups: ReactNode[] = [];
    if (step === "root") {
      groups.push(
        <CommandPrimitive.Group key="verbs" heading={counted(rows.length)} className={groupClass}>
          {item("assign", <UserRound className="w-4 h-4" />, "Assign to…", () => go("assign"))}
          {rows.some((d) => d.passed_to) && item("unassign", <UserRoundX className="w-4 h-4" />, "Unassign", () => done(`Unassigned ${counted(unassignDecisions(rows))}`))}
          {item("pass", <CornerUpRight className="w-4 h-4" />, "Pass with a note…", () => go("pass"))}
          {item("escalate", <ArrowUpRight className="w-4 h-4" />, "Escalate…", () => { setNote(""); setStep("escalate"); })}
          {answers.length > 0 && item("answer", <Check className="w-4 h-4" />, "Answer…", () => go("answer"))}
          {item("dismiss", <X className="w-4 h-4" />, "Dismiss", () => done(`Dismissed ${counted(dismissDecisions(rows))}`))}
        </CommandPrimitive.Group>,
      );
      // Typing an answer's name at the root offers it straight away.
      if (query.trim() && answers.length > 0) {
        groups.push(
          <CommandPrimitive.Group key="answers" heading="Answer" className={groupClass}>
            {answers.map((a) => item(`answer:${a}`, <MessageSquareText className="w-4 h-4" />, `Answer: ${a}`, () => done(`Answered ${counted(answerDecisions(rows, a))}: ${a}`)))}
          </CommandPrimitive.Group>,
        );
      }
    } else if (step === "answer") {
      groups.push(
        <CommandPrimitive.Group key="answers" heading="Answer every one with" className={groupClass}>
          {answers.map((a) => item(`answer:${a}`, <MessageSquareText className="w-4 h-4" />, a, () => done(`Answered ${counted(answerDecisions(rows, a))}: ${a}`)))}
        </CommandPrimitive.Group>,
      );
    } else {
      groups.push(
        <CommandPrimitive.Group key="people" heading="People" className={groupClass}>
          {people.map((p) => item(`user:${p.key}`, <span className="w-4 h-4 flex items-center justify-center">{p.face}</span>, p.label, () => pickOwner({ kind: "user", id: p.key }), `${p.label} ${p.key}`))}
        </CommandPrimitive.Group>,
        <CommandPrimitive.Group key="roles" heading="Roles" className={groupClass}>
          {roles.map((r) => item(`role:${r.key}`, <span className="w-4 h-4 flex items-center justify-center">{r.face}</span>, `${r.label} ${r.hint ?? ""}`.trim(), () => pickOwner({ kind: "role", id: r.key }), `${r.label} ${r.hint ?? ""} ${r.key}`))}
        </CommandPrimitive.Group>,
      );
    }
    body = (
      <>
        <PaletteSearchBar trailing={<KeyCap>Esc</KeyCap>}>
          <CommandPrimitive.Input value={query} onValueChange={setQuery} autoFocus className={paletteInputClass}
            placeholder={step === "root" ? "Do what with them…" : step === "answer" ? "Which answer…" : step === "pass" ? "Pass to whom…" : "Assign to whom…"}
            onKeyDown={(e) => { if (e.key === "Backspace" && !query && step !== "root") { e.preventDefault(); go("root"); } }} />
        </PaletteSearchBar>
        <CommandPrimitive.List className="max-h-[min(60vh,420px)] overflow-y-auto py-1.5">
          <CommandPrimitive.Empty className="py-6 text-center text-sm text-sol-text-dim">No match</CommandPrimitive.Empty>
          {groups}
        </CommandPrimitive.List>
      </>
    );
  }

  const content = (
    <CommandPrimitive className={paletteClass} loop shouldFilter={step !== "pass_note" && step !== "escalate"} data-decision-palette={step}>
      <div className="px-4 pt-3 pb-0"><div className="text-xs font-mono text-sol-text-dim truncate">{label}</div></div>
      {rows.length === 0 ? <div className="py-6 text-center text-sm text-sol-text-dim">None of these is open</div> : body}
    </CommandPrimitive>
  );
  if (standalone) return content;
  return (
    <div role="dialog" aria-modal="true" aria-label="Decision actions" className="fixed inset-0 z-[9999]">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-[2px]" onClick={onClose} />
      <div className="absolute inset-0 flex items-start justify-center pt-[min(20vh,160px)]">{content}</div>
    </div>
  );
}
