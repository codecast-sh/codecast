"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { toast } from "sonner";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
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
} from "lucide-react";

const api = _api as any;

// ── Time helpers (parseDuration is a parity port of `cast schedule add --in/--every`) ──

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

function fmtDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return remMins ? `${hours}h ${remMins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours ? `${days}d ${remHours}h` : `${days}d`;
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

function fmtClock(ts: number): string {
  const d = new Date(ts);
  const sameDay = new Date().toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
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

const STATUS_META: Record<string, { label: string; text: string; dot: string }> = {
  scheduled: { label: "scheduled", text: "text-sol-cyan", dot: "bg-sol-cyan" },
  running: { label: "running", text: "text-emerald-400", dot: "bg-emerald-400 animate-pulse" },
  paused: { label: "paused", text: "text-sol-yellow", dot: "bg-sol-yellow" },
  completed: { label: "done", text: "text-sol-text-dim", dot: "bg-sol-text-dim" },
  failed: { label: "failed", text: "text-sol-red", dot: "bg-sol-red" },
};

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
    <div className="rounded-xl border border-sol-border bg-sol-card px-5 pt-4 pb-2 mb-6 select-none">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-medium uppercase tracking-widest text-sol-text-dim">Next 24 hours</span>
        <span className="text-[10px] text-sol-text-dim flex items-center gap-3">
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-sol-cyan inline-block" /> propose</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-sol-orange inline-block" /> apply</span>
          <span className="flex items-center gap-1"><span className="w-1.5 h-1.5 rounded-full bg-sol-cyan/30 inline-block" /> recurring</span>
        </span>
      </div>
      <div className="relative h-10">
        {/* baseline */}
        <div className="absolute left-0 right-0 top-1/2 h-px bg-sol-border" />
        {/* hour ticks */}
        {[0, 0.25, 0.5, 0.75, 1].map((p) => (
          <div key={p} className="absolute top-1/2 -translate-y-1/2 h-2.5 w-px bg-sol-border" style={{ left: `${p * 100}%` }} />
        ))}
        {/* dots */}
        {points.map((pt, i) => {
          const isApply = pt.task.mode === "apply";
          const base = isApply ? "bg-sol-orange" : "bg-sol-cyan";
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
                <span className="font-medium">{pt.task.title}</span>
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

function ScheduleChip({ task, now }: { task: any; now: number }) {
  if (task.schedule_type === "recurring" && task.interval_ms) {
    return (
      <span className={`${chipCls} text-sol-violet`}>
        <Repeat className="w-3 h-3" />every {fmtDuration(task.interval_ms)}
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
        <Clock className="w-3 h-3" />{fmtCountdown(task.run_at - now)}
      </span>
    );
  }
  return (
    <span className={`${chipCls} text-sol-text-dim`}>
      <Clock className="w-3 h-3" />once
    </span>
  );
}

// ── Task row ──

function TaskRow({ task, now }: { task: any; now: number }) {
  const [expanded, setExpanded] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pause = useMutation(api.agentTasks.webPause);
  const resume = useMutation(api.agentTasks.webResume);
  const runNow = useMutation(api.agentTasks.webRunNow);
  const cancel = useMutation(api.agentTasks.webCancel);
  const del = useMutation(api.agentTasks.webDelete);

  const sm = STATUS_META[task.status] ?? STATUS_META.scheduled;
  const isActive = task.status === "scheduled" || task.status === "running";
  const isHistory = task.status === "completed" || task.status === "failed";
  const failedSummary = task.status === "failed" || task.last_run_summary?.startsWith("Failed");

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

  return (
    <div
      className={`group rounded-lg border bg-sol-card hover:bg-sol-card-hover transition-colors cursor-pointer ${
        task.status === "failed" ? "border-sol-red/30" : "border-sol-border"
      } ${task.status === "running" ? "border-emerald-400/40" : ""}`}
      onClick={() => setExpanded((v) => !v)}
    >
      <div className="flex items-center gap-3 px-4 py-2.5">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${sm.dot}`} title={sm.label} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <span className={`text-sm font-medium truncate ${isHistory ? "text-sol-text-muted" : "text-sol-text"}`}>
              {task.title}
            </span>
            <ScheduleChip task={task} now={now} />
            {task.mode === "apply" && (
              <span className="text-[10px] font-semibold uppercase tracking-wide text-sol-orange border border-sol-orange/40 rounded px-1 py-px flex-shrink-0">
                apply
              </span>
            )}
            {task.agent_type === "codex" && (
              <span className="inline-flex items-center gap-1 text-[11px] text-sol-text-dim flex-shrink-0">
                <Bot className="w-3 h-3" />codex
              </span>
            )}
            {task.project_path && (
              <span
                className="hidden sm:inline-flex items-center gap-1 text-[11px] text-sol-text-dim flex-shrink-0"
                title={task.project_path}
              >
                <Folder className="w-3 h-3" />{projectName(task.project_path)}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-sol-text-dim min-w-0">
            {task.status === "running" && <span className="text-emerald-400">running now</span>}
            {task.run_count > 0 && (
              <span className="flex-shrink-0">
                {task.run_count} run{task.run_count === 1 ? "" : "s"}
              </span>
            )}
            {task.last_run_at && <span className="flex-shrink-0">last {timeAgo(task.last_run_at)}</span>}
            {task.retry_count > 0 && <span className="text-sol-orange flex-shrink-0">{task.retry_count} retries</span>}
            {task.last_run_summary && (
              <span className={`truncate ${failedSummary ? "text-sol-red" : ""}`}>
                {task.last_run_summary}
              </span>
            )}
            {task.last_run_conversation_id && (
              <Link
                href={`/conversation/${task.last_run_conversation_id}`}
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-0.5 text-sol-cyan hover:underline underline-offset-2 flex-shrink-0"
                title={task.last_run_conversation_title}
              >
                view run <ExternalLink className="w-3 h-3" />
              </Link>
            )}
          </div>
        </div>

        <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
          {isActive && (
            <>
              <button className={iconBtn} title="Run now (daemon picks it up within ~30s)" onClick={act(() => runNow({ task_id: task._id }), "Queued — runs within ~30s")}>
                <Play className="w-3.5 h-3.5" />
              </button>
              <button className={iconBtn} title="Pause" onClick={act(() => pause({ task_id: task._id }), "Paused")}>
                <Pause className="w-3.5 h-3.5" />
              </button>
              <button className={iconBtn} title="Cancel" onClick={act(() => cancel({ task_id: task._id }), "Cancelled")}>
                <X className="w-3.5 h-3.5" />
              </button>
            </>
          )}
          {task.status === "paused" && (
            <>
              <button className={iconBtn} title="Resume" onClick={act(() => resume({ task_id: task._id }), "Resumed")}>
                <Play className="w-3.5 h-3.5" />
              </button>
              <button className={iconBtn} title="Cancel" onClick={act(() => cancel({ task_id: task._id }), "Cancelled")}>
                <X className="w-3.5 h-3.5" />
              </button>
            </>
          )}
          {isHistory && (
            <>
              <button className={iconBtn} title="Run again" onClick={act(() => runNow({ task_id: task._id }), "Re-armed — runs within ~30s")}>
                <RotateCcw className="w-3.5 h-3.5" />
              </button>
              <button
                className={`${iconBtn} ${confirmDelete ? "text-sol-red hover:text-sol-red" : ""}`}
                title={confirmDelete ? "Click again to delete" : "Delete"}
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
            </>
          )}
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-3 pt-1 border-t border-sol-border cursor-auto" onClick={(e) => e.stopPropagation()}>
          <div className="text-xs text-sol-text-muted font-mono whitespace-pre-wrap bg-sol-bg-alt rounded-md p-3 mt-2">
            {task.prompt}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-sol-text-dim">
            {task.run_at && task.status === "scheduled" && <span>next run {fmtClock(task.run_at)}</span>}
            <span>mode {task.mode}</span>
            <span>agent {task.agent_type || "claude"}</span>
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
        </div>
      )}
    </div>
  );
}

