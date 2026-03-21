import { useState, useCallback, useRef, useMemo } from "react";
import { useWatchEffect } from "../hooks/useWatchEffect";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { Badge } from "./ui/badge";
import { TaskStatusBadge, getExecStatusConfig } from "./TaskStatusBadge";
import { WorkflowContextPanel } from "./WorkflowContextPanel";
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
  Zap,
  Timer,
  Activity,
  Layers,
  Search,
  RotateCw,
  Play,
} from "lucide-react";
import Markdown from "react-markdown";
import { PlanBoardView } from "./PlanBoardView";
import { PlanGraphView } from "./PlanGraphView";

const api = _api as any;

export const PLAN_STATUS_CONFIG: Record<string, { icon: typeof Circle; label: string; color: string; bg: string }> = {
  draft: { icon: Circle, label: "Draft", color: "text-sol-text-dim", bg: "bg-sol-text-dim/10 border-sol-text-dim/30" },
  active: { icon: CircleDot, label: "Active", color: "text-sol-cyan", bg: "bg-sol-cyan/10 border-sol-cyan/30" },
  paused: { icon: PauseCircle, label: "Paused", color: "text-sol-yellow", bg: "bg-sol-yellow/10 border-sol-yellow/30" },
  done: { icon: CheckCircle2, label: "Done", color: "text-sol-green", bg: "bg-sol-green/10 border-sol-green/30" },
  abandoned: { icon: XCircle, label: "Abandoned", color: "text-sol-text-dim", bg: "bg-sol-text-dim/10 border-sol-text-dim/30" },
};

const STATUS_CONFIG = PLAN_STATUS_CONFIG;

const TASK_STATUS_CONFIG: Record<string, { icon: typeof Circle; color: string; label: string }> = {
  open: { icon: Circle, color: "text-sol-blue", label: "Open" },
  in_progress: { icon: CircleDot, color: "text-sol-yellow", label: "In Progress" },
  in_review: { icon: CircleDot, color: "text-sol-violet", label: "Review" },
  done: { icon: CheckCircle2, color: "text-sol-green", label: "Done" },
  dropped: { icon: XCircle, color: "text-sol-text-dim", label: "Dropped" },
  draft: { icon: Circle, color: "text-sol-text-dim", label: "Draft" },
};


const TASK_STATUS_CYCLE = ["open", "in_progress", "done"];

const PRIORITY_CONFIG: Record<string, { icon: typeof Minus; color: string; label: string }> = {
  urgent: { icon: AlertTriangle, color: "text-sol-red", label: "Urgent" },
  high: { icon: ArrowUp, color: "text-sol-orange", label: "High" },
  medium: { icon: Minus, color: "text-sol-text-dim", label: "Medium" },
  low: { icon: ArrowDown, color: "text-sol-text-dim", label: "Low" },
};

const PRIORITY_CYCLE = ["low", "medium", "high", "urgent"];

const ALL_TASK_STATUSES = ["open", "in_progress", "in_review", "done", "dropped", "backlog"];

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

