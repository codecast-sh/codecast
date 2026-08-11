"use client";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { useInboxStore, type TaskItem } from "../store/inboxStore";
import { resolveTaskCloseGuard } from "../lib/taskActions";

/**
 * The one close-guard dialog (panel decision 3), mounted once in
 * DashboardLayout and driven by the store's `taskCloseGuard`. Every human path
 * to done/dropped a parent with open subtasks routes through
 * closeTaskWithGuard, which sets that field; this renders the three-way choice.
 * It owns the keyboard while open so a key press can't reach an unguarded
 * close path behind it (Esc cancels, Enter cascades).
 */
export function GlobalCloseGuardDialog() {
  const guard = useInboxStore((s) => s.taskCloseGuard);
  const setGuard = useInboxStore((s) => s.setTaskCloseGuard);

  useWatchEffect(() => {
    if (!guard) return;
    const onKey = (e: KeyboardEvent) => {
      // Trap keys so `s`, Esc, Backspace etc. can't reach the surface behind.
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); setGuard(null); }
      else if (e.key === "Enter") { e.preventDefault(); resolveTaskCloseGuard("cascade"); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [guard, setGuard]);

  if (!guard) return null;
  const verb = guard.status === "done" ? "Close" : "Drop";
  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40" onClick={() => setGuard(null)}>
      <div className="w-[26rem] max-w-[90vw] rounded-lg border border-sol-border bg-sol-bg shadow-xl p-4" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-medium text-sol-text mb-1">
          {guard.open.length} open subtask{guard.open.length === 1 ? "" : "s"}
        </div>
        <div className="text-xs text-sol-text-muted mb-3">
          {verb}ing {guard.shortId} leaves {guard.open.length === 1 ? "it" : "these"} unfinished:
        </div>
        <div className="max-h-40 overflow-y-auto mb-4 space-y-1">
          {guard.open.map((t: TaskItem) => (
            <div key={t._id} className="flex items-center gap-2 text-xs">
              <span className="font-mono text-sol-text-dim">{t.short_id}</span>
              <span className="text-sol-text truncate">{t.title}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2">
          <button onClick={() => setGuard(null)} className="h-7 px-2.5 text-xs rounded-md border border-sol-border/40 text-sol-text-dim hover:text-sol-text transition-colors">
            Cancel
          </button>
          <button onClick={() => resolveTaskCloseGuard("only_parent")} className="h-7 px-2.5 text-xs rounded-md border border-sol-border/40 text-sol-text-muted hover:text-sol-text transition-colors">
            {verb} only this
          </button>
          <button autoFocus onClick={() => resolveTaskCloseGuard("cascade")} className="h-7 px-2.5 text-xs rounded-md border border-sol-cyan/40 bg-sol-cyan/10 text-sol-cyan hover:bg-sol-cyan/20 transition-colors">
            {verb} subtasks too
          </button>
        </div>
      </div>
    </div>
  );
}
