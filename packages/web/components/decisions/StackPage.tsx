"use client";

import { useMemo, useState } from "react";
import { ShortId } from "../ShortId";
import Link from "next/link";
import { ArrowLeft, ChevronDown, ChevronRight, Layers, ShieldCheck } from "lucide-react";
import { useInboxStore, type DecisionStackItem } from "../../store/inboxStore";
import { useSyncDecisionStacks } from "../../hooks/useSyncDecisionStacks";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { stackDue, sortStacksByDue } from "../../lib/decisionGroups";
import { AppLoader } from "../AppLoader";
import { StackChecklist } from "./StackChecklist";
import { StackPolicyEditor, useRoleName } from "./StackPolicy";
import { ShareControl } from "../ShareControl";
import "./decisions.css";

// The stack page (D5): title, progress, the policy controls (auto default
// after a deadline; a due; delegate to a role), and the checklist with
// reorder and remove. Reads the store's decisionStacks row (fed by
// listStacks, done ones included here so a cleared stack still opens).
export function StackPage({ id }: { id: string }) {
  const { ready } = useSyncDecisionStacks({ includeDone: true });
  const stack = useInboxStore((s) => s.decisionStacks[id] ?? Object.values(s.decisionStacks).find((st) => st.short_id === id));
  if (!stack) {
    if (ready) return <div className="p-8 text-center text-sol-text-dim">No such stack, or it is not yours to see.</div>;
    return <AppLoader />;
  }
  return <StackBody stack={stack} />;
}

function StackBody({ stack }: { stack: DecisionStackItem }) {
  const now = useCoarseNow(60_000);
  const due = stackDue(stack.policy, now);

  return (
    <div className="h-full overflow-y-auto decision-doc" data-main-scroll>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="flex items-center gap-3 text-[11px] text-sol-text-dim">
          <Link href="/decisions" className="inline-flex items-center gap-1 hover:text-sol-text transition-colors no-underline">
            <ArrowLeft className="w-3 h-3" /> The queue
          </Link>
        </div>
        <header className="mt-4">
          <div className="flex items-center gap-2 flex-wrap text-[11px] text-sol-text-dim">
            <span className="font-mono px-1.5 py-0.5 rounded border border-sol-border/60">{stack.short_id ?? "stack"}</span>
            <span className={`px-1.5 py-0.5 rounded border ${stack.status === "open" ? "border-sol-cyan/40 text-sol-cyan" : "border-sol-green/40 text-sol-green"}`}>{stack.status === "open" ? "open" : "done"}</span>
            <span>{stack.team_id ? "team stack" : "personal stack"}</span>
            {due && <span data-stack-due={due.overdue ? "overdue" : "due"} className={`px-1.5 py-0.5 rounded border ${due.overdue ? "border-sol-red/40 text-sol-red" : "border-sol-border text-sol-text-dim"}`}>{due.text}</span>}
            <ShareControl label="stack" path={`/decisions/stacks/${stack.short_id ?? stack._id}`} publicShare={{ kind: "stack", id: stack._id, token: (stack as any).share_token }} className="ml-auto" />
          </div>
          <h1 className="mt-3 decision-question text-sol-text flex items-center gap-3"><Layers className="w-6 h-6 text-sol-cyan shrink-0" />{stack.title}</h1>
        </header>

        <section className="mt-6 grid gap-3 sm:grid-cols-2">
          <StackPolicyEditor stack={stack} />
        </section>

        <section className="mt-8 mb-16">
          <h2 className="decision-kicker mb-3">Members · in order</h2>
          {stack.decision_ids.length === 0
            ? <div className="text-sm text-sol-text-dim">Empty. Group cards from the queue, or ask an agent to add its decisions to this stack.</div>
            : <StackChecklist stack={stack} editable />}
        </section>
      </div>
    </div>
  );
}

// ── The stacks index: /decisions/stacks (the-line.md L10) ──────────────────
// Open stacks first, overdue ones at the top; each with its title, progress
// (cleared of total), due and delegate; done stacks folded below. Reads the
// same decisionStacks store rows the queue and the stack page read.

const stackSig = (s: DecisionStackItem) => `${s.status}|${s.resolved}|${s.total}|${s.policy.due_at ?? ""}|${s.policy.delegate_role_id ?? ""}|${s.updated_at}|${s.title}`;
const newestFirst = (a: DecisionStackItem, b: DecisionStackItem) => (b.updated_at ?? 0) - (a.updated_at ?? 0);

