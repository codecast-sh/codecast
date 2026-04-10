"use client";
import { useState, useCallback, useMemo } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useRouter, useSearchParams, useParams, usePathname } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, TaskItem } from "../../store/inboxStore";
import { useSyncTasks, useSyncTaskDetail } from "../../hooks/useSyncTasks";

import { GenericListView, ListGroup, ItemRowState } from "../../components/GenericListView";
import { LivenessDot, ActiveSessionBadge, taskLivenessState } from "../../components/LivenessDot";

const api = _api as any;
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { TaskStatusBadge } from "../../components/TaskStatusBadge";
import { toast } from "sonner";
import { getLabelColor, DEFAULT_LABELS } from "../../lib/labelColors";
import { AgentTypeIcon, formatAgentType } from "../../components/AgentTypeIcon";
import {
  Plus,
  Circle,
  CircleDot,
  CircleDotDashed,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  Minus,
  Link2,
  X,
  Clock,
  FileCode,
  ListChecks,
  ShieldCheck,
  Tag,
  LayoutGrid,
  List,
  EyeOff,
  User,
  Bot,
  Check,
  MessageSquare,
} from "lucide-react";

type TaskStatus = "backlog" | "open" | "in_progress" | "in_review" | "done" | "dropped";
type TaskPriority = "urgent" | "high" | "medium" | "low" | "none";

export const STATUS_CONFIG: Record<TaskStatus, { icon: typeof Circle; label: string; color: string }> = {
  backlog: { icon: CircleDotDashed, label: "Backlog", color: "text-sol-text-dim" },
  open: { icon: Circle, label: "Open", color: "text-sol-blue" },
  in_progress: { icon: CircleDot, label: "In Progress", color: "text-sol-yellow" },
  in_review: { icon: CircleDot, label: "In Review", color: "text-sol-violet" },
  done: { icon: CheckCircle2, label: "Done", color: "text-sol-green" },
  dropped: { icon: XCircle, label: "Dropped", color: "text-sol-text-dim" },
};

export const PRIORITY_CONFIG: Record<TaskPriority, { icon: typeof Minus; label: string; color: string }> = {
  urgent: { icon: AlertTriangle, label: "Urgent", color: "text-sol-red" },
  high: { icon: ArrowUp, label: "High", color: "text-sol-orange" },
  medium: { icon: Minus, label: "Medium", color: "text-sol-text-muted" },
  low: { icon: ArrowDown, label: "Low", color: "text-sol-text-dim" },
  none: { icon: Minus, label: "None", color: "text-sol-text-dim" },
};

const STATUS_ORDER: TaskStatus[] = ["in_progress", "in_review", "open", "backlog", "done", "dropped"];

function CreatorAvatar({ creator }: { creator?: { name: string; image?: string; github_username?: string } }) {
  if (!creator) return null;
  const avatar = creator.image ? (
    <img src={creator.image} alt={creator.name} title={creator.name} className="w-5 h-5 rounded-full flex-shrink-0" />
  ) : (
    <div className="w-5 h-5 rounded-full flex-shrink-0 bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-[8px] font-medium text-sol-text-muted" title={creator.name}>
      {creator.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()}
    </div>
  );
  if (creator.github_username) {
    return <Link href={`/team/${creator.github_username}`} onClick={e => e.stopPropagation()} className="hover:opacity-80">{avatar}</Link>;
  }
  return avatar;
}

