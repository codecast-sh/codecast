"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { CalendarClock, ShieldCheck, Timer } from "lucide-react";
import { useInboxStore, type DecisionStackItem, type StackPolicyPatch } from "../../store/inboxStore";
import { useQueryNoThrow } from "../../hooks/useQueryNoThrow";

const api = _api as any;

// A role's name for the delegate line. Enrichment: the row carries only the
// role id, and a missing brief degrades to "a role".
export function useRoleName(roleId: string | undefined): { name: string; href?: string } {
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

// A stack's three settings (D5): a due, an auto default for its advisory
// members, a role that answers for it. Drawn on the stack's page and behind
// the settings control on its group in the queue; `compact` leaves the
// explanations to the page.
export function StackPolicyEditor({ stack, compact = false }: { stack: DecisionStackItem; compact?: boolean }) {
  // One write path (the-line.md L10): the store action paints the policy on
  // the draft and the setStackPolicy side effect writes it. The server
  // answers through the listStacks feed; a refusal comes back as a toast.
  const setStackPolicy = useInboxStore((s) => s.setStackPolicy);
  const delegate = useRoleName(stack.policy.delegate_role_id);
  const hours = stack.policy.auto_default_after_ms ? Math.round(stack.policy.auto_default_after_ms / 3_600_000) : 0;
  const [hoursInput, setHoursInput] = useState(String(hours || ""));
  const [dueInput, setDueInput] = useState(() => toLocalInput(stack.policy.due_at));
  // The row is the truth: a due written on another device, or cleared by
  // the server, re-seeds the input.
  // eslint-disable-next-line no-restricted-syntax -- the box follows the row, so another device's write is not left stale
  useEffect(() => { setDueInput(toLocalInput(stack.policy.due_at)); }, [stack.policy.due_at]);
  // The hours field follows the row too, so a change from another device or
  // a server side clear does not leave a stale number in the box.
  // eslint-disable-next-line no-restricted-syntax -- same: the hours box follows the row
  useEffect(() => { setHoursInput(String(hours || "")); }, [hours]);
  const [delegateInput, setDelegateInput] = useState("");

  const write = useCallback(async (args: StackPolicyPatch, ok: string) => {
    // The draft paints at once; the toast waits for the server, which
    // refuses with { error } rather than throwing.
    try {
      const r = await setStackPolicy(stack._id, args);
      if (r?.error) toast.error(r.error);
      else toast.success(ok);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The stack did not save");
    }
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
    <>
      <div className={card}>
        <div className="flex items-center gap-2 text-[12px] text-sol-text"><CalendarClock className="w-3.5 h-3.5 text-sol-orange" />Due</div>
        {!compact && <p className="mt-1 text-[12px] text-sol-text-dim">When you mean to have cleared this stack. The queue shows it on the group and lists an overdue stack first.</p>}
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
        {!compact && <p className="mt-1 text-[12px] text-sol-text-dim">Advisory members answer with the agent's default after this many hours. Blocking members never auto answer.</p>}
        <div className="mt-2 flex items-center gap-2">
          <input type="number" min={0} value={hoursInput} onChange={(e) => setHoursInput(e.target.value)} placeholder="off" className={`${input} w-20 focus:border-sol-blue/50`} onKeyDown={(e) => { if (e.key === "Enter") saveHours(); }} />
          <span className="text-[12px] text-sol-text-dim">hours</span>
          <button onClick={saveHours} className={`ml-auto ${save.blue}`}>save</button>
        </div>
      </div>
      <div className={`${card} sm:col-span-2`}>
        <div className="flex items-center gap-2 text-[12px] text-sol-text"><ShieldCheck className="w-3.5 h-3.5 text-sol-green" />Delegate to a role</div>
        {compact ? stack.policy.delegate_role_id && (
          <p className="mt-1 text-[12px] text-sol-green">{delegate.href ? <Link href={delegate.href} className="hover:underline">{delegate.name}</Link> : delegate.name}</p>
        ) : (
          <p className="mt-1 text-[12px] text-sol-text-dim">
            {stack.policy.delegate_role_id
              ? <>Delegated to {delegate.href ? <Link href={delegate.href} className="text-sol-green hover:underline">{delegate.name}</Link> : delegate.name}: it answers every open category here for 30 days. Protected categories stay with you.</>
              : "The role answers every open category in this stack for 30 days. Protected categories stay with you."}
          </p>
        )}
        <div className="mt-2 flex items-center gap-2">
          <input value={delegateInput} onChange={(e) => setDelegateInput(e.target.value)} placeholder="@handle or or-N" className={`${input} flex-1 min-w-0 focus:border-sol-green/50`} onKeyDown={(e) => { if (e.key === "Enter") saveDelegate(); }} />
          <button onClick={saveDelegate} disabled={!delegateInput.trim()} className={save.green}>delegate</button>
        </div>
      </div>
    </>
  );
}
