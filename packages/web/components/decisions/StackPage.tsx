"use client";

import { useCallback, useState } from "react";
import Link from "next/link";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { ArrowLeft, Layers, ShieldCheck, Timer } from "lucide-react";
import { useInboxStore, type DecisionStackItem } from "../../store/inboxStore";
import { useSyncDecisionStacks } from "../../hooks/useSyncDecisionStacks";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";
import { AppLoader } from "../AppLoader";
import { StackChecklist } from "./StackChecklist";
import "./decisions.css";

const api = _api as any;

// The stack page (D5): title, progress, the policy controls (auto default
// after a deadline; delegate to a role), and the checklist with reorder and
// remove. Reads the store's decisionStacks row (fed by listStacks, done ones
// included here so a cleared stack still opens).
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
  const setPolicy = useMutation(api.decisionStacks.setStackPolicy);
  const { data: delegate } = useQueryNoThrow(api.org.brief, stack.policy.delegate_role_id ? { role_id: stack.policy.delegate_role_id } : "skip");
  const hours = stack.policy.auto_default_after_ms ? Math.round(stack.policy.auto_default_after_ms / 3_600_000) : 0;
  const [hoursInput, setHoursInput] = useState(String(hours || ""));
  const [delegateInput, setDelegateInput] = useState("");
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (args: Record<string, any>, ok: string) => {
    setBusy(true);
    try {
      const r = await setPolicy({ stack: stack._id, ...args });
      if (r?.error) toast.error(r.error);
      else toast.success(ok);
    } catch (e: any) {
      toast.error(e?.message ?? "Could not update the policy");
    } finally {
      setBusy(false);
    }
  }, [setPolicy, stack._id]);

  const saveHours = useCallback(() => {
    const h = Number(hoursInput);
    if (!hoursInput.trim() || h <= 0) return run({ clear_auto_default: true }, "Auto default off");
    return run({ auto_default_after_ms: h * 3_600_000 }, `Advisory members answer with their default after ${h}h`);
  }, [hoursInput, run]);
  const saveDelegate = useCallback(() => {
    const ref = delegateInput.trim().replace(/^@/, "");
    if (!ref) return;
    return run({ delegate: ref }, `Delegated to ${ref}`).then(() => setDelegateInput(""));
  }, [delegateInput, run]);

  return (
    <div className="h-full overflow-y-auto decision-doc" data-main-scroll>
      <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <Link href="/questions" className="inline-flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-text transition-colors no-underline">
          <ArrowLeft className="w-3 h-3" /> The queue
        </Link>
        <header className="mt-4">
          <div className="flex items-center gap-2 flex-wrap text-[11px] text-sol-text-dim">
            <span className="font-mono px-1.5 py-0.5 rounded border border-sol-border/60">{stack.short_id ?? "stack"}</span>
            <span className={`px-1.5 py-0.5 rounded border ${stack.status === "open" ? "border-sol-cyan/40 text-sol-cyan" : "border-sol-green/40 text-sol-green"}`}>{stack.status === "open" ? "open" : "done"}</span>
            <span>{stack.team_id ? "team stack" : "personal stack"}</span>
          </div>
          <h1 className="mt-3 decision-question text-sol-text flex items-center gap-3"><Layers className="w-6 h-6 text-sol-cyan shrink-0" />{stack.title}</h1>
        </header>

        <section className="mt-6 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-sol-border/70 bg-sol-card/40 p-3">
            <div className="flex items-center gap-2 text-[12px] text-sol-text"><Timer className="w-3.5 h-3.5 text-sol-blue" />Auto default</div>
            <p className="mt-1 text-[12px] text-sol-text-dim">Advisory members answer with the agent's default after this many hours. Blocking members never auto answer.</p>
            <div className="mt-2 flex items-center gap-2">
              <input type="number" min={0} value={hoursInput} onChange={(e) => setHoursInput(e.target.value)} placeholder="off" className="w-20 bg-sol-card border border-sol-border rounded px-2 py-1 text-sm text-sol-text focus:outline-none focus:border-sol-blue/50" />
              <span className="text-[12px] text-sol-text-dim">hours</span>
              <button onClick={saveHours} disabled={busy} className="ml-auto px-2.5 py-1 rounded border border-sol-blue/40 text-[12px] text-sol-blue hover:bg-sol-blue hover:text-sol-bg transition-colors disabled:opacity-40">save</button>
            </div>
          </div>
          <div className="rounded-lg border border-sol-border/70 bg-sol-card/40 p-3">
            <div className="flex items-center gap-2 text-[12px] text-sol-text"><ShieldCheck className="w-3.5 h-3.5 text-sol-green" />Delegate to a role</div>
            <p className="mt-1 text-[12px] text-sol-text-dim">
              {delegate?.role
                ? <>Delegated to <Link href={`/org/${delegate.role.short_id ?? delegate.role._id}`} className="text-sol-green hover:underline">{delegate.role.name}</Link>: it answers every open category here for 30 days. Protected categories stay with you.</>
                : "The role answers every open category in this stack for 30 days. Protected categories stay with you."}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <input value={delegateInput} onChange={(e) => setDelegateInput(e.target.value)} placeholder="@handle or or-N" className="flex-1 min-w-0 bg-sol-card border border-sol-border rounded px-2 py-1 text-sm text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-green/50" onKeyDown={(e) => { if (e.key === "Enter") void saveDelegate(); }} />
              <button onClick={saveDelegate} disabled={busy || !delegateInput.trim()} className="px-2.5 py-1 rounded border border-sol-green/40 text-[12px] text-sol-green hover:bg-sol-green hover:text-sol-bg transition-colors disabled:opacity-40">delegate</button>
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
