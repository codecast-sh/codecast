"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { AuthGuard } from "../../components/AuthGuard";
import { AppLoader } from "../../components/AppLoader";
import { DashboardLayout } from "../../components/DashboardLayout";
import { fmtDuration, fmtClock } from "../../components/triggerCadence";
import { ShortcutTooltip } from "../../components/KeyboardShortcutsHelp";
import { patchTaskInWebList, taskDisplayTitle } from "../../components/triggerTasks";
import { TriggerRunList, useTriggerRuns } from "../../components/TriggerRunHistory";
import { useInboxStore } from "../../store/inboxStore";
import {
  Clock,
  Play,
  Pause,
  X,
  Trash2,
  Plus,
  Zap,
  Repeat,
  ExternalLink,
  Bot,
  Folder,
  ChevronDown,
  ChevronRight,
  RotateCcw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Search,
  LayoutGrid,
  ListFilter,
  Pencil,
  Copy,
  MessageSquare,
  ArrowUpRight,
} from "lucide-react";

const api = _api as any;

// ── Time helpers (parseDuration is a parity port of `cast trigger add --in/--every`) ──

function parseDuration(input: string): number | undefined {
  const match = input.toLowerCase().trim().match(/^(\d+)\s*(s|sec|m|min|h|hr|hour|d|day)s?$/);
  if (!match) return undefined;
  const num = parseInt(match[1]);
  const unit = match[2][0];
  if (unit === "s") return num * 1000;
  if (unit === "m") return num * 60 * 1000;
  if (unit === "h") return num * 60 * 60 * 1000;
  if (unit === "d") return num * 24 * 60 * 60 * 1000;
  return undefined;
}

function fmtCountdown(msUntil: number): string {
  if (msUntil <= 0) return "due now";
  return `in ${fmtDuration(msUntil)}`;
}

function timeAgo(ts?: number): string {
  if (!ts) return "";
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}


// Mirrors the CLI's EVENT_SHORTHANDS so web-created event tasks match `--on <event>`.
const EVENT_SHORTHANDS: Record<string, { event_type: string; action?: string }> = {
  pr_comment: { event_type: "pull_request_review_comment", action: "created" },
  pr_opened: { event_type: "pull_request", action: "opened" },
  pr_merged: { event_type: "pull_request", action: "closed" },
  push: { event_type: "push" },
};

function eventLabel(filter?: { event_type: string; action?: string }): string {
  if (!filter) return "event";
  for (const [name, def] of Object.entries(EVENT_SHORTHANDS)) {
    if (def.event_type === filter.event_type && (def.action ?? undefined) === (filter.action ?? undefined)) {
      return name;
    }
  }
  return filter.action ? `${filter.event_type}:${filter.action}` : filter.event_type;
}

function projectName(path?: string): string {
  if (!path) return "";
  return path.split("/").filter(Boolean).pop() || path;
}

// ── Horizon rail: the next 24h of runs laid out on a time axis ──

const HORIZON_MS = 24 * 3600_000;

interface RailPoint {
  pct: number; // 0..1 position along the rail
  task: any;
  at: number;
  kind: "running" | "due" | "next" | "ghost";
}

function collectRailPoints(tasks: any[], now: number): RailPoint[] {
  const points: RailPoint[] = [];
  for (const t of tasks) {
    if (t.status === "running") {
      points.push({ pct: 0, task: t, at: now, kind: "running" });
      continue;
    }
    if (t.status !== "scheduled" || !t.run_at) continue;
    const dt = t.run_at - now;
    if (dt <= 0) {
      points.push({ pct: 0, task: t, at: now, kind: "due" });
    } else if (dt <= HORIZON_MS) {
      points.push({ pct: dt / HORIZON_MS, task: t, at: t.run_at, kind: "next" });
    }
    // Project recurring tasks forward so the rail shows the day's cadence.
    if (t.schedule_type === "recurring" && t.interval_ms) {
      const first = Math.max(dt, 0);
      for (let at = first + t.interval_ms; at <= HORIZON_MS; at += t.interval_ms) {
        points.push({ pct: at / HORIZON_MS, task: t, at: now + at, kind: "ghost" });
        if (points.length > 200) break; // sanity cap for tiny intervals
      }
    }
  }
  return points;
}

