"use client";

import { useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import Link from "next/link";
import { ChevronDown, ChevronRight, Clock, Play, Pause, X } from "lucide-react";
import { describeTaskCadence, fmtDuration } from "./scheduleCadence";
import { ARMED_STATUSES, type TaskRow } from "./scheduleTasks";
import { useInboxStore } from "../store/inboxStore";
import { useCoarseNow } from "../hooks/useCoarseNow";

const api = _api as any;

// TaskRow + ARMED_STATUSES live in scheduleTasks.ts, shared with the inbox
// partition (standing rows / schedule group rows) so every schedule surface
// agrees on the payload shape and what counts as armed.

// The standing intent behind a session, surfaced where the user actually looks:
// a strip above the conversation (subHeaderContent, beside the plan/workflow
// panels). Shows what the schedule will do (title + full prompt), when
// (cadence + live countdown), what happened last (outcome + link to the last
// run), and the verbs that used to require a trip to /schedules (run now,
// pause/resume, cancel). Renders for the conversation a schedule injects into
// (originating), for any spawned run of it (agent_task_id / run uuid), and for
// the conversation that receives its summaries (target).
//
// Data: the same per-user agentTasks.webList subscription the sidebar badge and
// /schedules page use — Convex dedupes it, so this strip adds no query load.


export function ScheduleContextPanel({
  conversationId,
  sessionId,
  agentTaskId,
}: {
  conversationId: string;
  sessionId?: string | null;
  agentTaskId?: string | null;
}) {
  const tasks = useQuery(api.agentTasks.webList, {}) as TaskRow[] | undefined;
  const [expanded, setExpanded] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [busy, setBusy] = useState(false);

  const pause = useMutation(api.agentTasks.webPause);
  const resume = useMutation(api.agentTasks.webResume);
  const runNow = useMutation(api.agentTasks.webRunNow);
  const cancel = useMutation(api.agentTasks.webCancel);

  const matched = useMemo(() => {
    if (!tasks) return [] as TaskRow[];
    return tasks.filter(
      (t) =>
        (agentTaskId && t._id === agentTaskId) ||
        t.originating_conversation_id === conversationId ||
        t.target_conversation_id === conversationId ||
        t.last_run_conversation_id === conversationId ||
        (sessionId && t.last_run_session_uuid === sessionId)
    );
  }, [tasks, conversationId, sessionId, agentTaskId]);

  // Armed schedule with the soonest fire wins the strip. With nothing armed,
  // fall back ONLY to a schedule this conversation is a RUN of — that
  // provenance explains why the session exists, forever. A finished schedule
  // on its originating session shows nothing: the injected turns already
  // render inline, and a dead strip on a live session is noise.
  const primary = useMemo(() => {
    const armed = matched
      .filter((t) => ARMED_STATUSES.has(t.status))
      .sort((a, b) => (a.run_at ?? Infinity) - (b.run_at ?? Infinity));
    if (armed.length > 0) return armed[0];
    return matched
      .filter(
        (t) =>
          t.originating_conversation_id !== conversationId &&
          ((agentTaskId && t._id === agentTaskId) ||
            t.last_run_conversation_id === conversationId ||
            (!!sessionId && t.last_run_session_uuid === sessionId))
      )
      .sort((a, b) => (b.last_run_at ?? b.created_at) - (a.last_run_at ?? a.created_at))[0];
  }, [matched, conversationId, sessionId, agentTaskId]);

  // Coarse countdown clock — the shared 30s clock the ScheduleBadge cards ride
  // (one timer total, however many subscribers). Data churn re-renders are
  // separate (Convex subscription).
  const now = useCoarseNow(30_000);

  if (!primary) return null;

  const isRun = primary.originating_conversation_id !== conversationId &&
    (agentTaskId === primary._id ||
      primary.last_run_conversation_id === conversationId ||
      (!!sessionId && primary.last_run_session_uuid === sessionId));
  const cadence = describeTaskCadence(primary);
  const msUntil = primary.run_at !== undefined ? primary.run_at - now : undefined;
  const extraCount = matched.length - 1;

  const rightStatus = (() => {
    switch (primary.status) {
      case "scheduled":
        if (msUntil === undefined) return <span className="text-sol-orange">armed</span>;
        return (
          <span className="text-sol-orange tabular-nums">
            {msUntil > 0 ? `next in ${fmtDuration(msUntil)}` : "due now"}
          </span>
        );
      case "running":
        return (
          <span className="flex items-center gap-1 text-sol-green">
            <span className="w-1.5 h-1.5 rounded-full bg-sol-green animate-pulse" />
            running
          </span>
        );
      case "paused":
        return <span className="text-sol-text-dim">paused</span>;
      case "failed":
        return <span className="text-sol-red">failed</span>;
      default:
        return <span className="text-sol-text-dim">done</span>;
    }
  })();

  const act = async (fn: (args: { task_id: string }) => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await fn({ task_id: primary._id });
    } finally {
      setBusy(false);
      setConfirmingCancel(false);
    }
  };

  const actionBtn =
    "px-1.5 py-0.5 rounded border text-[10px] font-medium transition-colors disabled:opacity-50";

  return (
    <div className="border-b border-sol-border/30 bg-sol-bg-alt/20">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2 text-xs hover:bg-sol-bg-alt/40 transition-colors"
      >
        <Clock className="w-3.5 h-3.5 text-sol-orange flex-shrink-0" />
        <span className="font-medium text-sol-orange truncate">{primary.title}</span>
        <span className="text-sol-text-dim flex-shrink-0">{cadence}</span>
        {isRun && (
          <span className="px-1 py-0 rounded bg-sol-orange/10 border border-sol-orange/30 text-sol-orange text-[9px] font-semibold flex-shrink-0">
            run
          </span>
        )}
        <div className="flex items-center gap-1.5 ml-auto flex-shrink-0">
          {rightStatus}
          {expanded ? (
            <ChevronDown className="w-3 h-3 text-sol-text-dim" />
          ) : (
            <ChevronRight className="w-3 h-3 text-sol-text-dim" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-2 text-xs">
          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded border border-sol-border/30 bg-sol-bg/60 p-2 text-[11px] leading-relaxed text-sol-text-muted font-mono">
            {primary.prompt}
          </pre>

          <div className="flex items-center gap-2 flex-wrap text-[10px] text-sol-text-dim">
            <span
              className={`px-1 py-0 rounded border font-medium ${
                primary.mode === "apply"
                  ? "border-sol-red/40 text-sol-red/90 bg-sol-red/10"
                  : "border-sol-border/50 text-sol-text-dim"
              }`}
              title={primary.mode === "apply" ? "Agent may make changes" : "Read-only: agent proposes, never applies"}
            >
              {primary.mode === "apply" ? "apply" : "propose"}
            </span>
            {primary.run_count > 0 && (
              <span>
                {primary.run_count} run{primary.run_count === 1 ? "" : "s"}
              </span>
            )}
            {primary.last_run_at && (
              <span className={primary.last_run_failed ? "text-sol-red" : undefined}>
                last run {fmtDuration(Date.now() - primary.last_run_at)} ago
                {primary.last_run_failed ? " — failed" : ""}
              </span>
            )}
            {primary.last_run_conversation_id &&
              primary.last_run_conversation_id !== conversationId && (
                <button
                  onClick={() =>
                    useInboxStore
                      .getState()
                      .requestNavigate(primary.last_run_conversation_id!)
                  }
                  className="text-sol-cyan hover:underline"
                >
                  View last run
                </button>
              )}
          </div>

          {primary.last_run_summary && (
            <p className="text-[11px] text-sol-text-muted line-clamp-2" title={primary.last_run_summary}>
              {primary.last_run_summary}
            </p>
          )}

          <div className="flex items-center gap-1.5 pt-0.5">
            {ARMED_STATUSES.has(primary.status) && (
              <>
                <button
                  disabled={busy}
                  onClick={() => act(runNow)}
                  className={`${actionBtn} border-sol-cyan/40 text-sol-cyan hover:bg-sol-cyan/10`}
                >
                  <span className="inline-flex items-center gap-1">
                    <Play className="w-2.5 h-2.5" /> Run now
                  </span>
                </button>
                {primary.status === "paused" ? (
                  <button
                    disabled={busy}
                    onClick={() => act(resume)}
                    className={`${actionBtn} border-sol-orange/40 text-sol-orange hover:bg-sol-orange/10`}
                  >
                    Resume
                  </button>
                ) : (
                  <button
                    disabled={busy}
                    onClick={() => act(pause)}
                    className={`${actionBtn} border-sol-border/50 text-sol-text-dim hover:bg-sol-bg-alt/60`}
                  >
                    <span className="inline-flex items-center gap-1">
                      <Pause className="w-2.5 h-2.5" /> Pause
                    </span>
                  </button>
                )}
                {confirmingCancel ? (
                  <button
                    disabled={busy}
                    onClick={() => act(cancel)}
                    className={`${actionBtn} border-sol-red/50 text-sol-red bg-sol-red/10 hover:bg-sol-red/20`}
                  >
                    Confirm cancel
                  </button>
                ) : (
                  <button
                    disabled={busy}
                    onClick={() => setConfirmingCancel(true)}
                    className={`${actionBtn} border-sol-border/50 text-sol-text-dim hover:text-sol-red hover:border-sol-red/40`}
                  >
                    <span className="inline-flex items-center gap-1">
                      <X className="w-2.5 h-2.5" /> Cancel
                    </span>
                  </button>
                )}
              </>
            )}
            <span className="ml-auto flex items-center gap-2">
              {extraCount > 0 && (
                <span className="text-[10px] text-sol-text-dim">
                  +{extraCount} more schedule{extraCount === 1 ? "" : "s"}
                </span>
              )}
              <Link href="/schedules" className="text-[10px] text-sol-cyan hover:underline">
                Manage schedules
              </Link>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