export function PlanProgressBar({ progress }: { progress: { total: number; done: number; in_progress: number; open: number } }) {
  const { total, done, in_progress, open } = progress;
  const donePct = (done / total) * 100;
  const ipPct = (in_progress / total) * 100;
  const pctComplete = Math.round(donePct);
  const isComplete = done === total;

  return (
    <div className="mb-6 px-4 py-3.5 bg-sol-bg-alt/40 rounded-xl border border-sol-border/25">
      <div className="flex items-center justify-between mb-2.5">
        <div className="flex items-center gap-2">
          {isComplete ? (
            <CheckCircle2 className="w-3.5 h-3.5 text-sol-green" />
          ) : in_progress > 0 ? (
            <CircleDot className="w-3.5 h-3.5 text-sol-yellow animate-pulse" />
          ) : (
            <Circle className="w-3.5 h-3.5 text-sol-text-dim" />
          )}
          <span className="text-xs font-semibold text-sol-text">
            {isComplete ? "Complete" : in_progress > 0 ? "In Progress" : "Planned"}
          </span>
        </div>
        <span className={`text-xs font-mono font-bold tabular-nums ${isComplete ? "text-sol-green" : "text-sol-text-dim"}`}>
          {pctComplete}%
        </span>
      </div>
      <div className="h-2.5 bg-sol-border/40 rounded-full overflow-hidden mb-3">
        <div className="h-full flex transition-all duration-500">
          <div
            className={`h-full transition-all duration-700 ${isComplete ? "bg-sol-green" : "bg-sol-green/80"}`}
            style={{ width: `${donePct}%` }}
          />
          <div
            className="h-full bg-sol-yellow/60 transition-all duration-500"
            style={{ width: `${ipPct}%` }}
          />
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-sol-green/80" />
          <span className="text-[11px] text-sol-text-dim tabular-nums">{done} done</span>
        </div>
        {in_progress > 0 && (
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-sol-yellow/60" />
            <span className="text-[11px] text-sol-text-dim tabular-nums">{in_progress} active</span>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-sol-border/50" />
          <span className="text-[11px] text-sol-text-dim tabular-nums">{open} open</span>
        </div>
        <span className="text-[11px] text-sol-text-dim tabular-nums ml-auto">{done}/{total} tasks</span>
      </div>
    </div>
  );
}

export function DriveRoundIndicator({ driveState }: { driveState: { current_round: number; total_rounds: number; rounds: any[] } }) {
  const { current_round, total_rounds, rounds } = driveState;
  if (total_rounds === 0) return null;

  const completedRounds = rounds.length;
  const pct = (completedRounds / total_rounds) * 100;

  return (
    <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg bg-sol-violet/8 border border-sol-violet/20">
      <RotateCw className="w-3.5 h-3.5 text-sol-violet flex-shrink-0" />
      <span className="text-xs font-medium text-sol-violet">
        Round {current_round}/{total_rounds}
      </span>
      <div className="flex gap-0.5">
        {Array.from({ length: total_rounds }, (_, i) => {
          const roundNum = i + 1;
          const isCompleted = rounds.some((r: any) => r.round === roundNum);
          const isCurrent = roundNum === current_round && !isCompleted;
          return (
            <div
              key={i}
              className={`w-2 h-2 rounded-full transition-colors ${
                isCompleted
                  ? "bg-sol-green"
                  : isCurrent
                  ? "bg-sol-violet animate-pulse"
                  : "bg-sol-border/40"
              }`}
              title={`Round ${roundNum}${isCompleted ? " (done)" : isCurrent ? " (active)" : ""}`}
            />
          );
        })}
      </div>
      {completedRounds > 0 && completedRounds < total_rounds && (
        <span className="text-[10px] text-sol-text-dim tabular-nums">
          {Math.round(pct)}%
        </span>
      )}
    </div>
  );
}

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
        {project && project !== "unknown" && (
          <span className="font-mono rounded px-1 py-px shrink-0 text-[9px] bg-sol-bg-alt text-gray-500 dark:text-gray-400">
            {project}
          </span>
        )}
        <span className="flex-1" />
        {outcome.label && (
          <span className={`rounded-full px-1.5 py-px shrink-0 font-medium text-[9px] ${outcome.badge}`}>
            {outcome.label}
          </span>
        )}
        <span className="font-mono text-gray-400 dark:text-gray-500 tabular-nums shrink-0 whitespace-nowrap text-[10px]">
          {time}
        </span>
      </div>
      {s.headline && (
        <p className="mt-0.5 text-[12px] text-gray-500 dark:text-gray-400 leading-snug truncate">
          {s.headline}
        </p>
      )}
      <div className="mt-0.5 flex items-center gap-2 text-[10px] text-gray-400 dark:text-gray-500 font-mono">
        {duration && <span>{duration}</span>}
        {msgCount > 0 && <span>{msgCount} msgs</span>}
        {s.git_branch && s.git_branch !== "main" && s.git_branch !== "master" && (
          <span>{s.git_branch}</span>
        )}
      </div>
    </Link>
  );
}

