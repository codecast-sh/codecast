"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  Pause,
  Play,
  X,
  XCircle,
} from "lucide-react";
import { describeTaskCadence, fmtClock, fmtDuration, taskStateLabel } from "./scheduleCadence";
import { ShortcutTooltip } from "./KeyboardShortcutsHelp";
import { ARMED_STATUSES, taskDisplayTitle, type TaskRow } from "./scheduleTasks";
import { useInboxStore } from "../store/inboxStore";
import { useCoarseNow } from "../hooks/useCoarseNow";

const api = _api as any;

// Raw titles are often a 60-char prompt slice that dies mid-parenthetical
// ("Post-deploy sensor check for budget/cluster fixes (sha 9ee76"). When no
// Haiku display_title exists, at least drop the dangling fragment.
function cleanTitle(title: string): string {
  const stripped = title.replace(/\s*\([^)]*$/, "").trim();
  return stripped.length >= 12 ? stripped : title;
}

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
  // Arrive expanded when the navigation came FROM a schedule surface (dock row,
  // row under a card): the click meant "show me this schedule", so the strip
  // opens without a second click. Subscribed (not a one-shot mount read) so the
  // click also works when the conversation is ALREADY active — no remount
  // happens then, and this used to make the click a silent no-op. The nonce
  // makes repeat clicks re-fire; clearing after consumption keeps a later
  // revisit from re-expanding a strip the user collapsed.
  const stripReq = useInboxStore((s) => s.scheduleStripExpand);
  const [expanded, setExpanded] = useState(() => {
    const req = useInboxStore.getState().scheduleStripExpand;
    return !!req && req.convId === conversationId;
  });
  useEffect(() => {
    if (stripReq && stripReq.convId === conversationId) {
      setExpanded(true);
      useInboxStore.getState().setScheduleStripExpand(null);
    }
  }, [stripReq, conversationId]);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const [briefOpen, setBriefOpen] = useState(false);
  const [lastRunOpen, setLastRunOpen] = useState(false);
  const [othersOpen, setOthersOpen] = useState(false);
  // User override of the auto-picked schedule, via the "+N more" switcher.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pause = useMutation(api.agentTasks.webPause);
  const resume = useMutation(api.agentTasks.webResume);
  const runNow = useMutation(api.agentTasks.webRunNow);
  const cancel = useMutation(api.agentTasks.webCancel);
  const regenerateSummary = useMutation(api.agentTasks.webRegenerateSummary);
  // Fire-and-forget: the Haiku distillation lands through the webList
  // subscription, at which point the briefing swaps in and the button goes.
  const [summarizing, setSummarizing] = useState(false);

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
  const autoPrimary = useMemo(() => {
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

  // The switcher override wins while its schedule still matches; a stale
  // selection (schedule finished/cancelled out of `matched`) falls back.
  const primary =
    (selectedId && matched.find((t) => t._id === selectedId)) || autoPrimary;

  // All per-schedule transient state dies when the displayed schedule changes
  // — however it changes (switcher click OR reactive re-pick). Without this an
  // armed "Confirm cancel" could survive a swap and cancel the wrong schedule.
  const primaryId = primary?._id;
  useEffect(() => {
    setConfirmingCancel(false);
    setShowPrompt(false);
    setBriefOpen(false);
    setLastRunOpen(false);
    setSummarizing(false);
  }, [primaryId]);

  // Coarse countdown clock — the shared 30s clock the ScheduleBadge cards ride
  // (one timer total, however many subscribers). Data churn re-renders are
  // separate (Convex subscription).
  const now = useCoarseNow(30_000);

  // Every spawned run of this schedule, newest first — server-joined on the
  // sparse by_agent_task index, so folded/aged-out runs the inbox no longer
  // syncs are still browseable here.
  const runs = useQuery(
    api.agentTasks.webListRuns,
    primary ? { task_id: primary._id } : "skip"
  ) as { _id: string; short_id?: string; title: string; created_at: number; idle_summary?: string }[] | undefined;

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
        // taskStateLabel keeps the wording in lockstep with the inbox rows —
        // including the "due 12m" stuck-signal once a fire sits unclaimed.
        return (
          <span className="text-sol-orange tabular-nums">
            {msUntil > 0 ? `next ${taskStateLabel(primary, now)}` : taskStateLabel(primary, now)}
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
        return (
          <span className="text-sol-text-dim">
            done
            {primary.last_run_at ? ` · ran ${fmtDuration(Math.max(0, now - primary.last_run_at))} ago` : ""}
          </span>
        );
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

  const copyPrompt = () => {
    navigator.clipboard.writeText(primary.prompt).then(() => {
      setPromptCopied(true);
      setTimeout(() => setPromptCopied(false), 1500);
    });
  };

  // Last-run outcome tone: the row's icon + wording follow the run's flags.
  const outcome = primary.last_run_failed
    ? { Icon: XCircle, tone: "text-sol-red", word: "failed" }
    : primary.last_run_needs_attention
      ? { Icon: AlertTriangle, tone: "text-sol-orange", word: "needs attention" }
      : { Icon: CheckCircle2, tone: "text-sol-green", word: null };

  const actionBtn =
    "px-2 py-1 rounded-md border text-[11px] font-medium transition-[color,background-color,transform] duration-100 active:scale-[0.97] disabled:opacity-50 disabled:active:scale-100";

  return (
    <div className="border-b border-sol-border/30 bg-sol-bg-alt/20">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2 text-xs hover:bg-sol-bg-alt/40 transition-colors"
      >
        <Clock className="w-3.5 h-3.5 text-sol-orange flex-shrink-0" />
        <ShortcutTooltip label={taskDisplayTitle(primary)}>
          <span className="font-medium text-sol-orange truncate">{cleanTitle(taskDisplayTitle(primary))}</span>
        </ShortcutTooltip>
        {/* Health at a glance while collapsed: only bad outcomes earn a dot. */}
        {(primary.last_run_failed || primary.last_run_needs_attention) && (
          <ShortcutTooltip label={`Last run ${primary.last_run_failed ? "failed" : "needs attention"}`}>
            <span
              className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                primary.last_run_failed ? "bg-sol-red" : "bg-sol-orange"
              }`}
            />
          </ShortcutTooltip>
        )}
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

      {/* Run history: every spawned run as a browseable chip, newest first.
          Rendered outside the expander — browsing runs is the point of the
          strip on a run's page and shouldn't cost a click. Hidden when the
          only run is the one being viewed (a one-chip strip says nothing). */}
      {runs && (runs.length > 1 || (runs.length === 1 && runs[0]._id !== conversationId)) && (
        <div className="flex items-center gap-1.5 px-4 pb-2 overflow-x-auto">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-sol-text-dim/70 shrink-0">
            {runs.length} run{runs.length === 1 ? "" : "s"}
          </span>
          {runs.map((r, i) => {
            const isCurrent = r._id === conversationId;
            const label = `#${runs.length - i} · ${fmtDuration(Math.max(0, now - r.created_at))} ago`;
            const tooltip = r.idle_summary ? `${r.title} — ${r.idle_summary}` : r.title;
            return isCurrent ? (
              <ShortcutTooltip key={r._id} label={tooltip} hint="this session">
                <span className="px-1.5 py-0.5 rounded border border-sol-orange/50 bg-sol-orange/10 text-sol-orange text-[10px] font-mono shrink-0">
                  {label}
                </span>
              </ShortcutTooltip>
            ) : (
              <ShortcutTooltip key={r._id} label={tooltip}>
                <button
                  // navigateToSession, not requestNavigate: it resolves folded
                  // (dismissed) runs through the view-only path instead of
                  // parking on pendingNavigateId, and commits the switch so the
                  // tab shell doesn't re-assert the old ?s= session.
                  onClick={() => useInboxStore.getState().navigateToSession(r._id)}
                  className="px-1.5 py-0.5 rounded border border-sol-border/50 text-sol-text-dim text-[10px] font-mono shrink-0 hover:text-sol-cyan hover:border-sol-cyan/40 transition-colors"
                >
                  {label}
                </button>
              </ShortcutTooltip>
            );
          })}
        </div>
      )}

      {expanded && (
        <div className="px-4 pb-3 space-y-2.5 text-xs animate-in fade-in slide-in-from-top-1 duration-150">
          {/* What this schedule does, in plain words (the Haiku-distilled
              display_summary). The raw prompt is the contract, not the
              briefing — it stays one click away below. The clamp keeps a
              missing summary (raw prompt fallback) from becoming a wall. */}
          {(() => {
            const brief = primary.display_summary?.trim() || primary.prompt;
            // Click-to-expand only when the clamp can actually bite (~3 lines
            // at this measure); a pointer cursor on short text is a dead click.
            const clampable = brief.length > 240;
            const para = (
              <p
                onClick={clampable ? () => setBriefOpen((s) => !s) : undefined}
                className={`max-w-[110ch] text-[12px] leading-relaxed text-sol-text ${
                  clampable ? "cursor-pointer" : ""
                } ${briefOpen ? "" : "line-clamp-3"}`}
              >
                {brief}
              </p>
            );
            if (!clampable || briefOpen) return para;
            return <ShortcutTooltip label="Click to expand">{para}</ShortcutTooltip>;
          })()}

          <div className="flex items-center gap-3">
            <button
              onClick={() => setShowPrompt((s) => !s)}
              className="flex items-center gap-1 text-[10px] text-sol-text-dim hover:text-sol-text transition-colors"
            >
              {showPrompt ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              {showPrompt ? "Hide full prompt" : "Show full prompt"}
            </button>
            {showPrompt && (
              <button
                onClick={copyPrompt}
                className="flex items-center gap-1 text-[10px] text-sol-text-dim hover:text-sol-text transition-colors"
              >
                {promptCopied ? <Check className="w-3 h-3 text-sol-green" /> : <Copy className="w-3 h-3" />}
                {promptCopied ? "Copied" : "Copy"}
              </button>
            )}
            {!primary.display_summary?.trim() && (
              <ShortcutTooltip label="Distill the prompt above into a short plain-words briefing">
                <button
                  disabled={summarizing}
                  onClick={() => {
                    setSummarizing(true);
                    regenerateSummary({ task_id: primary._id }).catch(() => setSummarizing(false));
                  }}
                  className="flex items-center gap-1 text-[10px] text-sol-text-dim hover:text-sol-text transition-colors disabled:opacity-60"
                >
                  {summarizing ? "Summarizing…" : "Summarize"}
                </button>
              </ShortcutTooltip>
            )}
          </div>
          {showPrompt && (
            <pre className="max-w-[110ch] max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded border border-sol-border/30 bg-sol-bg/60 p-2.5 text-[11px] leading-relaxed text-sol-text-muted font-mono">
              {primary.prompt}
            </pre>
          )}

          <div className="flex items-center gap-3 flex-wrap text-[10px] text-sol-text-dim">
            <span className="inline-flex items-center gap-1.5">
              {cadence}
              {/* Where we are in the current cycle: fills as the next fire approaches. */}
              {primary.schedule_type === "recurring" &&
                primary.interval_ms !== undefined &&
                msUntil !== undefined && (
                  <ShortcutTooltip label={`${Math.round(Math.min(1, Math.max(0, 1 - msUntil / primary.interval_ms)) * 100)}% through the ${fmtDuration(primary.interval_ms)} cycle`}>
                    <span className="inline-block w-16 h-1 rounded-full bg-sol-bg-highlight overflow-hidden">
                      <span
                        className="block h-full rounded-full bg-sol-orange/70"
                        style={{
                          width: `${Math.round(Math.min(1, Math.max(0, 1 - msUntil / primary.interval_ms)) * 100)}%`,
                        }}
                      />
                    </span>
                  </ShortcutTooltip>
                )}
            </span>
            {primary.status === "scheduled" && primary.run_at !== undefined && (
              <ShortcutTooltip label={new Date(primary.run_at).toLocaleString()}>
                <span className="tabular-nums">next at {fmtClock(primary.run_at)}</span>
              </ShortcutTooltip>
            )}
            <ShortcutTooltip
              label={
                primary.mode === "apply"
                  ? "apply mode: runs may change things — edit files, run write commands"
                  : "propose mode: runs are read-only — the agent investigates and reports, changes nothing"
              }
              hint={primary.mode === "apply" ? "propose is the read-only default" : "default"}
            >
              <span
                className={`px-1.5 py-px rounded border font-medium ${
                  primary.mode === "apply"
                    ? "border-sol-red/40 text-sol-red/90 bg-sol-red/10"
                    : "border-sol-border/50 text-sol-text-dim"
                }`}
              >
                {primary.mode === "apply" ? "apply" : "propose"}
              </span>
            </ShortcutTooltip>
          </div>

          {(primary.last_run_at || primary.last_run_summary) && (
            <div
              className={`rounded border border-sol-border/30 border-l-2 bg-sol-bg/40 px-2.5 py-2 space-y-1 ${
                primary.last_run_failed
                  ? "border-l-sol-red/60"
                  : primary.last_run_needs_attention
                    ? "border-l-sol-orange/60"
                    : "border-l-sol-green/50"
              }`}
            >
              <div className="flex items-center gap-1.5 text-[10px]">
                <outcome.Icon className={`w-3 h-3 flex-shrink-0 ${outcome.tone}`} />
                <span className="font-semibold uppercase tracking-wider text-sol-text-dim/70">
                  Last run
                </span>
                {primary.last_run_at && (
                  <ShortcutTooltip label={new Date(primary.last_run_at).toLocaleString()}>
                    <span className="text-sol-text-dim tabular-nums">
                      {fmtDuration(Math.max(0, now - primary.last_run_at))} ago
                    </span>
                  </ShortcutTooltip>
                )}
                {outcome.word && (
                  <span className={`font-medium ${outcome.tone}`}>{outcome.word}</span>
                )}
                {/* Manual re-runs create run conversations without bumping
                    run_count — trust the larger of the two, and stay silent
                    when the chips row above already states the count. */}
                {(() => {
                  const total = Math.max(primary.run_count, runs?.length ?? 0);
                  if (total === 0 || (runs?.length ?? 0) > 1) return null;
                  return (
                    <span className="text-sol-text-dim/70">
                      · {total} run{total === 1 ? "" : "s"} total
                    </span>
                  );
                })()}
                {primary.last_run_conversation_id &&
                  primary.last_run_conversation_id !== conversationId && (
                    <button
                      onClick={() =>
                        useInboxStore
                          .getState()
                          .requestNavigate(primary.last_run_conversation_id!)
                      }
                      className="ml-auto inline-flex items-center gap-0.5 text-sol-cyan hover:underline"
                    >
                      Open run <ArrowUpRight className="w-3 h-3" />
                    </button>
                  )}
              </div>
              {primary.last_run_summary && (() => {
                const clampable = primary.last_run_summary.length > 160;
                const para = (
                  <p
                    onClick={clampable ? () => setLastRunOpen((s) => !s) : undefined}
                    className={`max-w-[110ch] text-[11px] leading-relaxed text-sol-text-muted transition-colors ${
                      clampable ? "cursor-pointer hover:text-sol-text" : ""
                    } ${lastRunOpen ? "" : "line-clamp-2"}`}
                  >
                    {primary.last_run_summary}
                  </p>
                );
                if (!clampable) return para;
                return <ShortcutTooltip label={lastRunOpen ? "Click to collapse" : "Click to expand"}>{para}</ShortcutTooltip>;
              })()}
            </div>
          )}

          <div className="flex items-center gap-1.5 pt-0.5 flex-wrap">
            {ARMED_STATUSES.has(primary.status) && (
              <>
                <ShortcutTooltip label="Queue a run immediately — doesn't shift the regular cadence">
                  <button
                    disabled={busy}
                    onClick={() => act(runNow)}
                    className={`${actionBtn} border-sol-cyan/40 text-sol-cyan bg-sol-cyan/10 hover:bg-sol-cyan/20`}
                  >
                    <span className="inline-flex items-center gap-1">
                      <Play className="w-3 h-3" /> Run now
                    </span>
                  </button>
                </ShortcutTooltip>
                {primary.status === "paused" ? (
                  <ShortcutTooltip label="Re-arm the schedule — fires resume from now">
                    <button
                      disabled={busy}
                      onClick={() => act(resume)}
                      className={`${actionBtn} border-sol-orange/40 text-sol-orange hover:bg-sol-orange/10`}
                    >
                      <span className="inline-flex items-center gap-1">
                        <Play className="w-3 h-3" /> Resume
                      </span>
                    </button>
                  </ShortcutTooltip>
                ) : (
                  <ShortcutTooltip label="Pause — skips every fire until resumed">
                    <button
                      disabled={busy}
                      onClick={() => act(pause)}
                      className={`${actionBtn} border-sol-border/50 text-sol-text-dim hover:bg-sol-bg-alt/60`}
                    >
                      <span className="inline-flex items-center gap-1">
                        <Pause className="w-3 h-3" /> Pause
                      </span>
                    </button>
                  </ShortcutTooltip>
                )}
                {confirmingCancel ? (
                  <ShortcutTooltip label="Really cancel — this schedule won't fire again">
                    <button
                      disabled={busy}
                      onClick={() => act(cancel)}
                      className={`${actionBtn} border-sol-red/50 text-sol-red bg-sol-red/10 hover:bg-sol-red/20`}
                    >
                      Confirm cancel
                    </button>
                  </ShortcutTooltip>
                ) : (
                  <ShortcutTooltip label="Cancel this schedule permanently" hint="asks to confirm">
                    <button
                      disabled={busy}
                      onClick={() => setConfirmingCancel(true)}
                      className={`${actionBtn} border-sol-border/50 text-sol-text-dim hover:text-sol-red hover:border-sol-red/40`}
                    >
                      <span className="inline-flex items-center gap-1">
                        <X className="w-3 h-3" /> Cancel
                      </span>
                    </button>
                  </ShortcutTooltip>
                )}
              </>
            )}
            <span className="ml-auto flex items-center gap-2">
              {extraCount > 0 && (
                <button
                  onClick={() => setOthersOpen((o) => !o)}
                  className="flex items-center gap-0.5 text-[10px] text-sol-text-dim hover:text-sol-text transition-colors"
                >
                  {extraCount} more schedule{extraCount === 1 ? "" : "s"}
                  <ChevronDown
                    className={`w-3 h-3 transition-transform ${othersOpen ? "rotate-180" : ""}`}
                  />
                </button>
              )}
              <Link href="/schedules" className="text-[10px] text-sol-cyan hover:underline">
                Manage schedules
              </Link>
            </span>
          </div>

          {/* The other schedules attached to this conversation — click one to
              point the whole panel at it. */}
          {othersOpen && extraCount > 0 && (
            <div className="space-y-0.5">
              {matched
                .filter((t) => t._id !== primary._id)
                .map((t) => (
                  <button
                    key={t._id}
                    onClick={() => {
                      // Per-schedule transient state resets via the primaryId effect.
                      setSelectedId(t._id);
                      setOthersOpen(false);
                    }}
                    className="w-full flex items-center gap-2 py-1 px-1.5 rounded text-[11px] hover:bg-sol-bg-alt/50 transition-colors text-left"
                  >
                    <Clock className="w-3 h-3 flex-shrink-0 text-sol-orange/70" />
                    <span className="truncate text-sol-text-muted">{cleanTitle(taskDisplayTitle(t))}</span>
                    <span className="text-sol-text-dim flex-shrink-0">{describeTaskCadence(t)}</span>
                    <span className="ml-auto flex-shrink-0 tabular-nums text-[10px] text-sol-text-dim">
                      {/* taskStateLabel only speaks armed states — a done/failed
                          once-schedule with a past run_at would read "due". */}
                      {ARMED_STATUSES.has(t.status) ? taskStateLabel(t, now) : t.status}
                    </span>
                  </button>
                ))}
            </div>
          )}

          {/* The triage-verb contract, stated where the user decides. Stash vs
              dismiss/kill do different things to a schedule and nothing else in
              the UI says so at the moment of choice. */}
          {ARMED_STATUSES.has(primary.status) && (
            <p className="text-[10px] leading-relaxed text-sol-text-dim/80 border-t border-sol-border/20 pt-1.5">
              {primary.originating_conversation_id === conversationId ? (
                <>
                  <span className="text-sol-text-dim font-medium">Stash</span> keeps this session running quietly — the schedule still fires here, out of your queue.{" "}
                  <span className="text-sol-text-dim font-medium">Dismiss/kill</span> retires the session and cancels this schedule.
                </>
              ) : isRun ? (
                <>
                  Dismissing this run leaves the schedule armed — the next run replaces it.{" "}
                  <span className="text-sol-text-dim font-medium">Cancel</span> above stops future runs.
                </>
              ) : (
                <>
                  <span className="text-sol-text-dim font-medium">Stash</span> keeps the target session running quietly.{" "}
                  <span className="text-sol-text-dim font-medium">Dismiss/kill</span> on it cancels this schedule.
                </>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
