"use client";

import { useState, useCallback } from "react";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Badge } from "./ui/badge";
import { toast } from "sonner";
import {
  Circle,
  CircleDot,
  CheckCircle2,
  PauseCircle,
  XCircle,
  MessageSquare,
  Clock,
  Lightbulb,
  GitBranch,
  ExternalLink,
  FileText,
  ChevronDown,
  ChevronRight,
  Plus,
  ArrowUp,
  ArrowDown,
  Minus,
  AlertTriangle,
} from "lucide-react";
import Markdown from "react-markdown";

const api = _api as any;

const STATUS_CONFIG: Record<string, { icon: typeof Circle; label: string; color: string }> = {
  draft: { icon: Circle, label: "Draft", color: "text-sol-text-dim" },
  active: { icon: CircleDot, label: "Active", color: "text-sol-cyan" },
  paused: { icon: PauseCircle, label: "Paused", color: "text-sol-yellow" },
  done: { icon: CheckCircle2, label: "Done", color: "text-sol-green" },
  abandoned: { icon: XCircle, label: "Abandoned", color: "text-sol-text-dim" },
};

const TASK_STATUS_CONFIG: Record<string, { icon: typeof Circle; color: string; label: string }> = {
  open: { icon: Circle, color: "text-sol-blue", label: "Open" },
  in_progress: { icon: CircleDot, color: "text-sol-yellow", label: "In Progress" },
  done: { icon: CheckCircle2, color: "text-sol-green", label: "Done" },
  dropped: { icon: XCircle, color: "text-sol-text-dim", label: "Dropped" },
  draft: { icon: Circle, color: "text-sol-text-dim", label: "Draft" },
};

const TASK_STATUS_CYCLE = ["open", "in_progress", "done"];

