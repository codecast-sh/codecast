"use client";
// A session's goal, above the composer (convex sessionGoals.ts): the state as a
// chip, the objective, the round against its cap, and the controls that apply.
// Opening it shows the objective whole, the review's last finding and next
// step, and the loop's limits. Resume restarts agent turns with no person in
// each round, so it goes through the consequential review; pause and clear are
// one press, since stopping is the safe direction.
import { memo, useState } from "react";
import { ChevronDown, Pause, Play, X } from "lucide-react";
import { GOAL_IDLE_LIMIT_MS, goalCanPause, goalCanResume, type SessionGoal } from "@codecast/shared/contracts/sessionGoal";
import { useInboxStore } from "../store/inboxStore";
import { useSessionGoal } from "../hooks/useSessionGoal";
import { useWatchEffect } from "../hooks/useWatchEffect";
import { SwitchReview } from "./consequential/ConsequentialSwitch";
import { sessionGoalLedger } from "../lib/sessionGoalLedger";

const STATE: Record<Exclude<SessionGoal["status"], "cleared">, { label: string; chip: string; bar: string }> = {
  active: { label: "Goal", chip: "text-sol-cyan border-sol-cyan/40 bg-sol-cyan/10", bar: "border-l-sol-cyan/70" },
  paused: { label: "Paused", chip: "text-sol-yellow border-sol-yellow/40 bg-sol-yellow/10", bar: "border-l-sol-yellow/70" },
  blocked: { label: "Blocked", chip: "text-sol-orange border-sol-orange/40 bg-sol-orange/10", bar: "border-l-sol-orange/70" },
  done: { label: "Met", chip: "text-sol-green border-sol-green/40 bg-sol-green/10", bar: "border-l-sol-green/70" },
};

const BUTTON = "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-sol-text-muted hover:text-sol-text hover:bg-sol-bg-highlight transition-colors";

export const SessionGoalPill = memo(function SessionGoalPill({ conversationId, sessionTitle, canSteer }: { conversationId: string; sessionTitle: string; canSteer: boolean }) {
  const goal = useSessionGoal(conversationId);
  const [open, setOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  useWatchEffect(() => { setOpen(false); setReviewing(false); }, [conversationId]);
  if (!goal || goal.status === "cleared") return null;
  const s = STATE[goal.status];
  const store = useInboxStore.getState;
  const rows: Array<[string, string]> = [["Goal", goal.objective]];
  if (goal.reason) rows.push([goal.status === "active" ? "Missing" : goal.status === "done" ? "Evidence" : "Why", goal.reason]);
  if (goal.status === "active" && goal.next_step) rows.push(["Next", goal.next_step]);
  rows.push(["Limits", `${goal.max_rounds} rounds · ${goal.max_stalls} without progress · ${Math.round((goal.idle_limit_ms || GOAL_IDLE_LIMIT_MS) / 60_000)}m idle`]);

  return (
    <div className="relative z-20 bg-sol-bg pt-1.5" data-session-goal={goal.status}>
      <div className="mx-auto conv-col px-2 sm:px-4 pb-1.5">
        <div className={`rounded-xl border border-sol-border/40 border-l-2 ${s.bar} bg-sol-bg-alt/60 overflow-hidden`}>
          <div className="flex items-center gap-2 pl-3 pr-1.5 py-1.5">
            <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
              <span className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-[1px] rounded-full border text-[9px] font-semibold uppercase tracking-wide ${s.chip}`}>
                <span className="w-1.5 h-1.5 rounded-full bg-current" />
                {s.label}
              </span>
              <span className="min-w-[30%] flex-1 truncate text-[13px] font-medium text-sol-text" title={goal.objective}>{goal.objective}</span>
              {goal.status !== "active" && goal.reason && !open && (
                <span className="hidden min-w-0 max-w-[40%] shrink truncate text-[12px] text-sol-text-muted sm:inline" title={goal.reason}>{goal.reason}</span>
              )}
              <span className="shrink-0 tabular-nums text-[11px] text-sol-text-dim" title="Rounds delivered of the cap" data-goal-rounds>
                round {goal.rounds}/{goal.max_rounds}
              </span>
              {goal.stalls > 0 && (
                <span className="shrink-0 tabular-nums text-[11px] text-sol-yellow" title="Rounds without progress of the cap">
                  {goal.stalls}/{goal.max_stalls} stalled
                </span>
              )}
            </button>
            {canSteer && (
              <div className="flex shrink-0 items-center">
                {goalCanPause(goal) && (
                  <button type="button" className={BUTTON} onClick={() => store().pauseSessionGoal(conversationId)} data-goal-pause>
                    <Pause className="w-3 h-3" />Pause
                  </button>
                )}
                {goalCanResume(goal) && (
                  <button type="button" className={BUTTON} onClick={() => setReviewing(true)} aria-haspopup="dialog" data-goal-resume>
                    <Play className="w-3 h-3" />Resume
                  </button>
                )}
                <button type="button" className={`${BUTTON} hover:text-sol-red`} onClick={() => store().clearSessionGoal(conversationId)} aria-label="Clear the goal" data-goal-clear>
                  <X className="w-3 h-3" />Clear
                </button>
              </div>
            )}
            <button type="button" onClick={() => setOpen((o) => !o)} aria-label={open ? "Collapse" : "Expand"} className="p-1 rounded text-sol-text-dim hover:text-sol-text-muted hover:bg-sol-bg-highlight transition-colors">
              <ChevronDown className={`w-3 h-3 transition-transform duration-200 ${open ? "" : "-rotate-90"}`} strokeWidth={2.5} />
            </button>
          </div>
          {open && (
            <div className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 pb-2.5 text-[12.5px] leading-normal break-words">
              {rows.map(([k, v]) => (
                <div key={k} className="contents">
                  <span className="pt-px text-[11px] text-sol-text-dim">{k}</span>
                  <span className="whitespace-pre-wrap text-sol-text">{v}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {reviewing && (
        <SwitchReview
          ledger={sessionGoalLedger({ objective: goal.objective, session: sessionTitle, resume: true })}
          onClose={() => setReviewing(false)}
          onConfirm={() => { setReviewing(false); store().resumeSessionGoal(conversationId); }}
        />
      )}
    </div>
  );
});