// ── New schedule composer ──

type SchedKind = "now" | "in" | "every" | "on";

function NewScheduleForm({ onClose }: { onClose: () => void }) {
  const create = useMutation(api.agentTasks.webCreate);
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<SchedKind>("in");
  const [duration, setDuration] = useState("30m");
  const [eventKey, setEventKey] = useState("pr_comment");
  const [mode, setMode] = useState<"propose" | "apply">("propose");
  const [agent, setAgent] = useState<"claude" | "codex">("claude");
  const [project, setProject] = useState("");
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
        project_path: project.trim() || undefined,
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
      await create(args);
      toast.success(kind === "now" ? "Queued — runs within ~30s" : "Scheduled");
      onClose();
    } catch {
      toast.error("Failed to schedule");
    } finally {
      setSubmitting(false);
    }
  };

  const seg = (active: boolean) =>
    `px-2.5 py-1 rounded-md text-xs transition-colors ${
      active ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"
    }`;

  return (
    <div className="rounded-xl border border-sol-cyan/30 bg-sol-card p-4 mb-6">
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
        placeholder="Title (optional — defaults to the prompt)"
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
        <div className="flex items-center gap-1 bg-sol-bg-alt rounded-lg p-0.5" title="propose: read-only · apply: agent can make changes">
          <button className={seg(mode === "propose")} onClick={() => setMode("propose")}>propose</button>
          <button
            className={`${seg(mode === "apply")} ${mode === "apply" ? "!text-sol-orange" : ""}`}
            onClick={() => setMode("apply")}
          >
            apply
          </button>
        </div>
        <div className="flex items-center gap-1 bg-sol-bg-alt rounded-lg p-0.5">
          <button className={seg(agent === "claude")} onClick={() => setAgent("claude")}>claude</button>
          <button className={seg(agent === "codex")} onClick={() => setAgent("codex")}>codex</button>
        </div>
        <input
          value={project}
          onChange={(e) => setProject(e.target.value)}
          list="schedule-project-roots"
          placeholder="Project path (optional)"
          className="flex-1 min-w-[180px] bg-sol-bg-alt border border-sol-border rounded-lg px-2 py-1 text-xs font-mono text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan/60"
        />
        <datalist id="schedule-project-roots">
          {projectOptions.map((p) => <option key={p} value={p} />)}
        </datalist>
      </div>

      {mode === "apply" && (
        <p className="text-[11px] text-sol-orange mt-2">apply mode: the agent can make changes without review</p>
      )}

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
            {submitting ? "Scheduling…" : "Schedule"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Page ──

function Section({ title, count, children, defaultOpen = true }: {
  title: string;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (count === 0) return null;
  return (
    <div className="mb-6">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-widest text-sol-text-dim hover:text-sol-text-muted transition-colors mb-2 select-none"
      >
        {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {title}
        <span className="text-sol-text-dim/70 normal-case tracking-normal font-mono">{count}</span>
      </button>
      {open && <div className="flex flex-col gap-2">{children}</div>}
    </div>
  );
}

function SchedulesContent() {
  const tasks = useQuery(api.agentTasks.webList, {});
  const [showForm, setShowForm] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  // Tick so countdowns ("in 23m", "due now") stay live without resubscribing.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(id);
  }, []);

  const { active, paused, history } = useMemo(() => {
    const all = tasks ?? [];
    return {
      active: all
        .filter((t: any) => t.status === "scheduled" || t.status === "running")
        .sort((a: any, b: any) => (a.run_at ?? Infinity) - (b.run_at ?? Infinity)),
      paused: all.filter((t: any) => t.status === "paused"),
      history: all
        .filter((t: any) => t.status === "completed" || t.status === "failed")
        .sort((a: any, b: any) => (b.last_run_at ?? b.created_at) - (a.last_run_at ?? a.created_at)),
    };
  }, [tasks]);

  return (
    <div className="h-full overflow-y-auto bg-sol-bg">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <div className="flex items-center gap-2 mb-5">
          <Clock className="w-4 h-4 text-sol-cyan" />
          <h1 className="text-lg font-semibold text-sol-text">Schedules</h1>
          <span className="text-xs text-sol-text-dim">async agent runs</span>
          <button
            onClick={() => setShowForm((v) => !v)}
            className="ml-auto inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-sol-cyan text-sol-bg hover:bg-sol-cyan/90 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> New schedule
          </button>
        </div>

        {showForm && <NewScheduleForm onClose={() => setShowForm(false)} />}

        {tasks === undefined ? (
          <div className="text-sm text-sol-text-dim">Loading…</div>
        ) : tasks.length === 0 && !showForm ? (
          <div className="flex flex-col items-center justify-center gap-3 py-24 text-center">
            <Clock className="w-8 h-8 text-sol-text-dim" />
            <p className="text-sm text-sol-text-muted">Nothing scheduled yet</p>
            <p className="text-xs text-sol-text-dim max-w-sm">
              Schedule agents to run later — check CI, review PRs, continue work — from here or any session:
            </p>
            <code className="font-mono text-xs text-sol-text-muted bg-sol-bg-alt border border-sol-border rounded-md px-3 py-1.5">
              cast schedule add "Check CI on main" --in 30m
            </code>
            <button
              onClick={() => setShowForm(true)}
              className="mt-2 inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-sol-cyan text-sol-bg hover:bg-sol-cyan/90 transition-colors"
            >
              <Plus className="w-3.5 h-3.5" /> New schedule
            </button>
          </div>
        ) : (
          <>
            <HorizonRail tasks={active} now={now} />
            <Section title="Active" count={active.length}>
              {active.map((t: any) => <TaskRow key={t._id} task={t} now={now} />)}
            </Section>
            <Section title="Paused" count={paused.length}>
              {paused.map((t: any) => <TaskRow key={t._id} task={t} now={now} />)}
            </Section>
            <Section title="History" count={history.length} defaultOpen={active.length === 0}>
              {history.map((t: any) => <TaskRow key={t._id} task={t} now={now} />)}
            </Section>
          </>
        )}
      </div>
    </div>
  );
}

export default function SchedulesPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <SchedulesContent />
      </DashboardLayout>
    </AuthGuard>
  );
}