const PRIORITY_CONFIG: Record<string, { icon: typeof Minus; color: string }> = {
  urgent: { icon: AlertTriangle, color: "text-sol-red" },
  high: { icon: ArrowUp, color: "text-sol-orange" },
  medium: { icon: Minus, color: "text-sol-text-dim" },
  low: { icon: ArrowDown, color: "text-sol-text-dim" },
};

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function getRelativeTime(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatDuration(startMs: number, endMs: number): string {
  const mins = Math.floor((endMs - startMs) / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem > 0 ? `${hours}h ${rem}m` : `${hours}h`;
}

const OUTCOME_STYLES: Record<string, { border: string; label: string; badge: string }> = {
  shipped: { border: "border-l-sol-green/60", label: "shipped", badge: "bg-sol-green/10 text-sol-green/70" },
  progress: { border: "border-l-sol-yellow/40", label: "progress", badge: "bg-sol-yellow/8 text-sol-yellow/60" },
  blocked: { border: "border-l-sol-red/50", label: "blocked", badge: "bg-sol-red/12 text-sol-red/70" },
  unknown: { border: "border-l-sol-text-dim/15", label: "", badge: "" },
};

function CollapsibleDoc({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const MAX_HEIGHT = 200;

  return (
    <div className="mb-6 border border-sol-border/30 rounded-lg bg-sol-bg-alt/30 overflow-hidden">
      <div className="relative overflow-hidden" style={expanded ? undefined : { maxHeight: MAX_HEIGHT }}>
        <div className="p-6 prose prose-invert prose-sm max-w-none
          prose-headings:text-sol-text prose-headings:font-semibold prose-headings:mt-4 prose-headings:mb-2
          prose-p:text-sol-text-muted prose-p:leading-relaxed
          prose-li:text-sol-text-muted prose-li:marker:text-sol-text-dim
          prose-code:text-sol-cyan prose-code:bg-sol-bg-highlight prose-code:px-1 prose-code:rounded prose-code:text-xs
          prose-strong:text-sol-text prose-a:text-sol-cyan
          [&_pre]:overflow-x-auto [&_pre]:max-w-full">
          <Markdown>{content}</Markdown>
        </div>
        {!expanded && (
          <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-sol-bg-alt/80 to-transparent" />
        )}
      </div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-center gap-1 py-2 text-xs text-sol-text-dim hover:text-sol-text border-t border-sol-border/20 transition-colors"
      >
        <FileText className="w-3 h-3" />
        {expanded ? "Collapse document" : "Expand full document"}
        {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
      </button>
    </div>
  );
}

function PlanSessionCard({ session: s }: { session: any }) {
  const outcome = OUTCOME_STYLES[s.outcome_type] || OUTCOME_STYLES.unknown;
  const isActive = s.is_active;
  const project = s.project_path?.split("/").filter(Boolean).pop();
  const duration = s.started_at && s.updated_at ? formatDuration(s.started_at, s.updated_at) : null;
  const time = getRelativeTime(s.updated_at || s.started_at);
  const msgCount = s.message_count || 0;

  return (
    <Link
      href={`/conversation/${s.session_id}`}
      className={`group block border-l-2 ${outcome.border} pl-3 py-2 hover:bg-sol-bg-alt/30 transition-colors rounded-r`}
    >
      <div className="flex items-center gap-1.5 min-w-0">
        <span className="font-semibold text-[13px] text-sol-text truncate hover:text-sol-yellow transition-colors">
          {s.title || "Untitled session"}
        </span>
        {isActive && (
          <span className="flex items-center gap-0.5 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-sol-green animate-pulse" />
            <span className="text-[8px] text-sol-green/60 font-medium uppercase tracking-wider">live</span>
          </span>
        )}
        {project && (
          <span className="font-mono rounded px-1 py-px shrink-0 text-[9px] bg-sol-bg-alt text-sol-text-dim/50">
            {project}
          </span>
        )}
        <span className="flex-1" />
        {outcome.label && (
          <span className={`rounded-full px-1.5 py-px shrink-0 font-medium text-[9px] ${outcome.badge}`}>
            {outcome.label}
          </span>
        )}
        <span className="font-mono text-sol-text-dim/35 tabular-nums shrink-0 whitespace-nowrap text-[10px]">
          {time}
        </span>
      </div>
      {s.headline && (
        <p className="mt-0.5 text-[12px] text-sol-text-muted/60 leading-snug truncate">
          {s.headline}
        </p>
      )}
      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-sol-text-dim/30 font-mono">
        {duration && <span>{duration}</span>}
        {msgCount > 0 && <span>{msgCount} msgs</span>}
        {s.git_branch && s.git_branch !== "main" && s.git_branch !== "master" && (
          <span>{s.git_branch}</span>
        )}
      </div>
    </Link>
  );
}

function PlanTaskSection({ planShortId, tasks }: { planShortId: string; tasks: any[] }) {
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [showDone, setShowDone] = useState(false);
  const webUpdate = useMutation(api.tasks.webUpdate);
  const webCreate = useMutation(api.tasks.webCreate);

  const cycleStatus = useCallback(async (shortId: string, currentStatus: string) => {
    const idx = TASK_STATUS_CYCLE.indexOf(currentStatus);
    const next = TASK_STATUS_CYCLE[(idx + 1) % TASK_STATUS_CYCLE.length];
    try {
      await webUpdate({ short_id: shortId, status: next });
      toast.success(`${shortId} -> ${next}`);
    } catch {
      toast.error("Failed to update");
    }
  }, [webUpdate]);

  const handleAdd = useCallback(async () => {
    if (!newTitle.trim()) return;
    try {
      await webCreate({ title: newTitle.trim(), plan_id: planShortId });
      setNewTitle("");
      setShowAdd(false);
      toast.success("Task created");
    } catch {
      toast.error("Failed to create task");
    }
  }, [newTitle, planShortId, webCreate]);

  const activeTasks = tasks.filter(t => t.status !== "done" && t.status !== "dropped");
  const doneTasks = tasks.filter(t => t.status === "done" || t.status === "dropped");

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="flex items-center gap-2 text-sm font-medium text-sol-text">
          <CheckCircle2 className="w-4 h-4 text-sol-text-dim" />
          Tasks ({tasks.length})
        </h2>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1 text-xs text-sol-cyan hover:text-sol-text transition-colors"
        >
          <Plus className="w-3 h-3" />
          Add
        </button>
      </div>

      {showAdd && (
        <div className="flex gap-2 mb-2">
          <input
            autoFocus
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") handleAdd(); if (e.key === "Escape") setShowAdd(false); }}
            placeholder="Task title..."
            className="flex-1 text-sm px-3 py-1.5 rounded-lg bg-sol-bg-alt border border-sol-border/50 text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan"
          />
          <button onClick={handleAdd} disabled={!newTitle.trim()} className="px-3 py-1.5 text-xs rounded-lg bg-sol-cyan text-sol-bg hover:opacity-90 disabled:opacity-40 transition-opacity">
            Create
          </button>
        </div>
      )}

      <div className="border border-sol-border/20 rounded-lg overflow-hidden">
        {activeTasks.map((task: any) => {
          const tc = TASK_STATUS_CONFIG[task.status] || TASK_STATUS_CONFIG.open;
          const TaskIcon = tc.icon;
          const pc = task.priority ? PRIORITY_CONFIG[task.priority] : null;
          const PriorityIcon = pc?.icon;
          return (
            <div key={task._id} className="flex items-center gap-2.5 px-3 py-2 border-b border-sol-border/10 last:border-b-0 group">
              <button
                onClick={() => cycleStatus(task.short_id, task.status)}
                title={`${tc.label} (click to cycle)`}
                className="flex-shrink-0 hover:scale-110 transition-transform"
              >
                <TaskIcon className={`w-3.5 h-3.5 ${tc.color}`} />
              </button>
              <Link href={`/tasks/${task._id}`} className="flex-1 min-w-0 flex items-center gap-2 hover:text-sol-cyan transition-colors">
                <span className="text-xs font-mono text-sol-text-dim">{task.short_id}</span>
                <span className="text-sm text-sol-text truncate">{task.title}</span>
              </Link>
              {PriorityIcon && pc && (
                <PriorityIcon className={`w-3 h-3 flex-shrink-0 ${pc.color}`} />
              )}
            </div>
          );
        })}
        {doneTasks.length > 0 && (
          <>
            <button
              onClick={() => setShowDone(!showDone)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-sol-text-dim hover:text-sol-text border-b border-sol-border/10 last:border-b-0 transition-colors"
            >
              {showDone ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
              {doneTasks.length} completed
            </button>
            {showDone && doneTasks.map((task: any) => {
              const tc = TASK_STATUS_CONFIG[task.status] || TASK_STATUS_CONFIG.done;
              const TaskIcon = tc.icon;
              return (
                <div key={task._id} className="flex items-center gap-2.5 px-3 py-2 border-b border-sol-border/10 last:border-b-0 opacity-50">
                  <TaskIcon className={`w-3.5 h-3.5 ${tc.color} flex-shrink-0`} />
                  <Link href={`/tasks/${task._id}`} className="flex-1 min-w-0 flex items-center gap-2">
                    <span className="text-xs font-mono text-sol-text-dim">{task.short_id}</span>
                    <span className="text-sm text-sol-text-muted line-through truncate">{task.title}</span>
                  </Link>
                </div>
              );
            })}
          </>
        )}
        {tasks.length === 0 && (
          <div className="px-3 py-4 text-center text-xs text-sol-text-dim">
            No tasks yet
          </div>
        )}
      </div>
    </div>
  );
}

export function PlanDetailPanel({ planId }: { planId: string }) {
  const queryArgs = planId.startsWith("pl-") ? { short_id: planId } : { id: planId };
  const plan = useQuery(api.plans.webGet, queryArgs);

  if (plan === undefined) {
    return (
      <div className="flex items-center justify-center h-48 text-sol-text-dim">
        <span className="text-sm">Loading...</span>
      </div>
    );
  }

  if (plan === null) {
    return (
      <div className="flex items-center justify-center h-48 text-sol-text-dim">
        <span className="text-sm">Plan not found</span>
      </div>
    );
  }

  const status = STATUS_CONFIG[plan.status] || STATUS_CONFIG.draft;
  const StatusIcon = status.icon;

  return (
    <div className="max-w-3xl mx-auto px-6 py-6">
      <div className="mb-6">
        <div className="flex items-center gap-2.5 mb-2">
          <StatusIcon className={`w-5 h-5 ${status.color}`} />
          <h1 className="text-xl font-semibold text-sol-text">{plan.title}</h1>
          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${status.color} border-current/30`}>
            {status.label}
          </Badge>
        </div>
        <div className="flex items-center gap-3 text-xs text-sol-text-dim">
          {plan.author?.image && (
            <img src={plan.author.image} className="w-4 h-4 rounded-full" alt="" />
          )}
          {plan.author?.name && <span>{plan.author.name}</span>}
          <span className="font-mono">{plan.short_id}</span>
          <span>Created {formatTimestamp(plan.created_at)}</span>
          <span>Updated {formatTimestamp(plan.updated_at)}</span>
        </div>
        {plan.goal && (
          <p className="mt-3 text-sm text-sol-text-muted leading-relaxed">{plan.goal}</p>
        )}
        {plan.acceptance_criteria?.length > 0 && (
          <div className="mt-3">
            <h3 className="text-xs font-medium text-sol-text-dim uppercase tracking-wider mb-1">Acceptance Criteria</h3>
            <ul className="text-sm text-sol-text-muted space-y-0.5">
              {plan.acceptance_criteria.map((c: string, i: number) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-sol-text-dim mt-0.5">-</span>
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {plan.doc_content && <CollapsibleDoc content={plan.doc_content} />}

      {plan.progress && plan.progress.total > 0 && (
        <div className="mb-6 p-3 bg-sol-bg-alt/30 rounded-lg border border-sol-border/20">
          <div className="flex items-center gap-3">
            <div className="flex-1 h-2 bg-sol-border/30 rounded-full overflow-hidden">
              <div className="h-full flex">
                <div className="bg-sol-green transition-all" style={{ width: `${(plan.progress.done / plan.progress.total) * 100}%` }} />
                <div className="bg-sol-yellow transition-all" style={{ width: `${(plan.progress.in_progress / plan.progress.total) * 100}%` }} />
              </div>
            </div>
            <span className="text-xs text-sol-text-dim tabular-nums whitespace-nowrap">
              {plan.progress.done} done, {plan.progress.in_progress} in progress, {plan.progress.open} open
            </span>
          </div>
        </div>
      )}

      <PlanTaskSection planShortId={plan.short_id} tasks={plan.tasks || []} />

      {plan.sessions?.length > 0 && (
        <div className="mb-6">
          <h2 className="flex items-center gap-2 text-sm font-medium text-sol-text mb-2">
            <MessageSquare className="w-4 h-4 text-sol-text-dim" />
            Sessions ({plan.sessions.length})
          </h2>
          <div className="space-y-1.5">
            {plan.sessions.map((s: any) => (
              <PlanSessionCard key={s._id} session={s} />
            ))}
          </div>
        </div>
      )}

      {plan.progress_log?.length > 0 && (
        <div className="mb-6">
          <h2 className="flex items-center gap-2 text-sm font-medium text-sol-text mb-2">
            <Clock className="w-4 h-4 text-sol-text-dim" />
            Progress Log
          </h2>
          <div className="space-y-2">
            {[...plan.progress_log].reverse().map((entry: any, i: number) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <span className="text-[11px] text-sol-text-dim tabular-nums whitespace-nowrap mt-0.5">
                  {formatTimestamp(entry.timestamp)}
                </span>
                <span className="text-sol-text-muted">{entry.entry}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {plan.decision_log?.length > 0 && (
        <div className="mb-6">
          <h2 className="flex items-center gap-2 text-sm font-medium text-sol-text mb-2">
            <GitBranch className="w-4 h-4 text-sol-text-dim" />
            Decisions
          </h2>
          <div className="space-y-3">
            {plan.decision_log.map((d: any, i: number) => (
              <div key={i} className="text-sm">
                <span className="text-sol-text">{d.decision}</span>
                {d.rationale && (
                  <p className="text-xs text-sol-text-dim mt-0.5">{d.rationale}</p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {plan.discoveries?.length > 0 && (
        <div className="mb-6">
          <h2 className="flex items-center gap-2 text-sm font-medium text-sol-text mb-2">
            <Lightbulb className="w-4 h-4 text-sol-text-dim" />
            Discoveries
          </h2>
          <div className="space-y-1.5">
            {plan.discoveries.map((d: any, i: number) => (
              <p key={i} className="text-sm text-sol-text-muted">{d.finding}</p>
            ))}
          </div>
        </div>
      )}

      {plan.context_pointers?.length > 0 && (
        <div className="mb-6">
          <h2 className="flex items-center gap-2 text-sm font-medium text-sol-text mb-2">
            <ExternalLink className="w-4 h-4 text-sol-text-dim" />
            Context
          </h2>
          <div className="space-y-1">
            {plan.context_pointers.map((cp: any, i: number) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <span className="text-sol-text-dim">{cp.label}:</span>
                <span className="text-sol-text-muted font-mono text-xs">{cp.path_or_url}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
