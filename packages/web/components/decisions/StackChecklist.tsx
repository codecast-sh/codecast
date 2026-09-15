"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { decisionAnswerLabel } from "@codecast/shared/contracts";
import { ArrowDown, ArrowUp, Check, ChevronLeft, ChevronRight, Layers, X } from "lucide-react";
import { useInboxStore, useTrackedStore, type DecisionStackItem, type SessionDecisionItem } from "../../store/inboxStore";
import { stackCursor, advisoryDefaults } from "../../lib/decisionGroups";
import { DecisionCompactCard } from "./DecisionCompactCard";
import { decisionHref } from "../../lib/decisionLinks";
import { KeyCap } from "../KeyboardShortcutsHelp";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useTabActive } from "../../hooks/usePagePresence";
import { hasOpenModal } from "../../shortcuts";

// A stack as a checklist (D5): the members in the stack's order, one of them
// current. Keys 1 to 9 answer the current member (its card claims them),
// n / p move next and previous, and "answer all defaults" resolves every
// advisory member with its declared default. Reorder and remove are the
// stack page's controls (`editable`).
export function StackChecklist({ stack, editable = false, keys = false }: { stack: DecisionStackItem; editable?: boolean; keys?: boolean }) {
  const s = useTrackedStore([
    (st) => stack.decision_ids.map((id) => `${id}:${st.sessionDecisions[id]?.status ?? "?"}`).join("|"),
  ]);
  const members = useMemo(
    () => stack.decision_ids.map((id) => s.sessionDecisions[id]).filter(Boolean) as SessionDecisionItem[],
    [stack.decision_ids, s.sessionDecisions],
  );
  const pendingIds = useMemo(() => new Set(members.filter((m) => m.status === "pending").map((m) => m._id)), [members]);
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const current = stackCursor(stack.decision_ids, pendingIds, cursorKey, 0);
  const move = useCallback((dir: 1 | -1) => setCursorKey(stackCursor(stack.decision_ids, pendingIds, current, dir)), [stack.decision_ids, pendingIds, current]);

  const answerDecision = useInboxStore((st) => st.answerDecision);
  const defaults = useMemo(() => advisoryDefaults(members), [members]);
  const answerAllDefaults = useCallback(() => {
    for (const d of defaults) answerDecision(d.id, { index: d.index });
    toast.success(`Answered ${defaults.length} with their defaults`);
  }, [defaults, answerDecision]);

  const paneActive = useTabActive();
  useWatchEffect(() => {
    if (!keys || !paneActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || hasOpenModal()) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || t.tagName === "SELECT")) return;
      if (e.key === "n" || e.key === "ArrowRight") { e.preventDefault(); move(1); }
      else if (e.key === "p" || e.key === "ArrowLeft") { e.preventDefault(); move(-1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [move, keys]);

  // Reorder and remove are store actions: the draft moves first (localFirst
  // protects the new order until the server echoes it) and the named side
  // effects reorderStack / removeFromStack do the server write.
  const reorderStack = useInboxStore((st) => st.reorderStack);
  const removeFromStack = useInboxStore((st) => st.removeFromStack);
  const reorder = useCallback((from: number, dir: -1 | 1) => {
    const ids = [...stack.decision_ids];
    const to = from + dir;
    if (to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    reorderStack(stack._id, ids);
  }, [stack._id, stack.decision_ids, reorderStack]);
  const remove = useCallback((id: string) => removeFromStack(stack._id, id), [stack._id, removeFromStack]);

  const done = members.filter((m) => m.status !== "pending").length;

  return (
    <div data-stack-checklist={stack.short_id ?? stack._id}>
      <div className="flex items-center gap-3 flex-wrap text-[11px] text-sol-text-dim mb-3">
        <span>{done} of {stack.decision_ids.length} cleared</span>
        <div className="flex-1 min-w-[6rem] h-px bg-sol-border relative">
          <div className="absolute inset-y-0 left-0 bg-sol-cyan/70" style={{ width: `${(done / Math.max(1, stack.decision_ids.length)) * 100}%` }} />
        </div>
        {pendingIds.size > 1 && (
          <>
            <button onClick={() => move(-1)} className="flex items-center gap-1 hover:text-sol-text"><KeyCap size="xs">p</KeyCap><ChevronLeft className="w-3 h-3" />previous</button>
            <button onClick={() => move(1)} className="flex items-center gap-1 hover:text-sol-text">next<ChevronRight className="w-3 h-3" /><KeyCap size="xs">n</KeyCap></button>
          </>
        )}
        {defaults.length > 0 && (
          <button onClick={answerAllDefaults} className="px-2 py-0.5 rounded border border-sol-blue/40 text-sol-blue hover:bg-sol-blue hover:text-sol-bg transition-colors">
            answer all {defaults.length} default{defaults.length === 1 ? "" : "s"}
          </button>
        )}
      </div>
      <ol className="space-y-2">
        {stack.decision_ids.map((id, i) => {
          const d = s.sessionDecisions[id];
          const isCurrent = id === current;
          const editRail = editable && (
            <div className="flex items-center gap-0.5 shrink-0">
              <button onClick={() => reorder(i, -1)} disabled={i === 0} className="p-1 rounded hover:bg-sol-card disabled:opacity-30" title="Move up"><ArrowUp className="w-3.5 h-3.5" /></button>
              <button onClick={() => reorder(i, 1)} disabled={i === stack.decision_ids.length - 1} className="p-1 rounded hover:bg-sol-card disabled:opacity-30" title="Move down"><ArrowDown className="w-3.5 h-3.5" /></button>
              <button onClick={() => remove(id)} className="p-1 rounded hover:bg-sol-card hover:text-sol-red" title="Remove from the stack"><X className="w-3.5 h-3.5" /></button>
            </div>
          );
          if (!d) {
            return (
              <li key={id} className="flex items-center gap-2 text-[12px] text-sol-text-dim px-3 py-2 rounded border border-dashed border-sol-border/60">
                <span className="font-mono w-5">{i + 1}.</span>
                <Link href={`/decisions/${id}`} className="hover:text-sol-text">a decision not in your queue</Link>
                <span className="ml-auto">{editRail}</span>
              </li>
            );
          }
          if (d.status !== "pending" || !isCurrent) {
            const resolved = d.status !== "pending";
            return (
              <li key={id} className={`flex items-center gap-2 text-[13px] px-3 py-2 rounded border ${resolved ? "border-sol-border/40 text-sol-text-dim" : "border-sol-border/70 text-sol-text-muted hover:border-sol-border cursor-pointer"}`} onClick={() => !resolved && setCursorKey(id)}>
                <span className="font-mono text-[11px] w-5 shrink-0">{i + 1}.</span>
                {resolved ? <Check className="w-3.5 h-3.5 text-sol-green shrink-0" /> : <span className="w-1.5 h-1.5 rounded-full bg-sol-yellow shrink-0" />}
                <Link href={decisionHref(d)} onClick={(e) => e.stopPropagation()} className={`min-w-0 flex-1 truncate ${resolved ? "line-through decoration-sol-border" : "hover:text-sol-text"}`}>{d.question}</Link>
                {resolved && d.status === "answered" && <span className="text-[11px] truncate max-w-[12rem]">{decisionAnswerLabel(d, d)}</span>}
                {editRail}
              </li>
            );
          }
          return (
            <li key={id} className="relative">
              <div className="absolute -left-3 top-3 hidden sm:block font-mono text-[11px] text-sol-cyan">{i + 1}.</div>
              <DecisionCompactCard decision={d} keys={keys} showTask />
              {editRail && <div className="mt-1 flex justify-end">{editRail}</div>}
            </li>
          );
        })}
      </ol>
      {pendingIds.size === 0 && stack.decision_ids.length > 0 && (
        <div className="mt-3 text-sm text-sol-green flex items-center gap-2"><Layers className="w-4 h-4" />This stack is cleared.</div>
      )}
    </div>
  );
}