function HorizonRail({ tasks, now }: { tasks: any[]; now: number }) {
  const points = useMemo(() => collectRailPoints(tasks, now), [tasks, now]);
  if (points.length === 0) return null;

  return (
    <div className="reveal reveal-1 rounded-xl border border-sol-border bg-sol-card px-5 pt-4 pb-2 mb-6 select-none">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-medium uppercase tracking-widest text-sol-text-dim">Next 24 hours</span>
        <span className="text-[10px] text-sol-text-dim flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-sol-violet inline-block" /> recurring</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-sol-cyan inline-block" /> one-time</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-sol-violet/30 inline-block" /> later runs</span>
        </span>
      </div>
      <div className="relative h-10">
        {/* baseline */}
        <div className="absolute left-0 right-0 top-1/2 h-px bg-sol-border" />
        {/* hour ticks */}
        {[0.25, 0.5, 0.75, 1].map((p) => (
          <div key={p} className="absolute top-1/2 -translate-y-1/2 h-2.5 w-px bg-sol-border" style={{ left: `${p * 100}%` }} />
        ))}
        {/* now marker — a full-height cyan line so "the present" reads instantly */}
        <div className="absolute left-0 top-0 bottom-0 w-px bg-sol-cyan/50" />
        <div className="absolute left-0 top-0 w-1 h-1 -translate-x-1/2 rounded-full bg-sol-cyan" />
        {/* dots */}
        {points.map((pt, i) => {
          const base = pt.task.schedule_type === "recurring" ? "bg-sol-violet" : "bg-sol-cyan";
          const cls =
            pt.kind === "ghost"
              ? `${base} opacity-25 w-1.5 h-1.5`
              : pt.kind === "running"
                ? "bg-emerald-400 animate-pulse w-2.5 h-2.5"
                : pt.kind === "due"
                  ? `${base} animate-pulse w-2.5 h-2.5`
                  : `${base} w-2 h-2`;
          return (
            <div
              key={`${pt.task._id}-${i}`}
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 group"
              style={{ left: `${Math.min(pt.pct, 1) * 100}%` }}
            >
              <div className={`rounded-full ${cls} group-hover:scale-150 transition-transform`} />
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-10 whitespace-nowrap rounded-md border border-sol-border bg-sol-bg-highlight px-2 py-1 text-[11px] text-sol-text shadow-lg pointer-events-none">
                <span className="font-medium">{taskDisplayTitle(pt.task)}</span>
                <span className="text-sol-text-dim"> · {pt.kind === "running" ? "running now" : pt.kind === "due" ? "due now" : fmtClock(pt.at)}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-sol-text-dim font-mono mt-1">
        <span>now</span><span>+6h</span><span>+12h</span><span>+18h</span><span>+24h</span>
      </div>
    </div>
  );
}

// ── Schedule descriptor chip: "every 4h" / "in 23m" / "on pr_comment" / "once" ──

const chipCls = "inline-flex items-center gap-1 text-[11px] whitespace-nowrap flex-shrink-0";

// The chip leads with the schedule's TYPE — recurring vs one-time is the
// distinction users sort by — then the timing detail.
function TriggerChip({ task, now }: { task: any; now: number }) {
  if (task.schedule_type === "recurring" && task.interval_ms) {
    return (
      <span className={`${chipCls} text-sol-violet`}>
        <Repeat className="w-3 h-3" />recurring
        <span className="text-sol-violet/70">· every {fmtDuration(task.interval_ms)}</span>
      </span>
    );
  }
  if (task.schedule_type === "event") {
    return (
      <span className={`${chipCls} text-sol-yellow`}>
        <Zap className="w-3 h-3" />on {eventLabel(task.event_filter)}
      </span>
    );
  }
  if (task.status === "scheduled" && task.run_at) {
    return (
      <span className={`${chipCls} text-sol-cyan`}>
        <Clock className="w-3 h-3" />one-time
        <span className="text-sol-cyan/70">· {fmtCountdown(task.run_at - now)}</span>
      </span>
    );
  }
  return (
    <span className={`${chipCls} text-sol-text-dim`}>
      <Clock className="w-3 h-3" />one-time
    </span>
  );
}

// ── Task row ──

// A glanceable per-row indicator: running pulse, history ✓/✗, or a status-colored
// dot for scheduled/paused (red when a scheduled task is mid-retry after a failure).
function RowIndicator({ task }: { task: any }) {
  if (task.status === "running")
    return (
      <ShortcutTooltip label="Running now">
        <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
      </ShortcutTooltip>
    );
  if (task.status === "failed")
    return <XCircle className="w-4 h-4 text-sol-red flex-shrink-0" />;
  if (task.status === "completed")
    return <CheckCircle2 className="w-4 h-4 text-sol-text-dim flex-shrink-0" />;
  const color = task.status === "paused" ? "bg-sol-yellow" : task.retry_count > 0 ? "bg-sol-red" : "bg-sol-cyan";
  return (
    <ShortcutTooltip label={task.retry_count > 0 ? `${task.status} — retrying after a failure` : task.status}>
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${color}`} />
    </ShortcutTooltip>
  );
}

function TaskRow({ task, now, isNext }: { task: any; now: number; isNext?: boolean }) {
  // ?task=<id> deep-links here from an inbox schedule row's gear verb: that
  // row arrives expanded and scrolled into view. Read once at mount — after
  // that the page behaves normally.
  const [expanded, setExpanded] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("task") === task._id,
  );
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (rowRef.current && new URLSearchParams(window.location.search).get("task") === task._id) {
      rowRef.current.scrollIntoView({ block: "center" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [formMode, setFormMode] = useState<null | "edit" | "duplicate">(null);
  // Verbs flip the row in the local webList cache synchronously (local-first);
  // the server echo reconciles. Same helper the inbox schedule rows use.
  const pause = useMutation(api.agentTasks.webPause).withOptimisticUpdate(
    (ls: any, args: any) => patchTaskInWebList(ls, api.agentTasks.webList, args.task_id, { status: "paused" }),
  );
  const resume = useMutation(api.agentTasks.webResume).withOptimisticUpdate(
    (ls: any, args: any) => patchTaskInWebList(ls, api.agentTasks.webList, args.task_id, { status: "scheduled" }),
  );
  const runNow = useMutation(api.agentTasks.webRunNow).withOptimisticUpdate(
    (ls: any, args: any) => patchTaskInWebList(ls, api.agentTasks.webList, args.task_id, { status: "scheduled", run_at: Date.now() }),
  );
  const cancel = useMutation(api.agentTasks.webCancel).withOptimisticUpdate(
    (ls: any, args: any) => patchTaskInWebList(ls, api.agentTasks.webList, args.task_id, { status: "completed" }),
  );
  const del = useMutation(api.agentTasks.webDelete);
  const regenSummary = useMutation(api.agentTasks.webRegenerateSummary);

  const isActive = task.status === "scheduled" || task.status === "running";
  const isHistory = task.status === "completed" || task.status === "failed";
  const isEditable = task.status === "scheduled" || task.status === "paused";
  const failedSummary = task.status === "failed" || task.last_run_summary?.startsWith("Failed");

  // Run history loads only while the detail is open — collapsed rows cost no
  // query. Each entry deep-links to the message that triggered that run.
  const runs = useTriggerRuns(expanded && !formMode ? task._id : null);

  // The session to open from this row: the run's own conversation when the daemon
  // recorded it, otherwise the session this schedule was created from. Every row
  // that has run or came from a session becomes one click from a real conversation.
  const runSession = task.last_run_conversation_id;
  const sessionId = runSession ?? task.originating_conversation_id;
  const sessionTitle = runSession ? task.last_run_conversation_title : task.originating_conversation_title;
  const sessionVerb = runSession ? "Open run session" : "Open source session";

  const openForm = (which: "edit" | "duplicate") => (e: React.MouseEvent) => {
    e.stopPropagation();
    setFormMode(which);
    setExpanded(true);
  };
  const copyPrompt = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(task.prompt ?? "");
      toast.success("Prompt copied");
    } catch {
      toast.error("Couldn't copy");
    }
  };

  const act = (fn: () => Promise<any>, msg: string) => async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      const ok = await fn();
      if (ok === false) toast.error("Couldn't update — refresh and retry");
      else toast.success(msg);
    } catch {
      toast.error("Action failed");
    }
  };

  const iconBtn =
    "p-1.5 rounded-md text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-highlight transition-colors";
  const detailBtn =
    "inline-flex items-center gap-1 text-[11px] text-sol-text-dim hover:text-sol-text rounded-md border border-sol-border px-2 py-1 transition-colors";

  return (
    <div
      ref={rowRef}
      className={`group rounded-lg border bg-sol-card hover:bg-sol-card-hover transition-[background-color,border-color,transform,box-shadow] duration-150 cursor-pointer hover:-translate-y-px hover:shadow-md hover:shadow-black/20 ${
        task.status === "failed" ? "border-sol-red/30" : "border-sol-border"
      } ${task.status === "running" ? "border-emerald-400/40" : ""} ${
        isNext ? "ring-1 ring-inset ring-sol-cyan/30" : ""
      }`}
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex items-center gap-3 px-4 py-2.5">
        <RowIndicator task={task} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <ShortcutTooltip label={taskDisplayTitle(task)}>
              <span className={`text-sm font-medium truncate ${isHistory ? "text-sol-text-muted" : "text-sol-text"}`}>
                {taskDisplayTitle(task)}
              </span>
            </ShortcutTooltip>
            <TriggerChip task={task} now={now} />
            {isNext && (
              <span className="text-[10px] font-medium uppercase tracking-wide text-sol-cyan flex-shrink-0">
                next up
              </span>
            )}
          </div>
          {task.display_summary && (
            <ShortcutTooltip label={task.display_summary}>
              <div className="text-[11px] text-sol-text-dim truncate mt-0.5">
                {task.display_summary}
              </div>
            </ShortcutTooltip>
          )}
          <div className="flex items-center gap-2 mt-1 text-[11px] text-sol-text-dim min-w-0">
            {/* quiet meta */}
            {task.status === "running" && <span className="text-emerald-400 flex-shrink-0">running now</span>}
            {task.run_count > 0 && (
              <span className="flex-shrink-0">
                {task.run_count} run{task.run_count === 1 ? "" : "s"}
              </span>
            )}
            {task.retry_count > 0 && <span className="text-sol-orange flex-shrink-0">{task.retry_count} retries</span>}
            {task.agent_type === "codex" && (
              <span className="inline-flex items-center gap-1 flex-shrink-0">
                <Bot className="w-3 h-3" />codex
              </span>
            )}
            {task.project_path && (
              <ShortcutTooltip label={task.project_path}>
                <span className="hidden sm:inline-flex items-center gap-1 flex-shrink-0">
                  <Folder className="w-3 h-3" />{projectName(task.project_path)}
                </span>
              </ShortcutTooltip>
            )}

            {/* The run, surfaced as a clear clickable session — the thing you
                actually want to open. Links to the run's own conversation when the
                daemon recorded it, else the originating session. Truncates last
                (min-w-0) so it's never pushed off the row like the old buried link. */}
            {sessionId ? (
              <ShortcutTooltip label={sessionVerb} hint={sessionTitle || undefined}>
                <Link
                  href={`/conversation/${sessionId}`}
                  onClick={(e) => e.stopPropagation()}
                  className={`group/sess inline-flex items-center gap-1 min-w-0 rounded px-1.5 py-0.5 -my-0.5 transition-colors hover:bg-sol-cyan/10 ${
                    failedSummary ? "text-sol-red hover:bg-sol-red/10" : "text-sol-cyan"
                  }`}
                >
                  <MessageSquare className="w-3 h-3 flex-shrink-0" />
                  <span className="truncate">
                    {task.last_run_summary || sessionTitle || sessionVerb}
                  </span>
                  {task.last_run_at && <span className="text-sol-text-dim/80 flex-shrink-0">· {timeAgo(task.last_run_at)}</span>}
                  <ArrowUpRight className="w-3 h-3 flex-shrink-0 opacity-50 group-hover/sess:opacity-100 transition-opacity" />
                </Link>
              </ShortcutTooltip>
            ) : task.last_run_summary ? (
              <span className={`inline-flex items-center gap-1.5 min-w-0`}>
                <span className={`truncate ${failedSummary ? "text-sol-red" : ""}`}>{task.last_run_summary}</span>
                {task.last_run_at && <span className="flex-shrink-0">· {timeAgo(task.last_run_at)}</span>}
              </span>
            ) : (
              task.last_run_at && <span className="flex-shrink-0">last {timeAgo(task.last_run_at)}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {isEditable && (
            <ShortcutTooltip label="Edit">
              <button className={iconBtn} aria-label="Edit" onClick={openForm("edit")}>
                <Pencil className="w-3.5 h-3.5" />
              </button>
            </ShortcutTooltip>
          )}
          {isActive && (
            <>
              <ShortcutTooltip label="Run now" hint="daemon picks it up within ~30s">
                <button className={iconBtn} aria-label="Run now" onClick={act(() => runNow({ task_id: task._id }), "Queued — runs within ~30s")}>
                  <Play className="w-3.5 h-3.5" />
                </button>
              </ShortcutTooltip>
              <ShortcutTooltip label="Pause">
                <button className={iconBtn} aria-label="Pause" onClick={act(() => pause({ task_id: task._id }), "Paused")}>
                  <Pause className="w-3.5 h-3.5" />
                </button>
              </ShortcutTooltip>
              <ShortcutTooltip label="Cancel">
                <button className={iconBtn} aria-label="Cancel" onClick={act(() => cancel({ task_id: task._id }), "Cancelled")}>
                  <X className="w-3.5 h-3.5" />
                </button>
              </ShortcutTooltip>
            </>
          )}
          {task.status === "paused" && (
            <>
              <ShortcutTooltip label="Resume">
                <button className={iconBtn} aria-label="Resume" onClick={act(() => resume({ task_id: task._id }), "Resumed")}>
                  <Play className="w-3.5 h-3.5" />
                </button>
              </ShortcutTooltip>
              <ShortcutTooltip label="Cancel">
                <button className={iconBtn} aria-label="Cancel" onClick={act(() => cancel({ task_id: task._id }), "Cancelled")}>
                  <X className="w-3.5 h-3.5" />
                </button>
              </ShortcutTooltip>
            </>
          )}
          {isHistory && (
            <>
              <ShortcutTooltip label="Run again" hint="re-arms, runs within ~30s">
                <button className={iconBtn} aria-label="Run again" onClick={act(() => runNow({ task_id: task._id }), "Re-armed — runs within ~30s")}>
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              </ShortcutTooltip>
              <ShortcutTooltip label={confirmDelete ? "Click again to delete" : "Delete"}>
              <button
                className={`${iconBtn} ${confirmDelete ? "text-sol-red hover:text-sol-red" : ""}`}
                aria-label="Delete"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!confirmDelete) {
                    setConfirmDelete(true);
                    setTimeout(() => setConfirmDelete(false), 3000);
                    return;
                  }
                  act(() => del({ task_id: task._id }), "Deleted")(e);
                }}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
              </ShortcutTooltip>
            </>
          )}
        </div>
      </div>

      {expanded && formMode && (
        <div className="px-4 pb-3 border-t border-sol-border cursor-auto animate-fadeSlideIn" onClick={(e) => e.stopPropagation()}>
          <TriggerForm
            embedded
            editTask={formMode === "edit" ? task : undefined}
            seedTask={formMode === "duplicate" ? task : undefined}
            onClose={() => setFormMode(null)}
          />
        </div>
      )}

      {expanded && !formMode && (
        <div className="px-4 pb-3 pt-1 border-t border-sol-border cursor-auto animate-fadeSlideIn" onClick={(e) => e.stopPropagation()}>
          {/* The run list below is the richer path (every run, trigger-linked);
              this button only covers a schedule whose runs can't be enumerated
              (e.g. an encrypted home conversation) but whose last run is known. */}
          {task.last_run_conversation_id && (runs?.length ?? 0) === 0 && (
            <Link
              href={`/conversation/${task.last_run_conversation_id}`}
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1.5 mt-2.5 px-3 py-1.5 rounded-lg bg-sol-cyan/10 text-sol-cyan text-xs font-medium hover:bg-sol-cyan/20 transition-colors"
            >
              <MessageSquare className="w-3.5 h-3.5" />
              Open latest run session
              {task.last_run_conversation_title ? (
                <span className="text-sol-cyan/70 font-normal truncate max-w-[220px]">· {task.last_run_conversation_title}</span>
              ) : null}
              <ArrowUpRight className="w-3.5 h-3.5" />
            </Link>
          )}
          {task.display_summary && (
            <>
              <div className="text-[10px] uppercase tracking-widest text-sol-text-dim mt-3 mb-1">What it does</div>
              <div className="text-xs text-sol-text leading-relaxed">
                {task.display_summary}
              </div>
            </>
          )}
          <div className="text-[10px] uppercase tracking-widest text-sol-text-dim mt-3 mb-1">Prompt</div>
          <div className="text-xs text-sol-text-muted font-mono whitespace-pre-wrap bg-sol-bg-alt rounded-md p-3">
            {task.prompt}
          </div>

          {task.context_summary && (
            <>
              <div className="text-[10px] uppercase tracking-widest text-sol-text-dim mt-3 mb-1">Context</div>
              <div className="text-xs text-sol-text-muted whitespace-pre-wrap bg-sol-bg-alt rounded-md p-3">
                {task.context_summary}
              </div>
            </>
          )}

          {task.last_run_summary && (
            <>
              <div className="text-[10px] uppercase tracking-widest text-sol-text-dim mt-3 mb-1">
                Last result{task.last_run_at ? ` · ${fmtClock(task.last_run_at)}` : ""}
              </div>
              <div
                className={`text-xs whitespace-pre-wrap rounded-md p-3 ${
                  failedSummary
                    ? "bg-sol-red/5 text-sol-red border border-sol-red/20"
                    : "bg-sol-bg-alt text-sol-text-muted"
                }`}
              >
                {task.last_run_summary}
              </div>
            </>
          )}

          {/* Every past run, newest first — each links to the message that
              triggered it (the injected turn or the spawned run's prompt). */}
          {runs && runs.length > 0 && (
            <>
              <div className="text-[10px] uppercase tracking-widest text-sol-text-dim mt-3 mb-1">
                Past runs <span className="font-mono normal-case text-sol-text-dim/70">{runs.length}</span>
              </div>
              <TriggerRunList runs={runs} now={now} ensureInboxRoute className="-ml-1.5" />
            </>
          )}

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[11px] text-sol-text-dim">
            {task.run_at && task.status === "scheduled" && <span>next run {fmtClock(task.run_at)}</span>}
            <ShortcutTooltip
              label={
                task.mode === "apply"
                  ? "Runs with full tools — it can edit files and make changes"
                  : "Read-only run — investigates and reports, changes nothing"
              }
            >
              <span>{task.mode === "apply" ? "makes changes" : "read-only"}</span>
            </ShortcutTooltip>
            <span>agent {task.agent_type || "claude"}</span>
            {task.run_count > 0 && <span>{task.run_count} total run{task.run_count === 1 ? "" : "s"}</span>}
            {task.retry_count > 0 && <span className="text-sol-orange">{task.retry_count} retries</span>}
            {task.max_runtime_ms && <span>max runtime {fmtDuration(task.max_runtime_ms)}</span>}
            <span>created {timeAgo(task.created_at)}</span>
            {task.project_path && <span className="font-mono">{task.project_path}</span>}
            {task.originating_conversation_id && (
              <Link
                href={`/conversation/${task.originating_conversation_id}`}
                className="inline-flex items-center gap-0.5 text-sol-cyan hover:underline underline-offset-2"
              >
                from session{task.originating_conversation_title ? `: ${task.originating_conversation_title}` : ""}
                <ExternalLink className="w-3 h-3" />
              </Link>
            )}
          </div>

          <div className="flex items-center gap-1.5 mt-3 pt-2.5 border-t border-sol-border/60">
            {isEditable && (
              <button onClick={openForm("edit")} className={detailBtn}>
                <Pencil className="w-3 h-3" /> Edit
              </button>
            )}
            <button onClick={openForm("duplicate")} className={detailBtn}>
              <Copy className="w-3 h-3" /> Duplicate
            </button>
            <button onClick={copyPrompt} className={detailBtn}>
              <Copy className="w-3 h-3" /> Copy prompt
            </button>
            <ShortcutTooltip label="Re-run the Haiku distillation of this prompt into title + summary">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  regenSummary({ task_id: task._id }).catch(() => {});
                  toast.success("Summary refreshing — lands in a few seconds");
                }}
                className={detailBtn}
              >
                <RotateCcw className="w-3 h-3" /> Refresh summary
              </button>
            </ShortcutTooltip>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Schedule composer (create / edit / duplicate) ──

type SchedKind = "now" | "in" | "every" | "on";

// interval_ms / delay back to a token parseDuration understands ("90m" if not a
// clean hour/day boundary, else "2h" / "3d").
function msToDurationToken(ms: number): string {
  const mins = Math.max(Math.round(ms / 60_000), 1);
  if (mins % (60 * 24) === 0) return `${mins / (60 * 24)}d`;
  if (mins % 60 === 0) return `${mins / 60}h`;
  return `${mins}m`;
}

function deriveInitial(t: any | undefined) {
  if (!t) {
    // Human-created schedules default to apply: you wrote the prompt, it just
    // does the task. Read-only is the marked exception (the checkbox below).
    // Agent-created schedules (cast trigger add) still default to propose —
    // their prompts were never reviewed by a person.
    return { prompt: "", title: "", kind: "in" as SchedKind, duration: "30m", eventKey: "pr_comment", mode: "apply" as const, agent: "claude" as const, project: "" };
  }
  let kind: SchedKind = "in";
  let duration = "30m";
  let eventKey = "pr_comment";
  if (t.schedule_type === "recurring" && t.interval_ms) {
    kind = "every";
    duration = msToDurationToken(t.interval_ms);
  } else if (t.schedule_type === "event") {
    kind = "on";
    eventKey =
      Object.keys(EVENT_SHORTHANDS).find(
        (k) =>
          EVENT_SHORTHANDS[k].event_type === t.event_filter?.event_type &&
          (EVENT_SHORTHANDS[k].action ?? undefined) === (t.event_filter?.action ?? undefined)
      ) ?? "pr_comment";
  } else if (t.schedule_type === "once" && t.run_at) {
    kind = "in";
    duration = msToDurationToken(Math.max(t.run_at - Date.now(), 60_000));
  }
  return {
    prompt: t.prompt ?? "",
    title: t.title ?? "",
    kind,
    duration,
    eventKey,
    mode: (t.mode === "apply" ? "apply" : "propose") as "propose" | "apply",
    agent: (t.agent_type === "codex" ? "codex" : "claude") as "claude" | "codex",
    project: t.project_path ?? "",
  };
}

function TriggerForm({ onClose, editTask, seedTask, embedded }: {
  onClose: () => void;
  editTask?: any;
  seedTask?: any;
  embedded?: boolean;
}) {
  const isEdit = !!editTask;
  const init = useMemo(() => deriveInitial(editTask ?? seedTask), [editTask, seedTask]);
  const create = useMutation(api.agentTasks.webCreate);
  const updateTask = useMutation(api.agentTasks.webUpdate);
  const [prompt, setPrompt] = useState(init.prompt);
  const [title, setTitle] = useState(init.title);
  const [kind, setKind] = useState<SchedKind>(init.kind);
  const [duration, setDuration] = useState(init.duration);
  const [eventKey, setEventKey] = useState(init.eventKey);
  const [mode, setMode] = useState<"propose" | "apply">(init.mode);
  const [agent, setAgent] = useState<"claude" | "codex">(init.agent);
  const [project, setProject] = useState(init.project);
  const [submitting, setSubmitting] = useState(false);

  // Suggest project paths from sessions already in the store — same data the
  // sidebar's workspace list derives from, without re-running its grouping.
  const sessions = useInboxStore((s) => s.sessions);
  const projectOptions = useMemo(() => {
    const seen = new Map<string, number>();
    for (const s of Object.values(sessions ?? {})) {
      const p = (s as any)?.project_path;
      if (!p) continue;
      const u = (s as any)?.updated_at ?? 0;
      if ((seen.get(p) ?? 0) < u) seen.set(p, u);
    }
    return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([p]) => p).slice(0, 12);
  }, [sessions]);

  const parsed = parseDuration(duration);
  const needsDuration = kind === "in" || kind === "every";
  const valid = prompt.trim().length > 0 && (!needsDuration || parsed !== undefined);

  const preview = !needsDuration
    ? null
    : parsed === undefined
      ? "format: 30m, 2h, 1d"
      : kind === "in"
        ? `runs at ${fmtClock(Date.now() + parsed)}`
        : `every ${fmtDuration(parsed)}, first run ${fmtClock(Date.now() + parsed)}`;

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      const args: any = {
        prompt: prompt.trim(),
        title: title.trim() || undefined,
        mode,
        agent_type: agent,
        project_path: isEdit ? project.trim() : project.trim() || undefined,
      };
      if (kind === "on") {
        args.schedule_type = "event";
        args.event_filter = EVENT_SHORTHANDS[eventKey];
      } else if (kind === "every") {
        args.schedule_type = "recurring";
        args.interval_ms = parsed;
        args.run_at = Date.now() + parsed!;
      } else {
        args.schedule_type = "once";
        args.run_at = kind === "in" ? Date.now() + parsed! : Date.now();
      }
      if (isEdit) {
        const ok = await updateTask({ task_id: editTask._id, ...args });
        if (ok === false) { toast.error("Can't edit — it may be running or finished"); return; }
        toast.success("Saved");
      } else {
        await create(args);
        toast.success(kind === "now" ? "Queued — runs within ~30s" : "Trigger set");
      }
      onClose();
    } catch {
      toast.error(isEdit ? "Failed to save" : "Failed to set trigger");
    } finally {
      setSubmitting(false);
    }
  };

  const seg = (active: boolean) =>
    `px-2.5 py-1 rounded-md text-xs transition-colors ${
      active ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"
    }`;

  return (
    <div className={embedded ? "pt-1" : "rounded-xl border border-sol-cyan/30 bg-sol-card p-4 mb-6"}>
      {isEdit && (
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-sol-cyan mb-2">
          <Pencil className="w-3 h-3" /> Editing trigger
        </div>
      )}
      <textarea
        autoFocus
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          if (e.key === "Escape") onClose();
        }}
        placeholder='What should the agent do? e.g. "Check if CI is green on main and report"'
        rows={3}
        className="w-full bg-sol-bg-alt border border-sol-border rounded-lg px-3 py-2 text-sm text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan/60 resize-none"
      />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Title (optional — auto-named from the prompt)"
        className="w-full mt-2 bg-sol-bg-alt border border-sol-border rounded-lg px-3 py-1.5 text-xs text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan/60"
      />

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-3">
        <div className="flex items-center gap-1 bg-sol-bg-alt rounded-lg p-0.5">
          <button className={seg(kind === "now")} onClick={() => setKind("now")}>now</button>
          <button className={seg(kind === "in")} onClick={() => setKind("in")}>in…</button>
          <button className={seg(kind === "every")} onClick={() => setKind("every")}>every…</button>
          <button className={seg(kind === "on")} onClick={() => setKind("on")}>on event</button>
        </div>
        {needsDuration && (
          <div className="flex items-center gap-2">
            <input
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              className={`w-20 bg-sol-bg-alt border rounded-lg px-2 py-1 text-xs font-mono text-sol-text focus:outline-none ${
                parsed === undefined ? "border-sol-red/50" : "border-sol-border focus:border-sol-cyan/60"
              }`}
            />
            <span className={`text-[11px] ${parsed === undefined ? "text-sol-red" : "text-sol-text-dim"}`}>{preview}</span>
          </div>
        )}
        {kind === "on" && (
          <select
            value={eventKey}
            onChange={(e) => setEventKey(e.target.value)}
            className="bg-sol-bg-alt border border-sol-border rounded-lg px-2 py-1 text-xs text-sol-text focus:outline-none focus:border-sol-cyan/60"
          >
            {Object.keys(EVENT_SHORTHANDS).map((k) => (
              <option key={k} value={k}>{k}</option>
            ))}
          </select>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-3">
        <label className="flex items-center gap-1.5 text-xs text-sol-text-muted cursor-pointer select-none">
          <input
            type="checkbox"
            checked={mode === "propose"}
            onChange={(e) => setMode(e.target.checked ? "propose" : "apply")}
            className="accent-sol-cyan"
          />
          Read-only — report, don&apos;t change anything
        </label>
        <div className="flex items-center gap-1 bg-sol-bg-alt rounded-lg p-0.5">
          <button className={seg(agent === "claude")} onClick={() => setAgent("claude")}>claude</button>
          <button className={seg(agent === "codex")} onClick={() => setAgent("codex")}>codex</button>
        </div>
        <input
          value={project}
          onChange={(e) => setProject(e.target.value)}
          list="trigger-project-roots"
          placeholder="Project path (optional)"
          className="flex-1 min-w-[180px] bg-sol-bg-alt border border-sol-border rounded-lg px-2 py-1 text-xs font-mono text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan/60"
        />
        <datalist id="trigger-project-roots">
          {projectOptions.map((p) => <option key={p} value={p} />)}
        </datalist>
      </div>


      <div className="flex items-center justify-between mt-3">
        <span className="text-[11px] text-sol-text-dim">Runs on your daemon — it polls every 30s</span>
        <div className="flex items-center gap-2">
          <button onClick={onClose} className="px-3 py-1.5 text-xs text-sol-text-dim hover:text-sol-text transition-colors">
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!valid || submitting}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-sol-cyan text-sol-bg hover:bg-sol-cyan/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isEdit
              ? submitting ? "Saving…" : "Save changes"
              : submitting ? "Setting…" : "Set trigger"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Page ──

function Section({ title, count, subtitle, children, defaultOpen = true }: {
  title: string;
  count: number;
  subtitle?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (count === 0) return null;
  return (
    <div className="mb-6">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-widest text-sol-text-dim hover:text-sol-text-muted transition-colors mb-2 select-none w-full"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {title}
        <span className="text-sol-text-dim/70 normal-case tracking-normal font-mono">{count}</span>
        {subtitle && (
          <span className="text-sol-text-dim/60 normal-case tracking-normal font-normal ml-1">· {subtitle}</span>
        )}
      </button>
      {open && <div className="flex flex-col gap-2">{children}</div>}
    </div>
  );
}

// ── Aggregate health stats across all tasks ──

interface SchedStats {
  active: number;
  // The primary split: standing loops vs one-shot runs. Event schedules join
  // neither count (they have their own filter) but are part of `active`.
  recurring: number;
  oneTime: number;
  totalRuns: number;
  failing: number; // active tasks mid-retry or failed-but-rescheduled
  nextRunAt: number | null; // soonest upcoming scheduled run
  running: number;
}

function computeStats(all: any[], now: number): SchedStats {
  let active = 0, recurring = 0, oneTime = 0, totalRuns = 0, failing = 0, running = 0;
  let nextRunAt: number | null = null;
  for (const t of all) {
    totalRuns += t.run_count ?? 0;
    const isActive = t.status === "scheduled" || t.status === "running";
    if (isActive) {
      active++;
      if (t.schedule_type === "once") oneTime++;
      else if (t.schedule_type === "recurring") recurring++;
      if (t.status === "running") running++;
      if (t.retry_count > 0) failing++;
      if (t.status === "scheduled" && t.run_at && t.run_at > now) {
        if (nextRunAt === null || t.run_at < nextRunAt) nextRunAt = t.run_at;
      }
    }
  }
  return { active, recurring, oneTime, totalRuns, failing, nextRunAt, running };
}

function StatCell({ value, label, accent = "text-sol-text", title, onClick, active }: {
  value: React.ReactNode;
  label: string;
  accent?: string;
  title?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const inner = (
    <>
      <span className={`text-xl font-semibold leading-none tabular-nums ${accent}`}>{value}</span>
      <span className="text-[10px] uppercase tracking-widest text-sol-text-dim">{label}</span>
    </>
  );
  const cell = onClick ? (
    <button
      onClick={onClick}
      className={`flex flex-col gap-0.5 text-left rounded-md -mx-1.5 px-1.5 py-0.5 transition-colors ${
        active ? "bg-sol-bg-highlight" : "hover:bg-sol-bg-highlight/60"
      }`}
    >
      {inner}
    </button>
  ) : (
    <div className="flex flex-col gap-0.5">{inner}</div>
  );
  if (!title) return cell;
  return <ShortcutTooltip label={title}>{cell}</ShortcutTooltip>;
}

function StatStrip({ stats, now, typeFilter, onToggleType }: {
  stats: SchedStats;
  now: number;
  typeFilter?: string;
  onToggleType?: (type: "recurring" | "once") => void;
}) {
  const nextLabel =
    stats.running > 0
      ? "now"
      : stats.nextRunAt
        ? fmtDuration(Math.max(stats.nextRunAt - now, 0))
        : "—";
  const nextAccent = stats.running > 0 ? "text-emerald-400" : stats.nextRunAt ? "text-sol-cyan" : "text-sol-text-dim";
  return (
    <div className="reveal flex flex-wrap items-center gap-x-7 gap-y-3 mb-5 px-1">
      <StatCell value={stats.active} label="active" />
      <StatCell
        value={stats.recurring}
        label="recurring"
        accent={stats.recurring > 0 ? "text-sol-violet" : "text-sol-text-dim"}
        title="Standing triggers that fire on an interval — click to filter"
        onClick={() => onToggleType?.("recurring")}
        active={typeFilter === "recurring"}
      />
      <StatCell
        value={stats.oneTime}
        label="one-time"
        accent={stats.oneTime > 0 ? "text-sol-cyan" : "text-sol-text-dim"}
        title="Triggers that fire once and finish — click to filter"
        onClick={() => onToggleType?.("once")}
        active={typeFilter === "once"}
      />
      <StatCell value={nextLabel} label={stats.running > 0 ? "running" : "next run"} accent={nextAccent} />
      <StatCell value={stats.totalRuns} label="total runs" title="Agent runs fired across all triggers" />
      <StatCell
        value={
          stats.failing > 0 ? (
            <span className="inline-flex items-center gap-1"><AlertTriangle className="w-4 h-4" />{stats.failing}</span>
          ) : (
            <span className="inline-flex items-center gap-1"><CheckCircle2 className="w-4 h-4" />ok</span>
          )
        }
        label={stats.failing > 0 ? "retrying" : "healthy"}
        accent={stats.failing > 0 ? "text-sol-red" : "text-emerald-400"}
      />
    </div>
  );
}

function AttentionBanner({ tasks }: { tasks: any[] }) {
  if (tasks.length === 0) return null;
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-sol-red/30 bg-sol-red/5 px-4 py-3 mb-5">
      <AlertTriangle className="w-4 h-4 text-sol-red flex-shrink-0 mt-0.5" />
      <div className="min-w-0 text-xs">
        <span className="text-sol-red font-medium">
          {tasks.length} trigger{tasks.length === 1 ? "" : "s"} hit an error and {tasks.length === 1 ? "is" : "are"} retrying
        </span>
        <div className="mt-1 flex flex-col gap-0.5 text-sol-text-dim">
          {tasks.slice(0, 3).map((t) => (
            <span key={t._id} className="truncate">
              <span className="text-sol-text-muted">{taskDisplayTitle(t)}</span>
              {" — "}
              {t.retry_count} {t.retry_count === 1 ? "retry" : "retries"}
              {t.last_run_summary ? ` · ${t.last_run_summary.replace(/^Failed:?\s*/, "")}` : ""}
            </span>
          ))}
          {tasks.length > 3 && <span>+{tasks.length - 3} more</span>}
        </div>
      </div>
    </div>
  );
}

// ── Filtering ──

interface Filters {
  search: string;
  mode: string; // all | apply | propose
  type: string; // all | recurring | once | event
  project: string; // all | <path>
  agent: string; // all | claude | codex
}

const EMPTY_FILTERS: Filters = { search: "", mode: "all", type: "all", project: "all", agent: "all" };

function filtersActive(f: Filters): boolean {
  return f.search.trim() !== "" || f.mode !== "all" || f.type !== "all" || f.project !== "all" || f.agent !== "all";
}

function matchesFilters(t: any, f: Filters): boolean {
  if (f.mode !== "all" && (t.mode ?? "propose") !== f.mode) return false;
  if (f.type !== "all" && t.schedule_type !== f.type) return false;
  if (f.agent !== "all" && (t.agent_type || "claude") !== f.agent) return false;
  if (f.project !== "all" && t.project_path !== f.project) return false;
  const q = f.search.trim().toLowerCase();
  if (q) {
    const hay = `${t.title ?? ""} ${t.display_title ?? ""} ${t.display_summary ?? ""} ${t.prompt ?? ""} ${t.last_run_summary ?? ""}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

const filterSelectCls =
  "bg-sol-bg-alt border border-sol-border rounded-lg px-2 py-1.5 text-xs text-sol-text focus:outline-none focus:border-sol-cyan/60 cursor-pointer";

function FilterBar({ filters, update, projects, hasCodex, shown, total, grouped, setGrouped }: {
  filters: Filters;
  update: (patch: Partial<Filters>) => void;
  projects: string[];
  hasCodex: boolean;
  shown: number;
  total: number;
  grouped: boolean;
  setGrouped: (v: boolean) => void;
}) {
  const active = filtersActive(filters);
  return (
    <div className="sticky top-0 z-20 -mx-1 px-1 py-2 mb-3 bg-sol-bg/85 backdrop-blur">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-sol-text-dim pointer-events-none" />
          <input
            id="trigger-search"
            value={filters.search}
            onChange={(e) => update({ search: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                update({ search: "" });
                e.currentTarget.blur();
              }
            }}
            placeholder="Search title, prompt, last result…"
            className="w-full bg-sol-bg-alt border border-sol-border rounded-lg pl-8 pr-7 py-1.5 text-xs text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan/60"
          />
          {filters.search && (
            <ShortcutTooltip label="Clear search">
              <button
                onClick={() => update({ search: "" })}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-sol-text-dim hover:text-sol-text"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </ShortcutTooltip>
          )}
        </div>
        <select className={filterSelectCls} value={filters.type} onChange={(e) => update({ type: e.target.value })}>
          <option value="all">all types</option>
          <option value="recurring">recurring</option>
          <option value="once">one-time</option>
          <option value="event">event</option>
        </select>
        <select className={filterSelectCls} value={filters.mode} onChange={(e) => update({ mode: e.target.value })}>
          <option value="all">all modes</option>
          <option value="apply">makes changes</option>
          <option value="propose">read-only</option>
        </select>
        {projects.length > 1 && (
          <select className={filterSelectCls} value={filters.project} onChange={(e) => update({ project: e.target.value })}>
            <option value="all">all projects</option>
            {projects.map((p) => <option key={p} value={p}>{projectName(p)}</option>)}
          </select>
        )}
        {hasCodex && (
          <select className={filterSelectCls} value={filters.agent} onChange={(e) => update({ agent: e.target.value })}>
            <option value="all">all agents</option>
            <option value="claude">claude</option>
            <option value="codex">codex</option>
          </select>
        )}
        <ShortcutTooltip label="Group by project">
          <button
            onClick={() => setGrouped(!grouped)}
            aria-label="Group by project"
            className={`p-1.5 rounded-lg border transition-colors ${
              grouped ? "border-sol-cyan/50 text-sol-cyan bg-sol-cyan/10" : "border-sol-border text-sol-text-dim hover:text-sol-text"
            }`}
          >
            <LayoutGrid className="w-3.5 h-3.5" />
          </button>
        </ShortcutTooltip>
        {active && (
          <span className="inline-flex items-center gap-2 text-[11px] text-sol-text-dim">
            <span className="tabular-nums">{shown} of {total}</span>
            <button onClick={() => update(EMPTY_FILTERS)} className="hover:text-sol-text underline underline-offset-2">
              clear
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

// Render a list of rows, optionally grouped under project subheaders.
function groupByProjectPath(tasks: any[]): [string, any[]][] {
  const groups = new Map<string, any[]>();
  for (const t of tasks) {
    const key = t.project_path || "— no project";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
}

function RowList({ tasks, now, grouped, nextId }: { tasks: any[]; now: number; grouped: boolean; nextId?: string }) {
  if (!grouped) return <>{tasks.map((t) => <TaskRow key={t._id} task={t} now={now} isNext={t._id === nextId} />)}</>;
  return (
    <>
      {groupByProjectPath(tasks).map(([proj, rows]) => (
        <div key={proj} className="flex flex-col gap-2">
          <div className="flex items-center gap-1.5 text-[11px] text-sol-text-dim pt-1.5 pl-0.5">
            <Folder className="w-3 h-3" />
            {proj.startsWith("—") ? proj : projectName(proj)}
            <span className="font-mono text-sol-text-dim/60">{rows.length}</span>
          </div>
          {rows.map((t) => <TaskRow key={t._id} task={t} now={now} isNext={t._id === nextId} />)}
        </div>
      ))}
    </>
  );
}

// ── History: analytics + day-grouped, paginated finished runs ──

function dayBucket(ts: number, now: number): string {
  const startOfDay = (ms: number) => {
    const d = new Date(ms);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Earlier this week";
  if (days < 30) return "Earlier this month";
  return "Older";
}

const DAY_ORDER = ["Today", "Yesterday", "Earlier this week", "Earlier this month", "Older"];

function groupByDay(tasks: any[], now: number): [string, any[]][] {
  const groups = new Map<string, any[]>();
  for (const t of tasks) {
    const key = dayBucket(t.last_run_at ?? t.created_at, now);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(t);
  }
  return DAY_ORDER.filter((k) => groups.has(k)).map((k) => [k, groups.get(k)!]);
}

const HISTORY_PAGE = 25;

function HistoryBody({ tasks, now, grouped }: { tasks: any[]; now: number; grouped: boolean }) {
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [limit, setLimit] = useState(HISTORY_PAGE);

  const succeeded = useMemo(() => tasks.filter((t) => t.status === "completed").length, [tasks]);
  const failed = tasks.length - succeeded;
  const rate = tasks.length ? Math.round((succeeded / tasks.length) * 100) : 0;

  const shown = failuresOnly ? tasks.filter((t) => t.status === "failed") : tasks;
  const visible = shown.slice(0, limit);
  const subheaderCls = "flex items-center gap-1.5 text-[11px] text-sol-text-dim pt-1.5 pl-0.5";

  return (
    <div className="flex flex-col gap-2">
      {/* success / failure proportion */}
      <div className="rounded-lg border border-sol-border bg-sol-card/40 px-3 py-2.5">
        <div className="flex items-center justify-between text-[11px] mb-1.5">
          <span className="text-sol-text-dim">
            <span className="text-emerald-400">{succeeded} succeeded</span>
            {failed > 0 && <> · <span className="text-sol-red">{failed} failed</span></>}
          </span>
          <span className="text-sol-text-muted tabular-nums">{rate}% success</span>
        </div>
        <div className="h-1.5 rounded-full bg-sol-bg-alt overflow-hidden flex">
          <div className="bg-emerald-500/70 h-full transition-all" style={{ width: `${(succeeded / Math.max(tasks.length, 1)) * 100}%` }} />
          <div className="bg-sol-red/70 h-full transition-all" style={{ width: `${(failed / Math.max(tasks.length, 1)) * 100}%` }} />
        </div>
      </div>

      {failed > 0 && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => setFailuresOnly((v) => !v)}
            className={`inline-flex items-center gap-1 text-[11px] rounded-md border px-2 py-1 transition-colors ${
              failuresOnly
                ? "border-sol-red/50 text-sol-red bg-sol-red/10"
                : "border-sol-border text-sol-text-dim hover:text-sol-text"
            }`}
          >
            <AlertTriangle className="w-3 h-3" /> failures only
          </button>
        </div>
      )}

      {shown.length === 0 ? (
        <p className="text-[11px] text-sol-text-dim py-3 pl-0.5">No failures — every finished run succeeded.</p>
      ) : grouped ? (
        groupByProjectPath(visible).map(([proj, rows]) => (
          <div key={proj} className="flex flex-col gap-2">
            <div className={subheaderCls}>
              <Folder className="w-3 h-3" />
              {proj.startsWith("—") ? proj : projectName(proj)}
              <span className="font-mono text-sol-text-dim/60">{rows.length}</span>
            </div>
            {rows.map((t) => <TaskRow key={t._id} task={t} now={now} />)}
          </div>
        ))
      ) : (
        groupByDay(visible, now).map(([label, rows]) => (
          <div key={label} className="flex flex-col gap-2">
            <div className={subheaderCls}>{label}<span className="font-mono text-sol-text-dim/60">{rows.length}</span></div>
            {rows.map((t) => <TaskRow key={t._id} task={t} now={now} />)}
          </div>
        ))
      )}

      {shown.length > limit && (
        <button
          onClick={() => setLimit((l) => l + HISTORY_PAGE)}
          className="self-start text-[11px] text-sol-cyan hover:underline underline-offset-2 mt-1 pl-0.5"
        >
          show {Math.min(HISTORY_PAGE, shown.length - limit)} more · {shown.length - limit} hidden
        </button>
      )}
    </div>
  );
}

function FilteredEmpty({ onClear }: { onClear: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      <ListFilter className="w-7 h-7 text-sol-text-dim" />
      <p className="text-sm text-sol-text-muted">No triggers match these filters</p>
      <button
        onClick={onClear}
        className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-sol-border text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-highlight transition-colors"
      >
        Clear filters
      </button>
    </div>
  );
}

function TriggersContent() {
  const tasks = useQuery(api.agentTasks.webList, {});
  // ?new=1 arrives from the inbox dock's "+ New" — land with the create form
  // already open instead of making the user find the button again.
  const [showForm, setShowForm] = useState(
    () => typeof window !== "undefined" && new URLSearchParams(window.location.search).get("new") === "1",
  );
  const [now, setNow] = useState(() => Date.now());

  // Tick so countdowns ("in 23m", "due now") stay live without resubscribing.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const update = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));
  const [grouped, setGrouped] = useState(false);

  // Filters drive the list AND the rail so what's shown stays consistent. Stats
  // and the failure banner stay global — they're a health overview of everything.
  const filtered = useMemo(
    () => (tasks ?? []).filter((t: any) => matchesFilters(t, filters)),
    [tasks, filters]
  );

  const { active, paused, history } = useMemo(() => {
    return {
      active: filtered
        .filter((t: any) => t.status === "scheduled" || t.status === "running")
        .sort((a: any, b: any) => (a.run_at ?? Infinity) - (b.run_at ?? Infinity)),
      paused: filtered.filter((t: any) => t.status === "paused"),
      history: filtered
        .filter((t: any) => t.status === "completed" || t.status === "failed")
        .sort((a: any, b: any) => (b.last_run_at ?? b.created_at) - (a.last_run_at ?? a.created_at)),
    };
  }, [filtered]);

  const stats = useMemo(() => computeStats(tasks ?? [], now), [tasks, now]);
  const failingActive = useMemo(
    () => (tasks ?? []).filter((t: any) => (t.status === "scheduled" || t.status === "running") && t.retry_count > 0),
    [tasks]
  );
  const projects = useMemo(
    () => ([...new Set((tasks ?? []).map((t: any) => t.project_path).filter(Boolean))] as string[]).sort(),
    [tasks]
  );
  const hasCodex = useMemo(() => (tasks ?? []).some((t: any) => t.agent_type === "codex"), [tasks]);

  const activeSubtitle = useMemo(() => {
    const recurring = active.filter((t: any) => t.schedule_type === "recurring").length;
    const oneTime = active.filter((t: any) => t.schedule_type === "once").length;
    const events = active.filter((t: any) => t.schedule_type === "event").length;
    const parts: string[] = [];
    if (recurring > 0) parts.push(`${recurring} recurring`);
    if (oneTime > 0) parts.push(`${oneTime} one-time`);
    if (events > 0) parts.push(`${events} on event`);
    return parts.join(" · ") || undefined;
  }, [active]);
  const historyFailed = useMemo(() => history.filter((t: any) => t.status === "failed").length, [history]);

  // The soonest upcoming run gets an "up next" accent. active is sorted by run_at
  // ascending, so the first scheduled row with a future run_at is the winner.
  const nextId = useMemo(() => {
    const next = active.find((t: any) => t.status === "scheduled" && t.run_at && t.run_at > now);
    return next?._id as string | undefined;
  }, [active, now]);

  const hasTasks = tasks !== undefined && tasks.length > 0;
  const anyShown = active.length + paused.length + history.length > 0;

  return (
    <div className="h-full overflow-y-auto bg-sol-bg">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="flex items-center gap-2 mb-5">
          <Zap className="w-4 h-4 text-sol-cyan" />
          <h1 className="text-lg font-semibold text-sol-text">Triggers</h1>
          <span className="text-xs text-sol-text-dim">async agent runs</span>
          <button
            onClick={() => setShowForm((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-sol-cyan text-sol-bg hover:bg-sol-cyan/90 active:scale-[0.97] transition-all"
          >
            <Plus className="w-3.5 h-3.5" /> New trigger
          </button>
        </div>

        {hasTasks && (
          <StatStrip
            stats={stats}
            now={now}
            typeFilter={filters.type}
            onToggleType={(type) => update({ type: filters.type === type ? "all" : type })}
          />
        )}
        {hasTasks && <AttentionBanner tasks={failingActive} />}

        {showForm && <TriggerForm onClose={() => setShowForm(false)} />}

        {tasks === undefined ? (
          <AppLoader className="min-h-[16rem] h-full" />
        ) : tasks.length === 0 && !showForm ? (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
            <Zap className="w-8 h-8 text-sol-text-dim" />
            <p className="text-sm text-sol-text-muted">No triggers yet</p>
            <p className="text-xs text-sol-text-dim max-w-sm">
              Set triggers to run agents later — check CI, review PRs, continue work — from here or any session:
            </p>
            <code className="font-mono text-xs text-sol-text-muted bg-sol-bg-alt border border-sol-border rounded-md px-3 py-1.5">
              cast trigger add "Check CI on main" --in 30m
            </code>
            <button
              onClick={() => setShowForm(true)}
              className="mt-2 inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-sol-cyan text-sol-bg hover:bg-sol-cyan/90 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" /> New trigger
            </button>
          </div>
        ) : (
          <>
            <HorizonRail tasks={active} now={now} />
            <FilterBar
              filters={filters}
              update={update}
              projects={projects}
              hasCodex={hasCodex}
              shown={filtered.length}
              total={tasks.length}
              grouped={grouped}
              setGrouped={setGrouped}
            />
            {!anyShown ? (
              <FilteredEmpty onClear={() => update(EMPTY_FILTERS)} />
            ) : (
              <div className="reveal reveal-2">
                <Section title="Active" count={active.length} subtitle={activeSubtitle}>
                  <RowList tasks={active} now={now} grouped={grouped} nextId={nextId} />
                </Section>
                <Section title="Paused" count={paused.length}>
                  <RowList tasks={paused} now={now} grouped={grouped} />
                </Section>
                <Section
                  title="History"
                  count={history.length}
                  subtitle={historyFailed > 0 ? `${historyFailed} failed` : "all succeeded"}
                  defaultOpen={active.length === 0}
                >
                  <HistoryBody tasks={history} now={now} grouped={grouped} />
                </Section>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default function TriggersPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <TriggersContent />
      </DashboardLayout>
    </AuthGuard>
  );
}
