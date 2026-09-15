"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { ArrowLeft, CalendarClock, ChevronDown, ChevronRight, Layers, ShieldCheck, Timer } from "lucide-react";
import { useInboxStore, type DecisionStackItem, type StackPolicyPatch } from "../../store/inboxStore";
import { useSyncDecisionStacks } from "../../hooks/useSyncDecisionStacks";
import { useCollectionRows } from "../../hooks/useCollectionRows";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { formatTimeAgo } from "../../lib/messageNavigator";
import { stackDue, sortStacksByDue } from "../../lib/decisionGroups";
import { AppLoader } from "../AppLoader";
import { StackChecklist } from "./StackChecklist";
import "./decisions.css";

const api = _api as any;

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

// A role's name for the delegate line. Enrichment: the row carries only the
// role id, and a missing brief degrades to "a role".
function useRoleName(roleId: string | undefined): { name: string; href?: string } {
  const { data } = useQueryNoThrow(api.org.brief, roleId ? { role_id: roleId } : "skip");
  const role = data?.role;
  return role ? { name: role.name, href: `/org/${role.short_id ?? role._id}` } : { name: "a role" };
}

// datetime-local wants local wall time without a zone; the policy stores
// unix milliseconds. Both directions here so the input and the row agree.
function toLocalInput(ms: number | undefined): string {
  if (!ms) return "";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function StackBody({ stack }: { stack: DecisionStackItem }) {
  // One write path (the-line.md L10): the store action paints the policy on
  // the draft and the setStackPolicy side effect writes it. The server
  // answers through the listStacks feed; a refusal comes back as a toast.
  const setStackPolicy = useInboxStore((s) => s.setStackPolicy);
  const delegate = useRoleName(stack.policy.delegate_role_id);
  const now = useCoarseNow(60_000);
  const due = stackDue(stack.policy, now);
  const hours = stack.policy.auto_default_after_ms ? Math.round(stack.policy.auto_default_after_ms / 3_600_000) : 0;
  const [hoursInput, setHoursInput] = useState(String(hours || ""));
  const [dueInput, setDueInput] = useState(() => toLocalInput(stack.policy.due_at));
  const [delegateInput, setDelegateInput] = useState("");

  const write = useCallback((args: StackPolicyPatch, ok: string) => {
    setStackPolicy(stack._id, args);
    toast.success(ok);
  }, [setStackPolicy, stack._id]);

  const saveHours = useCallback(() => {
    const h = Number(hoursInput);
    if (!hoursInput.trim() || h <= 0) return write({ clear_auto_default: true }, "Auto default off");
    write({ auto_default_after_ms: h * 3_600_000 }, `Advisory members answer with their default after ${h}h`);
  }, [hoursInput, write]);
  const saveDue = useCallback(() => {
    if (!dueInput.trim()) return write({ clear_due: true }, "Due cleared");
    const at = new Date(dueInput).getTime();
    if (!Number.isFinite(at)) return toast.error("That is not a date");
    write({ due_at: at }, `Due ${new Date(at).toLocaleString()}`);
  }, [dueInput, write]);
  const clearDue = useCallback(() => { setDueInput(""); write({ clear_due: true }, "Due cleared"); }, [write]);
  const saveDelegate = useCallback(() => {
    const ref = delegateInput.trim().replace(/^@/, "");
    if (!ref) return;
    write({ delegate: ref }, `Delegated to ${ref}`);
    setDelegateInput("");
  }, [delegateInput, write]);

  const card = "rounded-lg border border-sol-border/70 bg-sol-card/40 p-3";
  const input = "bg-sol-card border border-sol-border rounded px-2 py-1 text-sm text-sol-text placeholder:text-sol-text-dim focus:outline-none";
  // Whole class strings, so the css scanner sees each one.
  const saveBtn = "px-2.5 py-1 rounded border text-[12px] transition-colors disabled:opacity-40 hover:text-sol-bg";
  const save = {
    orange: `${saveBtn} border-sol-orange/40 text-sol-orange hover:bg-sol-orange`,
    blue: `${saveBtn} border-sol-blue/40 text-sol-blue hover:bg-sol-blue`,
    green: `${saveBtn} border-sol-green/40 text-sol-green hover:bg-sol-green`,
  };

  return (
    <div className="h-full overflow-y-auto decision-doc" data-main-scroll>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="flex items-center gap-3 text-[11px] text-sol-text-dim">
          <Link href="/decisions/stacks" className="inline-flex items-center gap-1 hover:text-sol-text transition-colors no-underline">
            <ArrowLeft className="w-3 h-3" /> All stacks
          </Link>
          <Link href="/questions" className="hover:text-sol-text transition-colors no-underline">The queue</Link>
        </div>
        <header className="mt-4">
          <div className="flex items-center gap-2 flex-wrap text-[11px] text-sol-text-dim">
            <span className="font-mono px-1.5 py-0.5 rounded border border-sol-border/60">{stack.short_id ?? "stack"}</span>
            <span className={`px-1.5 py-0.5 rounded border ${stack.status === "open" ? "border-sol-cyan/40 text-sol-cyan" : "border-sol-green/40 text-sol-green"}`}>{stack.status === "open" ? "open" : "done"}</span>
            <span>{stack.team_id ? "team stack" : "personal stack"}</span>
            {due && <span data-stack-due={due.overdue ? "overdue" : "due"} className={`px-1.5 py-0.5 rounded border ${due.overdue ? "border-sol-red/40 text-sol-red" : "border-sol-border text-sol-text-dim"}`}>{due.text}</span>}
          </div>
          <h1 className="mt-3 decision-question text-sol-text flex items-center gap-3"><Layers className="w-6 h-6 text-sol-cyan shrink-0" />{stack.title}</h1>
        </header>

        <section className="mt-6 grid gap-3 sm:grid-cols-2">
          <div className={card}>
            <div className="flex items-center gap-2 text-[12px] text-sol-text"><CalendarClock className="w-3.5 h-3.5 text-sol-orange" />Due</div>
            <p className="mt-1 text-[12px] text-sol-text-dim">When you mean to have cleared this stack. The queue shows it on the group and lists an overdue stack first.</p>
            <div className="mt-2 flex items-center gap-2 flex-wrap">
              <input
                type="datetime-local"
                value={dueInput}
                onChange={(e) => setDueInput(e.target.value)}
                data-stack-due-input
                className={`${input} focus:border-sol-orange/50 min-w-0 flex-1`}
                onKeyDown={(e) => { if (e.key === "Enter") saveDue(); }}
              />
              {stack.policy.due_at && (
                <button onClick={clearDue} className="text-[12px] text-sol-text-dim hover:text-sol-red transition-colors">clear</button>
              )}
              <button onClick={saveDue} disabled={!dueInput.trim() && !stack.policy.due_at} className={save.orange}>save</button>
            </div>
          </div>
          <div className={card}>
            <div className="flex items-center gap-2 text-[12px] text-sol-text"><Timer className="w-3.5 h-3.5 text-sol-blue" />Auto default</div>
            <p className="mt-1 text-[12px] text-sol-text-dim">Advisory members answer with the agent's default after this many hours. Blocking members never auto answer.</p>
            <div className="mt-2 flex items-center gap-2">
              <input type="number" min={0} value={hoursInput} onChange={(e) => setHoursInput(e.target.value)} placeholder="off" className={`${input} w-20 focus:border-sol-blue/50`} onKeyDown={(e) => { if (e.key === "Enter") saveHours(); }} />
              <span className="text-[12px] text-sol-text-dim">hours</span>
              <button onClick={saveHours} className={`ml-auto ${save.blue}`}>save</button>
            </div>
          </div>
          <div className={`${card} sm:col-span-2`}>
            <div className="flex items-center gap-2 text-[12px] text-sol-text"><ShieldCheck className="w-3.5 h-3.5 text-sol-green" />Delegate to a role</div>
            <p className="mt-1 text-[12px] text-sol-text-dim">
              {stack.policy.delegate_role_id
                ? <>Delegated to {delegate.href ? <Link href={delegate.href} className="text-sol-green hover:underline">{delegate.name}</Link> : delegate.name}: it answers every open category here for 30 days. Protected categories stay with you.</>
                : "The role answers every open category in this stack for 30 days. Protected categories stay with you."}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input value={delegateInput} onChange={(e) => setDelegateInput(e.target.value)} placeholder="@handle or or-N" className={`${input} flex-1 min-w-0 focus:border-sol-green/50`} onKeyDown={(e) => { if (e.key === "Enter") saveDelegate(); }} />
              <button onClick={saveDelegate} disabled={!delegateInput.trim()} className={save.green}>delegate</button>
            </div>
          </div>
        </section>

        <section className="mt-8 mb-16">
          <h2 className="decision-kicker mb-3">Members · in order</h2>
          {stack.decision_ids.length === 0
            ? <div className="text-sm text-sol-text-dim">Empty. Add with <code className="text-sol-text">cast decide --stack {stack.short_id}</code> or group cards from the queue.</div>
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
        <Link href="/questions" className="inline-flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-text transition-colors no-underline">
          <ArrowLeft className="w-3 h-3" /> The queue
        </Link>
        <header className="mt-4 flex items-center gap-3 flex-wrap">
          <h1 className="text-lg text-sol-text flex items-center gap-2"><Layers className="w-5 h-5 text-sol-cyan" />Stacks</h1>
          <span className="text-[12px] text-sol-text-dim">{open.length} open{done.length ? ` · ${done.length} done` : ""}</span>
        </header>

        {!ready && rows.length === 0 && <div className="mt-8"><AppLoader /></div>}
        {ready && rows.length === 0 && (
          <div className="mt-10 text-sm text-sol-text-dim">No stacks yet. Group cards from the queue, or <code className="text-sol-text">cast decide --stack "Launch checklist"</code>.</div>
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
          <span className="font-mono">{stack.short_id}</span>
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