function TaskExecutionDetail({ task }: { task: any }) {
  const hasExec = !!getExecStatusConfig(task.execution_status);
  const hasDetail = task.acceptance_criteria?.length || task.steps?.length || task.execution_concerns || task.files_changed?.length || task.verification_evidence;
  if (!hasDetail && !hasExec) return null;

  return (
    <div className="pl-9 pr-3 pb-2 space-y-2">
      {hasExec && (
        <TaskStatusBadge status={task.execution_status} type="execution" />
      )}
      {task.execution_concerns && (
        <div className="text-xs p-2 rounded bg-sol-yellow/5 border border-sol-yellow/20 text-sol-yellow/80">
          {task.execution_concerns}
        </div>
      )}
      {task.acceptance_criteria?.length > 0 && (
        <div className="space-y-0.5">
          {task.acceptance_criteria.map((ac: string, i: number) => (
            <div key={i} className="flex items-start gap-1.5 text-xs text-sol-text-muted">
              <span className="text-sol-text-dim mt-px">-</span>
              <span>{ac}</span>
            </div>
          ))}
        </div>
      )}
      {task.steps?.length > 0 && (
        <div className="space-y-0.5">
          {task.steps.map((s: any, i: number) => (
            <div key={i} className="flex items-start gap-1.5 text-xs">
              <span className={`mt-px ${s.done ? "text-sol-green" : "text-sol-text-dim"}`}>
                {s.done ? "✓" : String(i + 1)}
              </span>
              <span className={s.done ? "text-sol-text-dim line-through" : "text-sol-text-muted"}>{s.title}</span>
            </div>
          ))}
        </div>
      )}
      {task.files_changed?.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {task.files_changed.map((f: string, i: number) => (
            <span key={i} className="text-[10px] font-mono px-1 py-px rounded bg-sol-bg-alt text-sol-text-dim">
              {f.split("/").pop()}
            </span>
          ))}
        </div>
      )}
      {(task.estimated_minutes || task.actual_minutes) && (
        <div className="flex items-center gap-2 text-[10px] text-sol-text-dim">
          {task.estimated_minutes && <span>est: {task.estimated_minutes}m</span>}
          {task.actual_minutes && <span>actual: {task.actual_minutes}m</span>}
        </div>
      )}
      {task.verification_evidence && (
        <div className="text-xs p-2 rounded bg-sol-green/5 border border-sol-green/20 text-sol-green/70 font-mono">
          {task.verification_evidence}
        </div>
      )}
    </div>
  );
}

function TaskSessionCards({ sessions }: { sessions: any[] }) {
  if (!sessions.length) return null;
  return (
    <div className="pl-9 pr-3 pb-2 space-y-1">
      {sessions.map((s: any) => (
        <Link
          key={s._id}
          href={`/conversation/${s.session_id}`}
          className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-sol-bg-alt/40 transition-colors group/session"
        >
          <MessageSquare className="w-3 h-3 text-sol-text-dim/40 flex-shrink-0" />
          <span className="text-xs text-sol-text-muted truncate group-hover/session:text-sol-cyan transition-colors">
            {s.title || "Untitled session"}
          </span>
          {s.is_active && (
            <span className="flex items-center gap-0.5 flex-shrink-0">
              <span className="w-1.5 h-1.5 rounded-full bg-sol-green animate-pulse" />
              <span className="text-[8px] text-sol-green/60 font-medium uppercase">live</span>
            </span>
          )}
          <span className="flex-1" />
          {s.message_count > 0 && (
            <span className="text-[10px] text-sol-text-dim/30 font-mono tabular-nums">{s.message_count} msgs</span>
          )}
          <span className="text-[10px] text-gray-400 dark:text-gray-500 font-mono tabular-nums">{getRelativeTime(s.updated_at || s.started_at)}</span>
        </Link>
      ))}
    </div>
  );
}