export function TaskRow({ task, state, triageMode, onTriage }: { task: TaskItem; state: ItemRowState; triageMode?: boolean; onTriage?: (task: TaskItem, action: "active" | "dismissed") => void }) {
  const status = STATUS_CONFIG[task.status as TaskStatus] || STATUS_CONFIG.open;
  const priority = PRIORITY_CONFIG[task.priority as TaskPriority] || PRIORITY_CONFIG.medium;
  const StatusIcon = status.icon;
  const PriorityIcon = priority.icon;
  const [editValue, setEditValue] = useState(task.title);

  useWatchEffect(() => { setEditValue(task.title); }, [task.title]);

  const commitEdit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== task.title) state.onTitleCommit(trimmed);
    else state.onEditDone();
  }, [editValue, task.title, state.onTitleCommit, state.onEditDone]);

  const age = Date.now() - task.updated_at;
  const ageStr = age < 3600000
    ? `${Math.round(age / 60000)}m`
    : age < 86400000
      ? `${Math.round(age / 3600000)}h`
      : `${Math.round(age / 86400000)}d`;

  return (
    <>
      <button
        onClick={(e) => { e.stopPropagation(); state.onOpenPalette("status"); }}
        className="flex-shrink-0 hover:scale-125 transition-transform"
        title="Change status (s)"
      >
        {(task as any).activeSession && taskLivenessState(task.status, (task as any).activeSession) === "active" ? (
          <LivenessDot state="active" size="sm" />
        ) : (
          <StatusIcon className={`w-4 h-4 ${status.color}`} />
        )}
      </button>
      <span className="text-xs font-mono text-sol-text-dim w-16 flex-shrink-0 cq-hide-minimal">{task.short_id}</span>
      {state.isEditing ? (
        <input
          autoFocus
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") { setEditValue(task.title); state.onEditDone(); }
            e.stopPropagation();
          }}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 text-sm text-sol-text bg-transparent border-b border-sol-cyan outline-none py-0"
        />
      ) : (
        <span className="flex-1 text-sm text-sol-text truncate">{task.title}</span>
      )}
      {task.source !== "human" && (
        task.source_agent_type ? (
          <span className="flex-shrink-0 opacity-60 cq-hide-compact" title={`Created by ${formatAgentType(task.source_agent_type)}`}>
            <AgentTypeIcon agentType={task.source_agent_type} className="w-3.5 h-3.5" />
          </span>
        ) : (
          <span className="flex-shrink-0 cq-hide-compact" title={`${task.source} created`}><Bot className="w-3.5 h-3.5 text-sol-text-dim/60" /></span>
        )
      )}
      {(task as any).activeSession ? (
        <ActiveSessionBadge session={(task as any).activeSession} className="cq-hide-compact" />
      ) : task.session_count && task.session_count > 0 ? (
        <span className="text-[10px] text-sol-text-dim flex-shrink-0 font-mono cq-hide-compact" title={`${task.session_count} session${task.session_count > 1 ? "s" : ""}`}>
          <MessageSquare className="w-3 h-3 inline mr-0.5" />{task.session_count}
        </span>
      ) : null}
      {(task as any).plan && (
        <Link
          href={`/plans/${(task as any).plan._id}`}
          onClick={(e) => e.stopPropagation()}
          className="text-[10px] px-1.5 py-0 rounded bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/20 flex-shrink-0 hover:bg-sol-cyan/20 transition-colors max-w-[120px] truncate cq-hide-compact"
          title={(task as any).plan.title}
        >
          {(task as any).plan.title}
        </Link>
      )}
      {task.source === "insight" && (
        <span className="text-[10px] px-1.5 py-0 rounded bg-sol-violet/10 text-sol-violet border border-sol-violet/20 flex-shrink-0 cq-hide-compact">mined</span>
      )}
      {task.execution_status && (
        <TaskStatusBadge status={task.execution_status} type="execution" className="flex-shrink-0 cq-hide-compact" />
      )}
      {task.blocked_by && task.blocked_by.length > 0 && (
        <Link2 className="w-3.5 h-3.5 text-sol-red flex-shrink-0 cq-hide-compact" />
      )}
      {task.labels && task.labels.length > 0 && (
        <div className="flex items-center gap-1 flex-shrink min-w-0 overflow-hidden flex-nowrap cq-hide-compact">
          {task.labels.slice(0, 2).map((l: string) => {
            const lc = getLabelColor(l);
            return (
              <span key={l} className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0 rounded-full border whitespace-nowrap ${lc.bg} ${lc.border} ${lc.text}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${lc.dot}`} />
                {l}
              </span>
            );
          })}
          {task.labels.slice(2).map((l: string) => {
            const lc = getLabelColor(l);
            return (
              <span key={l} className={`w-2 h-2 rounded-full flex-shrink-0 ${lc.dot}`} title={l} />
            );
          })}
        </div>
      )}
      {task.assignee_info && (() => {
        const avatar = task.assignee_info.image ? (
          <img src={task.assignee_info.image} alt={task.assignee_info.name} className="w-5 h-5 rounded-full ring-1 ring-sol-cyan/30" />
        ) : (
          <div className="w-5 h-5 rounded-full bg-sol-cyan/10 border border-sol-cyan/30 flex items-center justify-center text-[8px] font-medium text-sol-cyan">
            {task.assignee_info.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()}
          </div>
        );
        return (
          <div className="flex items-center gap-1 flex-shrink-0 cq-hide-compact" title={`Assigned: ${task.assignee_info.name}`}>
            {(task.assignee_info as any).github_username ? (
              <Link href={`/team/${(task.assignee_info as any).github_username}`} onClick={e => e.stopPropagation()} className="hover:opacity-80">{avatar}</Link>
            ) : avatar}
          </div>
        );
      })()}
      {triageMode && onTriage ? (
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); onTriage(task, "active"); }}
            className="p-1 rounded hover:bg-sol-green/20 text-sol-text-dim hover:text-sol-green transition-colors"
            title="Promote to active (y)"
          >
            <Check className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onTriage(task, "dismissed"); }}
            className="p-1 rounded hover:bg-sol-red/20 text-sol-text-dim hover:text-sol-red transition-colors"
            title="Dismiss (Backspace)"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      ) : (
        <button
          onClick={(e) => { e.stopPropagation(); state.onOpenPalette("priority"); }}
          className="flex-shrink-0 hover:scale-125 transition-transform cq-hide-minimal"
          title="Set priority (p)"
        >
          <PriorityIcon className={`w-3.5 h-3.5 ${priority.color}`} />
        </button>
      )}
      <span className="text-xs text-sol-text-dim w-8 text-right tabular-nums cq-hide-minimal">{ageStr}</span>
    </>
  );
}


function ExecutionDetails({ data }: { data: any }) {
  const hasExecution = data.execution_status || data.steps?.length || data.acceptance_criteria?.length ||
    data.files_changed?.length || data.execution_concerns || data.estimated_minutes != null || data.actual_minutes != null;
  if (!hasExecution) return null;

  return (
    <div className="border-t border-sol-border/20 pt-3 space-y-3">
      {data.execution_status && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-sol-text-dim">Execution</span>
          <TaskStatusBadge status={data.execution_status} type="execution" />
        </div>
      )}

      {(data.estimated_minutes != null || data.actual_minutes != null) && (
        <div className="flex items-center gap-3 text-xs">
          <Clock className="w-3 h-3 text-sol-text-dim flex-shrink-0" />
          {data.estimated_minutes != null && (
            <span className="text-sol-text-dim">est. <span className="text-sol-text-muted">{data.estimated_minutes}m</span></span>
          )}
          {data.actual_minutes != null && (
            <span className="text-sol-text-dim">actual <span className="text-sol-text-muted">{data.actual_minutes}m</span></span>
          )}
        </div>
      )}

      {data.execution_concerns && (
        <div className="text-xs p-2 rounded bg-sol-yellow/5 border border-sol-yellow/20 text-sol-yellow">
          {data.execution_concerns}
        </div>
      )}

      {data.acceptance_criteria && data.acceptance_criteria.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-xs text-sol-text-dim mb-1.5">
            <ListChecks className="w-3 h-3" />
            Acceptance Criteria
          </div>
          <div className="space-y-1">
            {data.acceptance_criteria.map((c: string, i: number) => (
              <div key={i} className="flex items-start gap-2 text-xs text-sol-text-muted">
                <ShieldCheck className="w-3 h-3 text-sol-text-dim flex-shrink-0 mt-0.5" />
                <span>{c}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.steps && data.steps.length > 0 && (
        <div>
          <div className="text-xs text-sol-text-dim mb-1.5">Steps</div>
          <div className="space-y-1">
            {data.steps.map((s: any, i: number) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className={`flex-shrink-0 mt-0.5 ${s.done ? "text-sol-green" : "text-sol-text-dim"}`}>
                  {s.done ? <CheckCircle2 className="w-3 h-3" /> : <Circle className="w-3 h-3" />}
                </span>
                <div className="min-w-0">
                  <span className={s.done ? "text-sol-text-muted line-through" : "text-sol-text-muted"}>{s.title}</span>
                  {s.verification && (
                    <div className="text-[10px] text-sol-text-dim mt-0.5">{s.verification}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {data.files_changed && data.files_changed.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 text-xs text-sol-text-dim mb-1.5">
            <FileCode className="w-3 h-3" />
            Files ({data.files_changed.length})
          </div>
          <div className="space-y-0.5">
            {data.files_changed.map((f: string) => (
              <div key={f} className="text-[11px] font-mono text-sol-text-dim truncate">{f}</div>
            ))}
          </div>
        </div>
      )}

      {data.verification_evidence && (
        <div>
          <div className="text-xs text-sol-text-dim mb-1">Verification</div>
          <div className="text-xs text-sol-text-muted whitespace-pre-wrap">{data.verification_evidence}</div>
        </div>
      )}
    </div>
  );
}

function TaskPreviewPanel({ taskId, onClose, onOpen }: { taskId: string; onClose: () => void; onOpen: () => void }) {
  useSyncTaskDetail(taskId);
  const data = useInboxStore((s) => s.tasks[taskId]);

  if (!data) return null;

  const status = STATUS_CONFIG[data.status as TaskStatus] || STATUS_CONFIG.open;
  const priority = PRIORITY_CONFIG[data.priority as TaskPriority] || PRIORITY_CONFIG.medium;
  const StatusIcon = status.icon;
  const PriorityIcon = priority.icon;

  return (
    <div className="w-[480px] flex-shrink-0 border-l border-sol-border/30 bg-sol-bg overflow-y-auto">
      <div className="flex items-center justify-between px-4 py-3 border-b border-sol-border/30">
        <span className="text-xs font-mono text-sol-text-dim">{data.short_id}</span>
        <div className="flex items-center gap-1">
          <button onClick={onOpen} className="text-xs px-2 py-1 rounded-md text-sol-text-dim hover:text-sol-cyan hover:bg-sol-bg-alt transition-colors">
            Open
          </button>
          <button onClick={onClose} className="p-1 rounded-md text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-colors">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <div className="px-4 py-3">
        <h2 className="text-base font-semibold text-sol-text leading-tight mb-3">{data.title}</h2>
        <div className="flex items-center gap-3 mb-3">
          <div className="flex items-center gap-1.5">
            <StatusIcon className={`w-3.5 h-3.5 ${status.color}`} />
            <span className="text-xs text-sol-text-muted">{status.label}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <PriorityIcon className={`w-3.5 h-3.5 ${priority.color}`} />
            <span className="text-xs text-sol-text-muted">{priority.label}</span>
          </div>
        </div>
        {data.labels && data.labels.length > 0 && (
          <div className="flex gap-1 flex-wrap mb-3">
            {data.labels.map((l: string) => {
              const lc = getLabelColor(l);
              return (
                <span key={l} className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border ${lc.bg} ${lc.border} ${lc.text}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${lc.dot}`} />
                  {l}
                </span>
              );
            })}
          </div>
        )}
        {(data as any).assignee_info && (
          <div className="flex items-center gap-2 mb-3 text-xs">
            <span className="text-sol-text-dim">Assignee</span>
            <CreatorAvatar creator={(data as any).assignee_info} />
            <span className="text-sol-text-muted">{(data as any).assignee_info.name}</span>
          </div>
        )}
        {data.description && (
          <div className="text-sm text-sol-text-muted whitespace-pre-wrap leading-relaxed border-t border-sol-border/20 pt-3 mb-3">
            {data.description}
          </div>
        )}
        <ExecutionDetails data={data} />
        {(data as any)?.comments && (data as any).comments.length > 0 && (
          <div className="border-t border-sol-border/20 pt-3">
            <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide mb-2">
              Comments ({(data as any).comments.length})
            </div>
            <div className="space-y-2">
              {(data as any).comments.slice(0, 5).map((c: any) => (
                <div key={c._id} className="text-xs p-2 rounded bg-sol-bg-alt/30 border border-sol-border/20">
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="font-medium text-sol-text">{c.author}</span>
                    <span className="text-sol-text-dim">{(() => {
                      const ago = Date.now() - c.created_at;
                      if (ago < 3600000) return `${Math.round(ago / 60000)}m`;
                      if (ago < 86400000) return `${Math.round(ago / 3600000)}h`;
                      return `${Math.round(ago / 86400000)}d`;
                    })()}</span>
                  </div>
                  <div className="text-sol-text-muted whitespace-pre-wrap">{c.text}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function KanbanCard({
  task,
  isDragging,
  onClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
}: {
  task: TaskItem;
  isDragging?: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
}) {
  const priority = PRIORITY_CONFIG[task.priority as TaskPriority] || PRIORITY_CONFIG.none;
  const PriorityIcon = priority.icon;
  const assignee = task.assignee_info;

  return (
    <div
      draggable
      onClick={onClick}
      onContextMenu={onContextMenu}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      className={`bg-white dark:bg-sol-bg-alt border border-sol-border/40 rounded-lg sm:rounded-xl p-3 cursor-grab shadow-sm hover:border-sol-yellow/50 hover:shadow-md transition-all select-none ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-[10px] font-mono text-sol-text-dim leading-none mt-0.5">{task.short_id}</span>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {(task as any).activeSession && (
            <ActiveSessionBadge session={(task as any).activeSession} compact />
          )}
          {assignee ? (() => {
            const av = assignee.image ? (
              <img src={assignee.image} alt={assignee.name} className="w-4 h-4 rounded-full" title={assignee.name} />
            ) : (
              <div className="w-4 h-4 rounded-full bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-[7px] font-medium text-sol-text-muted" title={assignee.name}>
                {assignee.name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
              </div>
            );
            return (assignee as any).github_username
              ? <Link href={`/team/${(assignee as any).github_username}`} onClick={e => e.stopPropagation()} className="hover:opacity-80">{av}</Link>
              : av;
          })() : null}
        </div>
      </div>
      <p className="text-[13px] text-sol-text leading-snug mb-3 line-clamp-3 font-medium">{task.title}</p>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <PriorityIcon className={`w-3 h-3 flex-shrink-0 ${priority.color}`} />
          {task.labels && task.labels.length > 0 && (() => {
            const lc = getLabelColor(task.labels[0]);
            return (
              <span className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border ${lc.bg} ${lc.border} ${lc.text}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${lc.dot}`} />
                {task.labels[0]}
              </span>
            );
          })()}
        </div>
        <span className="text-[10px] text-sol-text-dim tabular-nums">{fmtDate(task.updated_at)}</span>
      </div>
    </div>
  );
}

function KanbanView({
  grouped,
  hiddenStatuses,
  onToggleHidden,
  onCardClick,
  onContextMenu,
  onAddTask,
  onStatusChange,
}: {
  grouped: Record<string, TaskItem[]>;
  hiddenStatuses: Set<string>;
  onToggleHidden: (status: string) => void;
  onCardClick: (task: TaskItem) => void;
  onContextMenu: (e: React.MouseEvent, task: TaskItem) => void;
  onAddTask: (status: string) => void;
  onStatusChange: (task: TaskItem, newStatus: string) => void;
}) {
  const visibleStatuses = STATUS_ORDER.filter((s) => !hiddenStatuses.has(s) && (grouped[s]?.length || true));
  const hiddenWithTasks = STATUS_ORDER.filter((s) => hiddenStatuses.has(s));
  const [dragging, setDragging] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const onDragStart = useCallback((e: React.DragEvent, shortId: string) => {
    e.dataTransfer.setData("text/plain", shortId);
    e.dataTransfer.effectAllowed = "move";
    setDragging(shortId);
  }, []);

  const onDragEnd = useCallback(() => {
    setDragging(null);
    setDragOver(null);
  }, []);

  const onDrop = useCallback((e: React.DragEvent, targetStatus: string) => {
    e.preventDefault();
    setDragOver(null);
    const shortId = e.dataTransfer.getData("text/plain");
    if (!shortId) return;
    const allTasks = Object.values(grouped).flat();
    const task = allTasks.find(t => t.short_id === shortId);
    if (!task || task.status === targetStatus) {
      setDragging(null);
      return;
    }
    onStatusChange(task, targetStatus);
    setDragging(null);
  }, [grouped, onStatusChange]);

  const handleDragOver = useCallback((e: React.DragEvent, status: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOver(status);
  }, []);

  const onDragLeave = useCallback(() => {
    setDragOver(null);
  }, []);

  return (
    <div className="flex-1 flex overflow-hidden">
      <div className="flex-1 flex gap-3 overflow-x-auto px-4 py-4 pb-6">
        {visibleStatuses.map((status) => {
          const cfg = STATUS_CONFIG[status as TaskStatus];
          const Icon = cfg.icon;
          const tasks = grouped[status] || [];
          return (
            <div
              key={status}
              onDrop={e => onDrop(e, status)}
              onDragOver={e => handleDragOver(e, status)}
              onDragLeave={onDragLeave}
              className={`flex flex-col w-[272px] flex-shrink-0 min-h-0 rounded-lg transition-colors ${
                dragOver === status ? "bg-sol-bg-alt/50 ring-1 ring-sol-yellow/30" : ""
              }`}
            >
              <div className="flex items-center gap-2 px-1 py-2 mb-2">
                <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${cfg.color}`} />
                <span className="text-sm font-medium text-sol-text">{cfg.label}</span>
                <span className="text-[11px] text-sol-text-dim tabular-nums">{tasks.length}</span>
                <div className="ml-auto flex items-center">
                  <button
                    onClick={() => onToggleHidden(status)}
                    title="Hide column"
                    className="w-6 h-6 flex items-center justify-center rounded hover:bg-sol-bg-alt text-sol-text-dim/50 hover:text-sol-text-dim transition-colors"
                  >
                    <EyeOff className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => onAddTask(status)}
                    title="Add task"
                    className="w-6 h-6 flex items-center justify-center rounded hover:bg-sol-bg-alt text-sol-text-dim/50 hover:text-sol-text-dim transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                {tasks.map((task) => (
                  <KanbanCard
                    key={task._id}
                    task={task}
                    isDragging={dragging === task.short_id}
                    onClick={() => onCardClick(task)}
                    onContextMenu={(e) => onContextMenu(e, task)}
                    onDragStart={(e) => onDragStart(e, task.short_id)}
                    onDragEnd={onDragEnd}
                  />
                ))}
                {tasks.length === 0 && (
                  <div className="text-[11px] text-sol-text-dim/40 text-center py-6">No tasks</div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {hiddenWithTasks.length > 0 && (
        <div className="w-44 border-l border-sol-border/20 px-3 py-4 flex-shrink-0 flex flex-col gap-1">
          <p className="text-[10px] text-sol-text-dim uppercase tracking-widest mb-2 font-medium">Hidden columns</p>
          {hiddenWithTasks.map((s) => {
            const cfg = STATUS_CONFIG[s as TaskStatus];
            const Icon = cfg.icon;
            return (
              <button
                key={s}
                onClick={() => onToggleHidden(s)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-sol-bg-alt text-sol-text-muted text-xs transition-colors text-left"
              >
                <Icon className={`w-3 h-3 flex-shrink-0 ${cfg.color}`} />
                <span className="flex-1 truncate">{cfg.label}</span>
                <span className="text-[10px] text-sol-text-dim tabular-nums">{grouped[s]?.length || 0}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}


function useTaskUrlState() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const taskView = useInboxStore((s) => s.clientState.ui?.task_view);
  const updateClientUI = useInboxStore((s) => s.updateClientUI);

  const isDetailPage = pathname !== "/tasks";
  const hasUrlParams = !isDetailPage && searchParams.toString().length > 0;

  const status = hasUrlParams
    ? (searchParams.get("status") || "")
    : (taskView?.status ?? "");
  const view = hasUrlParams
    ? ((searchParams.get("view") || "list") as "list" | "kanban")
    : (taskView?.view ?? "list");
  const sort = hasUrlParams
    ? ((searchParams.get("sort") || "status") as "status" | "priority" | "created" | "updated" | "plan" | "assignee")
    : ((taskView?.sort || "status") as "status" | "priority" | "created" | "updated" | "plan" | "assignee");
  const priority = hasUrlParams
    ? (searchParams.get("priority") || "")
    : (taskView?.priority ?? "");
  const label = hasUrlParams
    ? (searchParams.get("label") || "")
    : (taskView?.label ?? "");
  const assignee = hasUrlParams
    ? (searchParams.get("assignee") || "")
    : (taskView?.assignee ?? "");
  const statuses = hasUrlParams
    ? (searchParams.get("statuses") || "")
    : (taskView?.statuses ?? "");
  const sourceFilter = hasUrlParams
    ? (searchParams.get("source") || "")
    : (taskView?.source ?? "");

  const setParam = useCallback((updates: Record<string, string>) => {
    const prefs: Record<string, any> = {};
    for (const [k, v] of Object.entries(updates)) {
      prefs[k] = v || undefined;
    }
    updateClientUI({ task_view: { ...taskView, ...prefs } });
    if (!isDetailPage) {
      const params = new URLSearchParams(searchParams.toString());
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      const qs = params.toString();
      router.replace(qs ? `/tasks?${qs}` : "/tasks");
    }
  }, [searchParams, router, taskView, updateClientUI, isDetailPage]);

  return { status, view, sort, priority, label, assignee, statuses, sourceFilter, setParam };
}

export function TaskListContent() {
  const router = useRouter();
  const params = useParams();
  const { status: urlStatus, view: viewMode, sort: sortBy, priority: priorityFilter, label: labelFilter, assignee: assigneeFilter, statuses: statusesFilter, sourceFilter, setParam } = useTaskUrlState();
  const setTaskFilter = useInboxStore((s) => s.setTaskFilter);
  const tasks = useInboxStore((s) => s.tasks);
  const showCreate = useInboxStore((s) => s.createModal === 'task');
  const openCreateModal = useInboxStore((s) => s.openCreateModal);
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<string>>(new Set(["dropped"]));

  const statusFilter = urlStatus;
  const setStatusFilter = useCallback((s: string) => {
    setTaskFilter({ status: s });
    setParam({ status: s });
  }, [setTaskFilter, setParam]);
  const setViewMode = useCallback((v: "list" | "kanban") => setParam({ view: v === "list" ? "" : v }), [setParam]);
  const setSortBy = useCallback((s: string) => setParam({ sort: s === "status" ? "" : s }), [setParam]);

  useWatchEffect(() => { setTaskFilter({ status: urlStatus }); }, [urlStatus]);

  const { hasMore, loadMore } = useSyncTasks();
  const currentUser = useQuery(api.users.getCurrentUser);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const effectiveTeamId = (activeTeamId || (currentUser as any)?.team_id) as any;
  const teamMembers = useQuery(api.teams.getTeamMembers, effectiveTeamId ? { team_id: effectiveTeamId } : "skip");
  const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

  const webUpdate = useMutation(api.tasks.webUpdate);
  const updateTask = useInboxStore((s) => s.updateTask);

  const handleTitleEdit = useCallback(
    async (task: TaskItem, title: string) => {
      updateTask(task.short_id, { title });
      try { await webUpdate({ short_id: task.short_id, title }); } catch {}
    },
    [updateTask, webUpdate]
  );

  const handleTriage = useCallback(
    async (task: TaskItem, action: "active" | "dismissed") => {
      updateTask(task.short_id, { triage_status: action });
      try { await webUpdate({ short_id: task.short_id, triage_status: action }); } catch {}
      toast.success(`${task.short_id} ${action === "active" ? "promoted" : "dismissed"}`);
    },
    [updateTask, webUpdate]
  );

  const tasksList = useMemo(() => Object.values(tasks), [tasks]);

  const allLabels = useMemo(() => {
    const set = new Set<string>(DEFAULT_LABELS);
    for (const t of tasksList) t.labels?.forEach((l: string) => set.add(l));
    return [...set].sort();
  }, [tasksList]);

  // Source filtering applied before other filters.
  // Default ("") shows ALL active-triage tasks. "human" narrows to human-created only.
  const sourceFilteredTasks = useMemo(() => {
    if (sourceFilter === "human") {
      return tasksList.filter((t) => t.source === "human" && (!t.triage_status || t.triage_status === "active"));
    } else if (sourceFilter === "bot") {
      return tasksList.filter((t) => t.source === "insight" && t.triage_status === "suggested");
    } else if (sourceFilter === "dismissed") {
      return tasksList.filter((t) => t.triage_status === "dismissed");
    } else {
      // Default: show everything with active triage
      return tasksList.filter((t) => !t.triage_status || t.triage_status === "active");
    }
  }, [tasksList, sourceFilter]);

  const hiddenAgentCount = useMemo(() => {
    if (sourceFilter !== "human") return 0;
    return tasksList.filter((t) => t.source !== "human" && (!t.triage_status || t.triage_status === "active")).length;
  }, [tasksList, sourceFilter]);

  const filteredTasks = useMemo(() => {
    let list = sourceFilteredTasks;

    // Status filtering: tab bar (single) or dropdown (multi)
    if (statusFilter) {
      list = list.filter((t) => t.status === statusFilter);
    } else if (statusesFilter) {
      const set = new Set(statusesFilter.split(","));
      list = list.filter((t) => set.has(t.status));
    }

    if (priorityFilter) list = list.filter((t) => t.priority === priorityFilter);
    if (labelFilter) list = list.filter((t) => t.labels?.includes(labelFilter));
    if (assigneeFilter === "_unassigned") list = list.filter((t) => !t.assignee);
    else if (assigneeFilter) list = list.filter((t) => t.assignee === assigneeFilter);
    return list;
  }, [sourceFilteredTasks, priorityFilter, labelFilter, assigneeFilter, statusFilter, statusesFilter]);

  const sortWithinGroup = useCallback((tasks: TaskItem[]) => {
    return [...tasks].sort((a, b) => {
      const pd = (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3);
      if (pd !== 0) return pd;
      const statusIdx = (s: string) => STATUS_ORDER.indexOf(s as TaskStatus);
      return statusIdx(a.status) - statusIdx(b.status);
    });
  }, []);

  const planGroups = useMemo(() => {
    if (sortBy !== "plan") return null;
    const byPlan: Record<string, { plan: TaskItem["plan"]; tasks: TaskItem[] }> = {};
    const unplanned: TaskItem[] = [];
    for (const t of filteredTasks) {
      if (t.plan) {
        const key = t.plan._id;
        if (!byPlan[key]) byPlan[key] = { plan: t.plan, tasks: [] };
        byPlan[key].tasks.push(t);
      } else {
        unplanned.push(t);
      }
    }
    const ordered = Object.values(byPlan)
      .sort((a, b) => (a.plan!.title || "").localeCompare(b.plan!.title || ""));
    if (unplanned.length > 0) {
      ordered.push({ plan: undefined, tasks: unplanned });
    }
    for (const g of ordered) {
      g.tasks = sortWithinGroup(g.tasks);
    }
    return ordered;
  }, [filteredTasks, sortBy, sortWithinGroup]);

  const assigneeGroups = useMemo(() => {
    if (sortBy !== "assignee") return null;
    const byAssignee: Record<string, { info: TaskItem["assignee_info"]; tasks: TaskItem[] }> = {};
    const unassigned: TaskItem[] = [];
    for (const t of filteredTasks) {
      if (t.assignee && t.assignee_info) {
        const ownerKey = t.assignee;
        const ownerInfo = t.assignee_info;
        if (!byAssignee[ownerKey]) byAssignee[ownerKey] = { info: ownerInfo, tasks: [] };
        byAssignee[ownerKey].tasks.push(t);
      } else {
        unassigned.push(t);
      }
    }
    const ordered = Object.values(byAssignee)
      .sort((a, b) => (a.info?.name || "").localeCompare(b.info?.name || ""));
    if (unassigned.length > 0) {
      ordered.push({ info: undefined, tasks: unassigned });
    }
    for (const g of ordered) {
      g.tasks = sortWithinGroup(g.tasks);
    }
    return ordered;
  }, [filteredTasks, sortBy, sortWithinGroup]);

  const flatTasks = useMemo(() => {
    if (sortBy === "plan" && planGroups) {
      return planGroups.flatMap((g) => g.tasks);
    }
    if (sortBy === "assignee" && assigneeGroups) {
      return assigneeGroups.flatMap((g) => g.tasks);
    }
    if (sortBy !== "status") {
      const sorted = [...filteredTasks];
      if (sortBy === "priority") sorted.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3));
      else if (sortBy === "created") sorted.sort((a, b) => b.created_at - a.created_at);
      else if (sortBy === "updated") sorted.sort((a, b) => b.updated_at - a.updated_at);
      return sorted;
    }
    if (statusFilter) return filteredTasks;
    const grouped = filteredTasks.reduce((acc: Record<string, TaskItem[]>, t) => {
      const s = t.status as string;
      if (!acc[s]) acc[s] = [];
      acc[s].push(t);
      return acc;
    }, {});
    return STATUS_ORDER.flatMap((s) => grouped[s] || []);
  }, [filteredTasks, statusFilter, sortBy, planGroups, assigneeGroups]);

  const kanbanGrouped = useMemo(() => {
    return filteredTasks.reduce((acc: Record<string, TaskItem[]>, t) => {
      const s = t.status as string;
      if (!acc[s]) acc[s] = [];
      acc[s].push(t);
      return acc;
    }, {});
  }, [filteredTasks]);

  const listGroups = useMemo((): ListGroup<TaskItem>[] | null => {
    if (sortBy === "plan" && planGroups) {
      return planGroups.map((g) => ({
        key: g.plan?._id || "__unplanned",
        label: g.plan?.title || "Unplanned",
        badge: g.plan ? (
          <span className={`text-[10px] px-1.5 py-0 rounded border ${
            g.plan.status === "active" ? "border-sol-green/30 text-sol-green" : "border-sol-border/30 text-sol-text-dim"
          }`}>{g.plan.status}</span>
        ) : undefined,
        extra: g.plan ? (
          <Link href={`/plans/${g.plan._id}`} onClick={(e) => e.stopPropagation()} className="text-[10px] text-sol-cyan hover:underline flex-shrink-0">
            View plan
          </Link>
        ) : undefined,
        items: g.tasks,
      }));
    }
    if (sortBy === "assignee" && assigneeGroups) {
      return assigneeGroups.map((g) => ({
        key: g.info ? g.tasks[0]?.assignee || "__unknown" : "__unassigned",
        label: g.info?.name || "Unassigned",
        icon: g.info?.image ? (
          <img src={g.info.image} alt={g.info.name} className="w-4 h-4 rounded-full" />
        ) : (
          <User className="w-3.5 h-3.5 text-sol-text-dim" />
        ),
        extra: g.info && (g.info as any).github_username ? (
          <Link href={`/team/${(g.info as any).github_username}`} onClick={(e) => e.stopPropagation()} className="text-[10px] text-sol-cyan hover:underline flex-shrink-0">
            Profile
          </Link>
        ) : undefined,
        items: g.tasks,
      }));
    }
    if (statusFilter || sortBy !== "status") return null;
    return STATUS_ORDER
      .filter((s) => kanbanGrouped[s]?.length)
      .map((s) => {
        const cfg = STATUS_CONFIG[s];
        const Icon = cfg.icon;
        return { key: s, label: cfg.label, icon: <Icon className={`w-3.5 h-3.5 ${cfg.color}`} />, items: kanbanGrouped[s] };
      });
  }, [sortBy, planGroups, assigneeGroups, statusFilter, kanbanGrouped]);

  const taskCounts = useMemo(() => {
    const counts: Record<string, number> = { active: 0 };
    for (const t of sourceFilteredTasks) {
      counts[t.status] = (counts[t.status] || 0) + 1;
      if (t.status !== "done" && t.status !== "dropped") counts.active++;
    }
    return counts;
  }, [sourceFilteredTasks]);

  const isBotView = sourceFilter === "bot";
  const renderTaskRow = useCallback((task: TaskItem, state: ItemRowState) => (
    <TaskRow task={task} state={state} triageMode={isBotView} onTriage={isBotView ? handleTriage : undefined} />
  ), [isBotView, handleTriage]);

  return (
    <GenericListView<TaskItem>
          activeItemId={params?.id as string | undefined}
          paletteTargetType="task"
          title="Tasks"
          tabs={[
            { key: "", label: "Active", count: taskCounts.active },
            ...((["backlog", "open", "in_progress", "done"] as const).map((s) => ({
              key: s,
              label: STATUS_CONFIG[s].label,
              count: taskCounts[s] || 0,
            }))),
          ]}
          activeTab={statusFilter}
          onTabChange={setStatusFilter}
          sortBy={sortBy}
          sortOptions={[
            { value: "status", label: "Group by status" },
            { value: "plan", label: "Group by plan" },
            { value: "assignee", label: "Group by assignee" },
            { value: "priority", label: "Sort by priority" },
            { value: "updated", label: "Sort by updated" },
            { value: "created", label: "Sort by created" },
          ]}
          onSortChange={setSortBy}
          filters={{
            hasActive: !!(statusesFilter || priorityFilter || labelFilter || assigneeFilter),
            defs: [
              {
                key: "statuses", label: "Status", icon: <Circle className="w-3 h-3" />, value: statusesFilter, multi: true,
                options: [
                  { key: "", label: "Any" },
                  ...STATUS_ORDER.map((s) => ({ key: s, label: STATUS_CONFIG[s].label, icon: STATUS_CONFIG[s].icon, color: STATUS_CONFIG[s].color })),
                ],
                onChange: (v: string) => setParam({ statuses: v }),
              },
              {
                key: "priority", label: "Priority", icon: <ArrowUp className="w-3 h-3" />, value: priorityFilter,
                options: [
                  { key: "", label: "Any" },
                  { key: "urgent", label: "Urgent", icon: AlertTriangle, color: "text-sol-red" },
                  { key: "high", label: "High", icon: ArrowUp, color: "text-sol-orange" },
                  { key: "medium", label: "Medium", icon: Minus, color: "text-sol-text-muted" },
                  { key: "low", label: "Low", icon: ArrowDown, color: "text-sol-text-dim" },
                ],
                onChange: (v: string) => setParam({ priority: v }),
              },
              {
                key: "label", label: "Label", icon: <Tag className="w-3 h-3" />, value: labelFilter,
                options: [{ key: "", label: "Any" }, ...allLabels.map((l) => ({ key: l, label: l }))],
                onChange: (v: string) => setParam({ label: v }),
              },
              {
                key: "assignee", label: "Assignee", icon: <User className="w-3 h-3" />, value: assigneeFilter,
                options: [
                  { key: "", label: "Anyone" },
                  { key: "_unassigned", label: "Unassigned" },
                  ...(teamMembers || []).map((m: any) => ({ key: m._id, label: m.name || m.email })),
                ],
                onChange: (v: string) => setParam({ assignee: v }),
              },
            ],
            onClear: () => setParam({ statuses: "", priority: "", label: "", assignee: "" }),
          }}
          groups={listGroups}
          flatItems={flatTasks}
          disableKeyboard={showCreate}
          renderRow={renderTaskRow}
          getItemId={(t) => t._id}
          getItemRoute={(t) => `/tasks/${t._id}`}
          getSearchText={(t) => `${t.short_id} ${t.title}`}
          emptyIcon={<Circle className="w-8 h-8 opacity-30" />}
          emptyMessage="No tasks found"
          onCreate={() => openCreateModal('task')}
          hasMore={hasMore}
          onLoadMore={loadMore}
          paletteShortcuts={[
            { key: "s", mode: "status", label: "status" },
            { key: "p", mode: "priority", label: "priority" },
            { key: "l", mode: "labels", label: "labels" },
            { key: "a", mode: "assign", label: "assign" },
          ]}
          paletteProps={{ teamMembers: teamMembers || undefined, currentUser: currentUser || undefined }}
          renderPreview={(task, onClose, onOpen) => (
            <TaskPreviewPanel taskId={task._id} onClose={onClose} onOpen={onOpen} />
          )}
          onItemEdit={handleTitleEdit}
          listFooter={hiddenAgentCount > 0 ? (
            <div className="px-6 py-2.5 border-t border-sol-border/15 flex items-center gap-2 text-xs text-sol-text-dim">
              <Bot className="w-3.5 h-3.5 opacity-40" />
              <span>{hiddenAgentCount} agent {hiddenAgentCount === 1 ? "item" : "items"} not shown</span>
              <button onClick={() => setParam({ source: "all" })} className="text-sol-cyan hover:underline ml-0.5">
                Show all
              </button>
            </div>
          ) : undefined}
          headerExtra={
            <>
              <div className="flex items-center rounded-md border border-sol-border/40 overflow-hidden">
                <button
                  onClick={() => setParam({ source: "" })}
                  className={`px-2 py-1.5 text-xs transition-colors ${!sourceFilter ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"}`}
                  title="All tasks"
                >
                  All
                </button>
                <button
                  onClick={() => setParam({ source: "human" })}
                  className={`px-2 py-1.5 transition-colors border-l border-sol-border/40 ${sourceFilter === "human" ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"}`}
                  title="Human-created tasks"
                >
                  <User className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setParam({ source: "bot" })}
                  className={`px-2 py-1.5 transition-colors border-l border-sol-border/40 ${sourceFilter === "bot" ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"}`}
                  title="Bot-created tasks (triage)"
                >
                  <Bot className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="flex items-center rounded-md border border-sol-border/40 overflow-hidden">
                <button
                  onClick={() => setViewMode("list")}
                  className={`px-2 py-1.5 transition-colors ${viewMode === "list" ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"}`}
                  title="List view"
                >
                  <List className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setViewMode("kanban")}
                  className={`px-2 py-1.5 transition-colors border-l border-sol-border/40 ${viewMode === "kanban" ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"}`}
                  title="Board view"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
              </div>
            </>
          }
          customContent={viewMode === "kanban" ? ({ openPaletteForItems }) => (
            <KanbanView
              grouped={kanbanGrouped}
              hiddenStatuses={hiddenStatuses}
              onToggleHidden={(s) => setHiddenStatuses((prev) => {
                const next = new Set(prev);
                if (next.has(s)) next.delete(s); else next.add(s);
                return next;
              })}
              onCardClick={(t) => router.push(`/tasks/${t._id}`)}
              onContextMenu={(e, task) => { e.preventDefault(); openPaletteForItems([task]); }}
              onAddTask={() => openCreateModal('task')}
              onStatusChange={async (task, newStatus) => {
                updateTask(task.short_id, { status: newStatus });
                try {
                  await webUpdate({ short_id: task.short_id, status: newStatus });
                  toast.success(`${task.short_id} \u2192 ${newStatus.replace("_", " ")}`);
                } catch {
                  toast.error("Failed to update task");
                }
              }}
            />
          ) : undefined}
        >
        </GenericListView>
    );
}

export default function TasksPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <TaskListContent />
      </DashboardLayout>
    </AuthGuard>
  );
}