export function StacksIndex() {
  const { ready } = useSyncDecisionStacks({ includeDone: true });
  const rows = useCollectionRows<DecisionStackItem>("decisionStacks", { sig: stackSig, sort: newestFirst });
  const now = useCoarseNow(60_000);
  const open = useMemo(() => sortStacksByDue(rows.filter((s) => s.status === "open"), now), [rows, now]);
  const done = useMemo(() => rows.filter((s) => s.status !== "open"), [rows]);
  const [showDone, setShowDone] = useState(false);

  return (
    <div className="h-full overflow-y-auto decision-doc" data-main-scroll>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <Link href="/decisions" className="inline-flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-text transition-colors no-underline">
          <ArrowLeft className="w-3 h-3" /> The queue
        </Link>
        <header className="mt-4 flex items-center gap-3 flex-wrap">
          <h1 className="text-lg text-sol-text flex items-center gap-2"><Layers className="w-5 h-5 text-sol-cyan" />Stacks</h1>
          <span className="text-[12px] text-sol-text-dim">{open.length} open{done.length ? ` · ${done.length} done` : ""}</span>
        </header>

        {!ready && rows.length === 0 && <div className="mt-8"><AppLoader /></div>}
        {ready && rows.length === 0 && (
          <div className="mt-10 text-sm text-sol-text-dim">No stacks yet. Group cards from the queue, or ask an agent to put related decisions in one stack.</div>
        )}

        {open.length > 0 && (
          <ul className="mt-5 space-y-2" data-stacks-open>
            {open.map((s) => <StackRow key={s._id} stack={s} now={now} />)}
          </ul>
        )}

        {done.length > 0 && (
          <section className="mt-8 mb-16">
            <button onClick={() => setShowDone((v) => !v)} className="flex items-center gap-2 text-[12px] text-sol-text-dim hover:text-sol-text">
              {showDone ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
              <span className="text-sol-text">Done</span>
              <span>{done.length}</span>
            </button>
            {showDone && (
              <ul className="mt-2 space-y-2" data-stacks-done>
                {done.map((s) => <StackRow key={s._id} stack={s} now={now} />)}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function StackRow({ stack, now }: { stack: DecisionStackItem; now: number }) {
  const due = stackDue(stack.policy, now);
  const delegate = useRoleName(stack.policy.delegate_role_id);
  const doneRow = stack.status !== "open";
  const pct = (stack.resolved / Math.max(1, stack.total)) * 100;
  return (
    <li data-stack-row={stack.short_id ?? stack._id}>
      <Link href={`/decisions/stacks/${stack.short_id ?? stack._id}`} className={`block rounded-lg border px-4 py-3 no-underline transition-colors ${doneRow ? "border-sol-border/40 hover:border-sol-border/70" : "border-sol-border/70 hover:border-sol-border bg-sol-card/40"}`}>
        <div className="flex items-center gap-2 flex-wrap text-[11px] text-sol-text-dim min-w-0">
          <ShortId id={stack.short_id} />
          <span className={`px-1.5 py-0.5 rounded border ${doneRow ? "border-sol-green/40 text-sol-green" : "border-sol-cyan/40 text-sol-cyan"}`}>{doneRow ? "done" : "open"}</span>
          {due && <span data-stack-due={due.overdue ? "overdue" : "due"} className={due.overdue ? "text-sol-red" : ""}>{due.text}</span>}
          {stack.policy.delegate_role_id && <span className="inline-flex items-center gap-1 text-sol-green"><ShieldCheck className="w-3 h-3" />{delegate.name}</span>}
          <span className="ml-auto">{formatTimeAgo(stack.updated_at, now)}</span>
        </div>
        <div className={`mt-1 text-[15px] leading-snug ${doneRow ? "text-sol-text-muted" : "text-sol-text"}`}>{stack.title}</div>
        <div className="mt-2 flex items-center gap-3 text-[11px] text-sol-text-dim">
          <span>{stack.resolved} of {stack.total} cleared</span>
          <div className="flex-1 min-w-[4rem] h-px bg-sol-border relative">
            <div className={`absolute inset-y-0 left-0 ${doneRow ? "bg-sol-green/60" : "bg-sol-cyan/70"}`} style={{ width: `${pct}%` }} />
          </div>
        </div>
      </Link>
    </li>
  );
}