export function OrchestrationHeader({ tasks, sessions }: { tasks: any[]; sessions: any[] }) {
  const activeAgents = tasks.filter((t: any) => t.activeSession);
  const doneTasks = tasks.filter((t: any) => t.status === "done");
  const blockedTasks = tasks.filter((t: any) => t.execution_status === "blocked" || t.execution_status === "needs_context");
  const concernTasks = tasks.filter((t: any) => t.execution_status === "done_with_concerns");

  const totalActual = tasks.reduce((sum: number, t: any) => sum + (t.actual_minutes || 0), 0);
  const remainingEstimated = tasks
    .filter((t: any) => t.status !== "done" && t.status !== "dropped")
    .reduce((sum: number, t: any) => sum + (t.estimated_minutes || 0), 0);

  if (tasks.length === 0) return null;

  const hasActiveWork = activeAgents.length > 0 || sessions.some((s: any) => s.is_active);

  return (
    <div className={`mb-5 rounded-lg border overflow-hidden ${hasActiveWork ? "border-emerald-500/30 bg-emerald-950/10" : "border-sol-border/20 bg-sol-bg-alt/20"}`}>
      <div className="px-4 py-3">
        <div className="flex items-center gap-3 mb-2.5">
          <Zap className={`w-4 h-4 ${hasActiveWork ? "text-emerald-600 dark:text-emerald-400" : "text-sol-text-dim"}`} />
          <span className={`text-xs font-semibold uppercase tracking-wider ${hasActiveWork ? "text-emerald-600 dark:text-emerald-400" : "text-sol-text-dim"}`}>
            {hasActiveWork ? "Live Orchestration" : "Orchestration"}
          </span>
          {hasActiveWork && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <div className="text-[10px] text-sol-text-dim uppercase tracking-wider mb-0.5">Agents</div>
            <div className="flex items-center gap-1.5">
              <span className={`text-lg font-semibold tabular-nums ${activeAgents.length > 0 ? "text-emerald-600 dark:text-emerald-400" : "text-sol-text-dim"}`}>
                {activeAgents.length}
              </span>
              <span className="text-[10px] text-sol-text-dim">
                / {tasks.filter((t: any) => t.status === "in_progress").length} assigned
              </span>
            </div>
          </div>

          <div>
            <div className="text-[10px] text-sol-text-dim uppercase tracking-wider mb-0.5">Completed</div>
            <div className="flex items-center gap-1.5">
              <span className="text-lg font-semibold tabular-nums text-sol-green">{doneTasks.length}</span>
              <span className="text-[10px] text-sol-text-dim">/ {tasks.length}</span>
            </div>
          </div>

          <div>
            <div className="text-[10px] text-sol-text-dim uppercase tracking-wider mb-0.5">Issues</div>
            <div className="flex items-center gap-2">
              {blockedTasks.length > 0 ? (
                <span className="text-lg font-semibold tabular-nums text-sol-red">{blockedTasks.length}</span>
              ) : concernTasks.length > 0 ? (
                <span className="text-lg font-semibold tabular-nums text-sol-yellow">{concernTasks.length}</span>
              ) : (
                <span className="text-lg font-semibold tabular-nums text-sol-text-dim">0</span>
              )}
              {blockedTasks.length > 0 && (
                <span className="text-[10px] text-sol-red">blocked</span>
              )}
              {concernTasks.length > 0 && blockedTasks.length === 0 && (
                <span className="text-[10px] text-sol-yellow">concerns</span>
              )}
            </div>
          </div>

          <div>
            <div className="text-[10px] text-sol-text-dim uppercase tracking-wider mb-0.5">Time</div>
            <div className="flex items-center gap-1.5">
              {remainingEstimated > 0 ? (
                <>
                  <Timer className="w-3 h-3 text-sol-text-dim" />
                  <span className="text-sm font-semibold tabular-nums text-sol-text">
                    {remainingEstimated < 60 ? `${remainingEstimated}m` : `${Math.floor(remainingEstimated / 60)}h ${remainingEstimated % 60}m`}
                  </span>
                  <span className="text-[10px] text-sol-text-dim">left</span>
                </>
              ) : totalActual > 0 ? (
                <>
                  <Timer className="w-3 h-3 text-sol-green" />
                  <span className="text-sm font-semibold tabular-nums text-sol-green">
                    {totalActual < 60 ? `${totalActual}m` : `${Math.floor(totalActual / 60)}h ${totalActual % 60}m`}
                  </span>
                  <span className="text-[10px] text-sol-text-dim">total</span>
                </>
              ) : (
                <span className="text-sm text-sol-text-dim">--</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {activeAgents.length > 0 && (
        <div className="border-t border-emerald-500/15 px-4 py-2.5 bg-emerald-950/5">
          <div className="flex flex-wrap gap-2">
            {activeAgents.map((t: any) => (
              <Link
                key={t._id}
                href={`/conversation/${t.activeSession.session_id}`}
                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-500/10 hover:bg-emerald-500/20 transition-colors group/agent"
              >
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
                <span className="text-xs font-mono text-sol-text-dim">{t.short_id}</span>
                <span className="text-xs text-emerald-700 dark:text-emerald-300/80 truncate max-w-[200px] group-hover/agent:text-emerald-800 dark:group-hover/agent:text-emerald-200 transition-colors">
                  {t.title}
                </span>
                <ExternalLink className="w-2.5 h-2.5 text-emerald-500 dark:text-emerald-400/40 group-hover/agent:text-emerald-600 dark:group-hover/agent:text-emerald-400/80 transition-colors flex-shrink-0" />
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function InlineEditTitle({ value, onSave, className }: { value: string; onSave: (newVal: string) => void; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useWatchEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const commit = useCallback(() => {
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) {
      onSave(trimmed);
    }
    setEditing(false);
  }, [draft, value, onSave]);

  if (!editing) {
    return (
      <span
        onClick={(e) => { e.stopPropagation(); setDraft(value); setEditing(true); }}
        className={`cursor-text hover:bg-sol-bg-alt/60 rounded px-0.5 -mx-0.5 transition-colors ${className || ""}`}
        title="Click to edit"
      >
        {value}
      </span>
    );
  }

  return (
    <input
      ref={inputRef}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") { setDraft(value); setEditing(false); }
      }}
      onClick={(e) => e.stopPropagation()}
      className="text-sm bg-sol-bg-alt border border-sol-cyan/50 rounded px-1.5 py-0.5 text-sol-text outline-none w-full min-w-0"
    />
  );
}

export function PlanTaskSection({ planShortId, tasks, sessions }: { planShortId: string; tasks: any[]; sessions: any[] }) {
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [showFilterBar, setShowFilterBar] = useState(false);
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

  const cyclePriority = useCallback(async (shortId: string, currentPriority: string) => {
    const idx = PRIORITY_CYCLE.indexOf(currentPriority || "medium");
    const next = PRIORITY_CYCLE[(idx + 1) % PRIORITY_CYCLE.length];
    try {
      await webUpdate({ short_id: shortId, priority: next });
      toast.success(`${shortId} priority -> ${next}`);
    } catch {
      toast.error("Failed to update priority");
    }
  }, [webUpdate]);

  const updateTitle = useCallback(async (shortId: string, newTitle: string) => {
    try {
      await webUpdate({ short_id: shortId, title: newTitle });
      toast.success(`${shortId} title updated`);
    } catch {
      toast.error("Failed to update title");
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

  const sessionsByTask = new Map<string, any[]>();
  const unlinkedSessions: any[] = [];
  for (const s of sessions) {
    if (s.active_task_id) {
      const existing = sessionsByTask.get(s.active_task_id) || [];
      existing.push(s);
      sessionsByTask.set(s.active_task_id, existing);
    } else {
      unlinkedSessions.push(s);
    }
  }

  const matchesFilter = useCallback((task: any) => {
    if (statusFilter && statusFilter !== "all" && task.status !== statusFilter) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const matchTitle = task.title?.toLowerCase().includes(q);
      const matchId = task.short_id?.toLowerCase().includes(q);
      if (!matchTitle && !matchId) return false;
    }
    return true;
  }, [searchQuery, statusFilter]);

  const activeTasks = useMemo(
    () => tasks.filter(t => t.status !== "done" && t.status !== "dropped").filter(matchesFilter),
    [tasks, matchesFilter]
  );
  const doneTasks = useMemo(
    () => tasks.filter(t => t.status === "done" || t.status === "dropped").filter(matchesFilter),
    [tasks, matchesFilter]
  );

  const hasActiveFilter = searchQuery || (statusFilter && statusFilter !== "all");

  return (
    <div className="mb-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="flex items-center gap-2 text-sm font-medium text-sol-text">
          <CheckCircle2 className="w-4 h-4 text-sol-text-dim" />
          Tasks ({tasks.length})
          {sessions.length > 0 && (
            <span className="text-xs text-sol-text-dim font-normal ml-1">
              / {sessions.length} session{sessions.length !== 1 ? "s" : ""}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-1.5">
          {tasks.length > 3 && (
            <button
              onClick={() => setShowFilterBar(!showFilterBar)}
              className={`flex items-center gap-1 text-xs transition-colors p-1 rounded ${
                showFilterBar || hasActiveFilter ? "text-sol-cyan bg-sol-cyan/10" : "text-sol-text-dim hover:text-sol-text"
              }`}
              title="Search and filter tasks"
            >
              <Search className="w-3 h-3" />
            </button>
          )}
          <button
            onClick={() => setShowAdd(!showAdd)}
            className="flex items-center gap-1 text-xs text-sol-cyan hover:text-sol-text transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add
          </button>
        </div>
      </div>

      {showFilterBar && (
        <div className="flex items-center gap-2 mb-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-sol-text-dim pointer-events-none" />
            <input
              autoFocus
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Filter tasks..."
              className="w-full text-xs pl-7 pr-3 py-1.5 rounded-lg bg-sol-bg-alt border border-sol-border/50 text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan"
            />
          </div>
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="text-xs px-2 py-1.5 rounded-lg bg-sol-bg-alt border border-sol-border/50 text-sol-text focus:outline-none focus:border-sol-cyan appearance-none cursor-pointer"
          >
            <option value="all">All statuses</option>
            {ALL_TASK_STATUSES.map(s => (
              <option key={s} value={s}>{TASK_STATUS_CONFIG[s]?.label || s}</option>
            ))}
          </select>
          {hasActiveFilter && (
            <button
              onClick={() => { setSearchQuery(""); setStatusFilter("all"); }}
              className="text-[10px] text-sol-text-dim hover:text-sol-text transition-colors whitespace-nowrap"
            >
              Clear
            </button>
          )}
        </div>
      )}

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
          const pc = task.priority ? PRIORITY_CONFIG[task.priority] : PRIORITY_CONFIG.medium;
          const PriorityIcon = pc?.icon;
          const hasExec = task.execution_status && !!getExecStatusConfig(task.execution_status);
          const isExpanded = expandedTask === task._id;
          const taskSessions = sessionsByTask.get(task._id.toString()) || [];
          const hasDetail = task.acceptance_criteria?.length || task.steps?.length || task.execution_concerns || task.files_changed?.length || taskSessions.length > 0;
          return (
            <div key={task._id} className="border-b border-sol-border/10 last:border-b-0">
              <div className="flex items-center gap-2.5 px-3 py-2 group">
                <button
                  onClick={() => cycleStatus(task.short_id, task.status)}
                  title={`${tc.label} (click to cycle)`}
                  className="flex-shrink-0 hover:scale-110 transition-transform"
                >
                  <TaskIcon className={`w-3.5 h-3.5 ${tc.color}`} />
                </button>
                <div className="flex-1 min-w-0 flex items-center gap-2">
                  <span className="text-xs font-mono text-sol-text-dim flex-shrink-0">{task.short_id}</span>
                  <InlineEditTitle
                    value={task.title}
                    onSave={(newVal) => updateTitle(task.short_id, newVal)}
                    className="text-sm text-sol-text truncate"
                  />
                </div>
                {task.activeSession && (
                  <Link
                    href={`/conversation/${task.activeSession.session_id}`}
                    onClick={(e: React.MouseEvent) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 text-[10px] hover:bg-emerald-500/25 transition-colors flex-shrink-0"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    live
                  </Link>
                )}
                {hasExec && (
                  <TaskStatusBadge status={task.execution_status} type="execution" className="flex-shrink-0" />
                )}
                {taskSessions.length > 0 && !task.activeSession && (
                  <span className="text-[10px] text-gray-400 dark:text-gray-500 flex-shrink-0 font-mono">
                    {taskSessions.length} sess
                  </span>
                )}
                {PriorityIcon && pc && (
                  <button
                    onClick={() => cyclePriority(task.short_id, task.priority || "medium")}
                    title={`${pc.label} priority (click to cycle)`}
                    className="flex-shrink-0 hover:scale-110 transition-transform"
                  >
                    <PriorityIcon className={`w-3 h-3 ${pc.color}`} />
                  </button>
                )}
                {hasDetail && (
                  <button onClick={() => setExpandedTask(isExpanded ? null : task._id)}>
                    <ChevronRight className={`w-3 h-3 text-gray-400 dark:text-gray-500 transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                  </button>
                )}
              </div>
              {isExpanded && (
                <>
                  <TaskExecutionDetail task={task} />
                  <TaskSessionCards sessions={taskSessions} />
                </>
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
              const taskSessions = sessionsByTask.get(task._id.toString()) || [];
              const isExpanded = expandedTask === task._id;
              return (
                <div key={task._id} className="border-b border-sol-border/10 last:border-b-0">
                  <div
                    className="flex items-center gap-2.5 px-3 py-2 opacity-50 cursor-pointer hover:opacity-70 transition-opacity"
                    onClick={() => setExpandedTask(isExpanded ? null : task._id)}
                  >
                    <button
                      onClick={(e) => { e.stopPropagation(); cycleStatus(task.short_id, task.status); }}
                      title={`${tc.label} (click to cycle)`}
                      className="flex-shrink-0 hover:scale-110 transition-transform"
                    >
                      <TaskIcon className={`w-3.5 h-3.5 ${tc.color}`} />
                    </button>
                    <span className="text-xs font-mono text-sol-text-dim">{task.short_id}</span>
                    <span className="text-sm text-sol-text-muted line-through truncate">{task.title}</span>
                    {taskSessions.length > 0 && (
                      <span className="text-[10px] text-gray-400 dark:text-gray-500 flex-shrink-0 font-mono ml-auto">
                        {taskSessions.length} sess
                      </span>
                    )}
                  </div>
                  {isExpanded && (
                    <>
                      <TaskExecutionDetail task={task} />
                      <TaskSessionCards sessions={taskSessions} />
                    </>
                  )}
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
        {hasActiveFilter && activeTasks.length === 0 && doneTasks.length === 0 && tasks.length > 0 && (
          <div className="px-3 py-4 text-center text-xs text-sol-text-dim">
            No tasks match filter
          </div>
        )}
      </div>

      {unlinkedSessions.length > 0 && (
        <div className="mt-3">
          <h3 className="text-xs text-sol-text-dim mb-1.5">General sessions</h3>
          <div className="space-y-1">
            {unlinkedSessions.map((s: any) => (
              <PlanSessionCard key={s._id} session={s} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function OrchestrationTab({ tasks, sessions }: { tasks: any[]; sessions: any[] }) {
  const activeSessions = sessions.filter((s: any) => s.is_active);
  const recentSessions = [...sessions].sort((a: any, b: any) => (b.updated_at || 0) - (a.updated_at || 0));

  const taskTimeline = [...tasks].sort((a: any, b: any) => (b.updated_at || b._creationTime || 0) - (a.updated_at || a._creationTime || 0));

  return (
    <div className="space-y-6">
      <OrchestrationHeader tasks={tasks} sessions={sessions} />

      {activeSessions.length > 0 && (
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium text-sol-text mb-3">
            <Activity className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
            Active Sessions
            <span className="text-xs text-emerald-600/70 dark:text-emerald-400/60 font-normal">({activeSessions.length})</span>
          </h2>
          <div className="space-y-1.5">
            {activeSessions.map((s: any) => (
              <Link
                key={s._id}
                href={`/conversation/${s.session_id}`}
                className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-emerald-500/20 bg-emerald-950/10 hover:bg-emerald-950/20 transition-colors group/as"
              >
                <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <span className="text-sm text-sol-text group-hover/as:text-emerald-700 dark:group-hover/as:text-emerald-300 transition-colors truncate block">
                    {s.title || "Untitled session"}
                  </span>
                  <div className="flex items-center gap-2 mt-0.5 text-[10px] text-gray-500 dark:text-gray-500 font-mono">
                    {s.message_count > 0 && <span>{s.message_count} msgs</span>}
                    {s.project_path && (
                      <span>{s.project_path.split("/").filter(Boolean).pop()}</span>
                    )}
                    {s.git_branch && s.git_branch !== "main" && (
                      <span className="text-emerald-600/50 dark:text-emerald-400/30">{s.git_branch}</span>
                    )}
                  </div>
                </div>
                <span className="text-[10px] text-gray-400 dark:text-gray-500 font-mono tabular-nums flex-shrink-0">
                  {getRelativeTime(s.updated_at || s.started_at)}
                </span>
                <ExternalLink className="w-3 h-3 text-gray-300 dark:text-gray-600 group-hover/as:text-emerald-600 dark:group-hover/as:text-emerald-400/60 transition-colors flex-shrink-0" />
              </Link>
            ))}
          </div>
        </div>
      )}

      <div>
        <h2 className="flex items-center gap-2 text-sm font-medium text-sol-text mb-3">
          <Layers className="w-4 h-4 text-sol-text-dim" />
          Task Timeline
          <span className="text-xs text-sol-text-dim font-normal">({taskTimeline.length})</span>
        </h2>
        {taskTimeline.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-sol-text-dim border border-sol-border/15 rounded-lg">
            No tasks yet
          </div>
        ) : (
          <div className="relative">
            <div className="absolute left-[18px] top-3 bottom-3 w-px bg-sol-border/30" />
            <div className="space-y-0">
              {taskTimeline.map((task: any) => {
                const tc = TASK_STATUS_CONFIG[task.status] || TASK_STATUS_CONFIG.open;
                const TaskIcon = tc.icon;
                const time = task.updated_at ? getRelativeTime(task.updated_at) : task._creationTime ? getRelativeTime(task._creationTime) : "";
                const hasExec = task.execution_status && !!getExecStatusConfig(task.execution_status);

                return (
                  <div key={task._id} className="flex items-start gap-3 py-2 pl-1 pr-3 relative">
                    <div className="relative z-10 flex-shrink-0 mt-0.5 bg-sol-bg rounded-full p-0.5">
                      <TaskIcon className={`w-4 h-4 ${tc.color}`} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-mono text-sol-text-dim flex-shrink-0">{task.short_id}</span>
                        <span className={`text-sm truncate ${task.status === "done" || task.status === "dropped" ? "text-sol-text-muted line-through" : "text-sol-text"}`}>
                          {task.title}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1 flex-wrap">
                        <TaskStatusBadge status={task.status} type="task" />
                        {hasExec && (
                          <TaskStatusBadge status={task.execution_status} type="execution" />
                        )}
                        {task.activeSession && (
                          <Link
                            href={`/conversation/${task.activeSession.session_id}`}
                            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 text-[10px] hover:bg-emerald-500/25 transition-colors"
                          >
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            live
                          </Link>
                        )}
                        {task.actual_minutes && (
                          <span className="text-[10px] text-gray-400 dark:text-gray-500 font-mono">
                            {task.actual_minutes}m
                          </span>
                        )}
                      </div>
                    </div>
                    <span className="text-[10px] text-gray-400 dark:text-gray-500 font-mono tabular-nums whitespace-nowrap flex-shrink-0 mt-0.5">
                      {time}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {recentSessions.length > 0 && (
        <div>
          <h2 className="flex items-center gap-2 text-sm font-medium text-sol-text mb-3">
            <MessageSquare className="w-4 h-4 text-sol-text-dim" />
            All Sessions
            <span className="text-xs text-sol-text-dim font-normal">({recentSessions.length})</span>
          </h2>
          <div className="space-y-1">
            {recentSessions.map((s: any) => (
              <PlanSessionCard key={s._id} session={s} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function StartWorkflowButton({ workflowId, planId }: { workflowId: string; planId: string }) {
  const createRun = useMutation(api.workflow_runs.create);
  const [pending, setPending] = useState(false);

  const handleClick = useCallback(async () => {
    setPending(true);
    try {
      await createRun({ workflow_id: workflowId, plan_id: planId });
      toast.success("Workflow started");
    } catch (e: any) {
      toast.error(e.message || "Failed to start workflow");
    } finally {
      setPending(false);
    }
  }, [createRun, workflowId, planId]);

  return (
    <div className="mb-5">
      <button
        onClick={handleClick}
        disabled={pending}
        className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded border border-sol-cyan/30 text-sol-cyan hover:bg-sol-cyan/10 transition-colors disabled:opacity-50"
      >
        <Play className="w-3.5 h-3.5" />
        {pending ? "Starting..." : "Run workflow"}
      </button>
    </div>
  );
}

type PlanTab = "overview" | "orchestration" | "board" | "graph";

export function PlanDetailPanel({ planId }: { planId: string }) {
  const queryArgs = planId.startsWith("pl-") ? { short_id: planId } : { id: planId };
  const plan = useQuery(api.plans.webGet, queryArgs);
  const [activeTab, setActiveTab] = useState<PlanTab>("overview");

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

  const hasTasks = (plan.tasks || []).length > 0;
  const hasActiveSessions = (plan.sessions || []).some((s: any) => s.is_active);

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
        <div className="flex items-center gap-3 text-xs text-sol-text-dim flex-wrap">
          {plan.author?.image && (
            <img src={plan.author.image} className="w-4 h-4 rounded-full" alt="" />
          )}
          {plan.author?.name && <span>{plan.author.name}</span>}
          <span className="font-mono">{plan.short_id}</span>
          <span>Created {formatTimestamp(plan.created_at)}</span>
          <span>Updated {formatTimestamp(plan.updated_at)}</span>
          {plan.drive_state && plan.drive_state.total_rounds > 0 && (
            <DriveRoundIndicator driveState={plan.drive_state} />
          )}
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
        <PlanProgressBar progress={plan.progress} />
      )}

      {(plan as any).workflow_id && !(plan as any).workflow_run_id && (
        <StartWorkflowButton workflowId={(plan as any).workflow_id} planId={plan._id} />
      )}

      {(plan as any).workflow_run_id && (
        <div className="mb-5">
          <WorkflowContextPanel workflowRunId={(plan as any).workflow_run_id} />
        </div>
      )}

      {hasTasks && (
        <div className="flex items-center gap-1 mb-5 border-b border-sol-border/15">
          <button
            onClick={() => setActiveTab("overview")}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
              activeTab === "overview"
                ? "text-sol-text border-sol-cyan"
                : "text-sol-text-dim border-transparent hover:text-sol-text-muted"
            }`}
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            Overview
          </button>
          <button
            onClick={() => setActiveTab("orchestration")}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
              activeTab === "orchestration"
                ? "text-sol-text border-sol-cyan"
                : "text-sol-text-dim border-transparent hover:text-sol-text-muted"
            }`}
          >
            <Zap className={`w-3.5 h-3.5 ${hasActiveSessions ? "text-emerald-600 dark:text-emerald-400" : ""}`} />
            Orchestration
            {hasActiveSessions && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            )}
          </button>
          <button
            onClick={() => setActiveTab("board")}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
              activeTab === "board"
                ? "text-sol-text border-sol-cyan"
                : "text-sol-text-dim border-transparent hover:text-sol-text-muted"
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            Board
          </button>
          <button
            onClick={() => setActiveTab("graph")}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
              activeTab === "graph"
                ? "text-sol-text border-sol-cyan"
                : "text-sol-text-dim border-transparent hover:text-sol-text-muted"
            }`}
          >
            <GitBranch className="w-3.5 h-3.5" />
            Graph
          </button>
        </div>
      )}

      {activeTab === "graph" ? (
        <PlanGraphView tasks={plan.tasks || []} />
      ) : activeTab === "board" ? (
        <PlanBoardView tasks={plan.tasks || []} planShortId={plan.short_id} />
      ) : activeTab === "overview" ? (
        <>
          <OrchestrationHeader tasks={plan.tasks || []} sessions={plan.sessions || []} />

          <PlanTaskSection planShortId={plan.short_id} tasks={plan.tasks || []} sessions={plan.sessions || []} />

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
        </>
      ) : (
        <OrchestrationTab tasks={plan.tasks || []} sessions={plan.sessions || []} />
      )}
    </div>
  );
}
