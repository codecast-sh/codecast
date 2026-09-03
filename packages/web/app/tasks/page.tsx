"use client";
import { useState, useCallback, useMemo } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useRouter, useSearchParams, useParams, usePathname } from "next/navigation";
import Link from "next/link";
import { useInboxStore, TaskItem, TaskViewPrefs, ProjectItem, resolveAssigneeInfo } from "../../store/inboxStore";
import { useTeamRosterIdentity, useViewerIdentity, type RosterIdentity } from "../../hooks/useTeamRoster";
import { useSyncTasks } from "../../hooks/useSyncTasks";
import { TaskDetailContent } from "./[id]/page";
import { DetailSplitLayout } from "../../components/DetailSplitLayout";
import { dragCarriesPane } from "../../lib/stage";
import { AvatarImg } from "../../lib/avatarCache";
import { ErrorBoundary } from "../../components/ErrorBoundary";

import { GenericListView, ListGroup, ItemRowState } from "../../components/GenericListView";
import { TaskMenuItems } from "../../components/menus/ObjectContextMenus";
import { SegmentedToggle } from "../../components/SegmentedToggle";
import { LivePulseHalo, ActiveSessionBadge } from "../../components/LivenessDot";
import { taskLivenessState } from "../../lib/liveness";

// The personal space has no roster; a stable empty list keeps the memos quiet.
const NO_MEMBERS: RosterIdentity[] = [];
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { TaskStatusBadge, TASK_STATUS, TASK_STATUS_ORDER, type TaskStatus } from "../../components/TaskStatusBadge";
import { buildTaskGroups, isValidTaskGroup, parseTaskGroup, taskGroupDropUpdates, TASK_AXES, TASK_AXIS_KEYS } from "../../lib/taskGrouping";
import { boardOrderedStatuses, statusByKey, statusVisual, statusWriteFields, taskStatusKey, taskStatusOf, useTeamTaskStatusList } from "../../lib/taskStatuses";
import type { TeamTaskStatus } from "@codecast/shared/tasks";
import { LabelChips } from "../../components/LabelChips";
import { IssueLink } from "../../components/tasks/IssueLink";
import { toast } from "sonner";
import { getLabelColor, DEFAULT_LABELS } from "../../lib/labelColors";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { currentViewId, isViewDirty, prefsForSaving, VIEW_ID_KEY } from "../../lib/savedViews";
import { buildTaskTree, isActiveTask, isOnHumanBoard, taskFamilyIndex, taskOrigin } from "@codecast/shared/tasks";
import { closeTaskWithGuard, setTaskParent } from "../../lib/taskActions";
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
  Users,
  Lightbulb,
  Check,
  MessageSquare,
  FolderKanban,
  Layers,
  Activity,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Copy,
} from "lucide-react";

// Linear's progress circle, tiny: a ring that fills as direct subtasks close.
function SubtaskRing({ done, total }: { done: number; total: number }) {
  const r = 4;
  const c = 2 * Math.PI * r;
  const pct = total > 0 ? done / total : 0;
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" className="flex-shrink-0 -rotate-90">
      <circle cx="6" cy="6" r={r} fill="none" strokeWidth="2" className="stroke-current opacity-25" />
      <circle
        cx="6" cy="6" r={r} fill="none" strokeWidth="2"
        strokeDasharray={`${c * pct} ${c}`}
        strokeLinecap="round"
        className="stroke-current"
      />
    </svg>
  );
}

type TaskPriority = "urgent" | "high" | "medium" | "low" | "none";

// One task-status vocabulary, shared with TaskStatusBadge and the groupers.
const STATUS_CONFIG = TASK_STATUS;

const PRIORITY_CONFIG: Record<TaskPriority, { icon: typeof Minus; label: string; color: string }> = {
  urgent: { icon: AlertTriangle, label: "Urgent", color: "text-sol-red" },
  high: { icon: ArrowUp, label: "High", color: "text-sol-orange" },
  medium: { icon: Minus, label: "Medium", color: "text-sol-text-muted" },
  low: { icon: ArrowDown, label: "Low", color: "text-sol-text-dim" },
  none: { icon: Minus, label: "None", color: "text-sol-text-dim" },
};

const STATUS_ORDER = TASK_STATUS_ORDER;
/** What the default "Not done" tab shows: every status but the terminal two. */
const NOT_DONE: TaskStatus[] = STATUS_ORDER.filter((st) => st !== "done" && st !== "dropped");

export function TaskRow({ task, state, triageMode, onTriage, indent = 0, hiddenDescendantCount = 0, progress, collapsed = false, onToggleCollapse, parentChip }: {
  task: TaskItem;
  state: ItemRowState;
  triageMode?: boolean;
  onTriage?: (task: TaskItem, action: "active" | "dismissed") => void;
  /** Nesting depth, already clamped to the emphasised top levels by buildTaskTree. */
  indent?: number;
  /** How many of this parent's subtasks the current view isn't rendering (agent-internal ones). */
  hiddenDescendantCount?: number;
  /** Direct-children progress (workspace truth), the ONE number story per parent row. */
  progress?: { total: number; done: number; inProgress: number };
  /** Collapse state for this parent's on-screen subtree. */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
  /** Set on a floated subtask (parent filtered out of this view) for orientation. */
  parentChip?: { id: string; short_id: string; title: string } | null;
}) {
  const router = useRouter();
  const activeSession = useInboxStore((s) => s.taskActiveSessions[task._id]) ?? null;
  // Resolve through the task's own team so a row shows that team's vocabulary
  // ("Working on") even if it ever renders outside its workspace view.
  const teamStatuses = useTeamTaskStatusList((task as any).team_id);
  const status = statusVisual(taskStatusOf(task as any, teamStatuses), teamStatuses);
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
      {indent > 0 && (
        // Indent rail rather than left padding: the row is a flex line, so a
        // fixed-width spacer keeps every column below it aligned across depths.
        <span
          aria-hidden
          className="flex-shrink-0 self-stretch border-l border-sol-border/40"
          style={{ marginLeft: `${(indent - 1) * 12}px`, width: "12px" }}
        />
      )}
      <button
        onClick={(e) => { e.stopPropagation(); state.onOpenPalette("status"); }}
        className="flex-shrink-0 hover:scale-125 transition-transform"
        title="Change status (s)"
      >
        {activeSession && taskLivenessState(task.status, activeSession) === "active" ? (
          <LivePulseHalo><StatusIcon className={`w-4 h-4 ${status.color}`} /></LivePulseHalo>
        ) : (
          <StatusIcon className={`w-4 h-4 ${status.color}`} />
        )}
      </button>
      <span className="text-xs font-mono text-sol-text-dim w-16 flex-shrink-0 cq-hide-compact">{task.short_id}</span>
      {task.external && <IssueLink external={task.external} className="cq-hide-compact" />}
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
      {/* Floated subtask: the parent was filtered out of this view, so the row
          carries a small chip pointing back at it — never context-free. */}
      {parentChip && (
        <button
          onClick={(e) => { e.stopPropagation(); router.push(`/tasks/${parentChip.id}`); }}
          className="flex items-center gap-1 text-[10px] px-1.5 py-0 rounded border border-sol-border/40 text-sol-text-dim hover:text-sol-cyan hover:border-sol-cyan/40 flex-shrink-0 font-mono cq-hide-compact transition-colors max-w-[10rem]"
          title={`Subtask of ${parentChip.short_id}: ${parentChip.title}`}
        >
          <CornerDownRight className="w-3 h-3 flex-shrink-0" />
          <span className="truncate">{parentChip.short_id}</span>
        </button>
      )}
      {/* A duplicate is dropped but keeps pointing at the task that superseded
          it, so the row explains itself when it surfaces in Done/All views. */}
      {task.duplicate_of && (
        <span
          className="flex items-center gap-1 text-[10px] px-1.5 py-0 rounded border border-sol-border/40 text-sol-text-dim flex-shrink-0 font-mono cq-hide-compact"
          title={`Duplicate of ${task.duplicate_of}`}
        >
          <Copy className="w-3 h-3" />
          {task.duplicate_of}
        </span>
      )}
      {/* ONE indicator per parent row (panel decision 4): a Linear-style
          progress chip over direct children, with the hidden agent-internal
          breakdown in the tooltip and glyph — never two competing numbers.
          Clicking it collapses/expands the on-screen subtree. */}
      {progress && progress.total > 0 && (() => {
        const tip =
          `${progress.total} subtask${progress.total > 1 ? "s" : ""}: ${progress.done} done, ${progress.inProgress} in progress` +
          (hiddenDescendantCount > 0 ? ` — ${hiddenDescendantCount} agent-internal, not shown in this view` : "") +
          (onToggleCollapse ? (collapsed ? " (click to expand)" : " (click to collapse)") : "");
        const body = (
          <>
            {onToggleCollapse ? (collapsed ? <ChevronRight className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />) : null}
            <SubtaskRing done={progress.done} total={progress.total} />
            {progress.done}/{progress.total}
            {hiddenDescendantCount > 0 && <Bot className="w-3 h-3" />}
          </>
        );
        const cls = `flex items-center gap-1 text-[10px] px-1.5 py-0 rounded border flex-shrink-0 font-mono cq-hide-compact ${
          hiddenDescendantCount > 0 ? "border-sol-cyan/30 text-sol-cyan/80" : "border-sol-border/40 text-sol-text-dim"
        }`;
        // A button only when it actually toggles something; otherwise a span so
        // it doesn't look pressable-but-dead (the all-hidden case).
        return onToggleCollapse ? (
          <button onClick={(e) => { e.stopPropagation(); onToggleCollapse(); }} className={`${cls} transition-colors ${hiddenDescendantCount > 0 ? "hover:bg-sol-cyan/10" : "hover:text-sol-text"}`} title={tip}>{body}</button>
        ) : (
          <span className={cls} title={tip}>{body}</span>
        );
      })()}
      {/* Origin. A meeting task was written by an agent but decided by people,
          so it gets its own marker — a bot icon here would file real
          commitments in with agent bookkeeping, the confusion decision 4
          exists to remove. */}
      {taskOrigin(task) === "meeting" ? (
        <span
          className="flex items-center gap-1 text-[10px] px-1.5 py-0 rounded bg-sol-magenta/10 text-sol-magenta border border-sol-magenta/20 flex-shrink-0 cq-hide-compact"
          title="Captured from a meeting"
        >
          <Users className="w-3 h-3" />meeting
        </span>
      ) : taskOrigin(task) === "agent" && (
        task.source_agent_type ? (
          <span className="flex-shrink-0 opacity-60 cq-hide-compact" title={`Created by ${formatAgentType(task.source_agent_type)}`}>
            <AgentTypeIcon agentType={task.source_agent_type} className="w-3.5 h-3.5" />
          </span>
        ) : (
          <span className="flex-shrink-0 cq-hide-compact" title={`${task.source} created`}><Bot className="w-3.5 h-3.5 text-sol-text-dim/60" /></span>
        )
      )}
      {activeSession ? (
        <ActiveSessionBadge session={activeSession} className="cq-hide-compact" />
      ) : task.origin_session ? (
        <span className="flex items-center gap-1 flex-shrink-0 cq-hide-compact">
          <ActiveSessionBadge
            session={{
              _id: task.origin_session.conversation_id,
              session_id: task.origin_session.session_id,
              title: task.origin_session.title,
              started_by: task.origin_session.started_by,
              last_message_at: task.origin_session.last_message_at,
            }}
            dormant
          />
          {task.session_count && task.session_count > 1 ? (
            <span className="text-[10px] text-sol-text-dim font-mono" title={`${task.session_count} sessions`}>
              <Link2 className="w-3 h-3 inline mr-0.5" />{task.session_count}
            </span>
          ) : null}
        </span>
      ) : task.session_count && task.session_count > 0 ? (
        <span className="text-[10px] text-sol-text-dim flex-shrink-0 font-mono cq-hide-compact" title={`${task.session_count} session${task.session_count > 1 ? "s" : ""}`}>
          <Link2 className="w-3 h-3 inline mr-0.5" />{task.session_count}
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
        <LabelChips labels={task.labels} className="cq-hide-compact" />
      )}
      {task.assignee_info && (() => {
        const avatar = (
          <AvatarImg
            src={task.assignee_info.image}
            alt={task.assignee_info.name}
            className="w-5 h-5 rounded-full ring-1 ring-sol-cyan/30"
            fallback={
              <div className="w-5 h-5 rounded-full bg-sol-cyan/10 border border-sol-cyan/30 flex items-center justify-center text-[8px] font-medium text-sol-cyan">
                {task.assignee_info.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()}
              </div>
            }
          />
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
          className="flex-shrink-0 hover:scale-125 transition-transform cq-hide-compact"
          title="Set priority (p)"
        >
          <PriorityIcon className={`w-3.5 h-3.5 ${priority.color}`} />
        </button>
      )}
      <span className="text-xs text-sol-text-dim w-8 text-right tabular-nums cq-hide-compact">{ageStr}</span>
    </>
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

/** Compact one-line rendering of a task inside the combine dialog, so the
 *  reader sees exactly which two rows the drop involved. */
function TaskMiniCard({ task }: { task: TaskItem }) {
  const teamStatuses = useTeamTaskStatusList((task as any).team_id);
  const status = statusVisual(taskStatusOf(task as any, teamStatuses), teamStatuses);
  const StatusIcon = status.icon;
  return (
    <div className="flex items-center gap-2 rounded-md border border-sol-border/40 bg-sol-bg-alt/40 px-2.5 py-1.5 min-w-0">
      <StatusIcon className={`w-3.5 h-3.5 flex-shrink-0 ${status.color}`} />
      <span className="text-xs font-mono text-sol-text-dim flex-shrink-0">{task.short_id}</span>
      {task.external && <IssueLink external={task.external} />}
      <span className="text-xs text-sol-text truncate">{task.title}</span>
    </div>
  );
}

/**
 * Dropping one task onto another asks what the gesture meant: file it as a
 * subtask (shared guards: cycle, depth, workspace) or mark it a duplicate
 * (links duplicate_of, then drops through the single close gateway). Same
 * overlay pattern and key-trapping as GlobalCloseGuardDialog.
 */
function TaskCombineDialog({ source, target, onClose }: {
  source: TaskItem;
  target: TaskItem;
  onClose: () => void;
}) {
  const updateTask = useInboxStore((s) => s.updateTask);

  useWatchEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Trap keys so list shortcuts (s, p, j/k…) can't fire behind the overlay.
      e.stopPropagation();
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const asSubtask = () => {
    const res = setTaskParent(source.short_id, target.short_id);
    if (!res.ok) toast.error(res.reason);
    else toast.success(`${source.short_id} is now a subtask of ${target.short_id}`);
    onClose();
  };
  const asDuplicate = () => {
    updateTask(source.short_id, { duplicate_of: target.short_id });
    closeTaskWithGuard(source.short_id, "dropped");
    toast.success(`${source.short_id} marked as duplicate of ${target.short_id}`);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-[28rem] max-w-[90vw] rounded-lg border border-sol-border bg-sol-bg shadow-xl p-4" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-medium text-sol-text mb-3">Combine tasks</div>
        <div className="space-y-1.5 mb-4">
          <TaskMiniCard task={source} />
          <div className="flex items-center gap-1.5 pl-2 text-[10px] text-sol-text-dim uppercase tracking-wide">
            <CornerDownRight className="w-3 h-3" /> dropped onto
          </div>
          <TaskMiniCard task={target} />
        </div>
        <div className="space-y-1.5">
          <button
            autoFocus
            onClick={asSubtask}
            className="w-full flex items-start gap-2.5 rounded-md border border-sol-cyan/40 bg-sol-cyan/10 hover:bg-sol-cyan/20 px-3 py-2 text-left transition-colors"
          >
            <CornerDownRight className="w-3.5 h-3.5 text-sol-cyan mt-0.5 flex-shrink-0" />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-sol-text">Add as subtask</span>
              <span className="block text-[11px] text-sol-text-muted">
                {source.short_id} files under {target.short_id}; both stay open.
              </span>
            </span>
          </button>
          <button
            onClick={asDuplicate}
            className="w-full flex items-start gap-2.5 rounded-md border border-sol-border/40 hover:border-sol-border hover:bg-sol-bg-alt px-3 py-2 text-left transition-colors"
          >
            <Copy className="w-3.5 h-3.5 text-sol-text-muted mt-0.5 flex-shrink-0" />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-sol-text">Mark as duplicate</span>
              <span className="block text-[11px] text-sol-text-muted">
                {source.short_id} is dropped and linked to {target.short_id} as the original.
              </span>
            </span>
          </button>
        </div>
        <div className="flex justify-end mt-3">
          <button
            onClick={onClose}
            className="h-7 px-2.5 text-xs rounded-md border border-sol-border/40 text-sol-text-dim hover:text-sol-text transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function KanbanCard({
  task,
  isDragging,
  onClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
  parentChip,
}: {
  task: TaskItem;
  isDragging?: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  /** The board flattens trees; a subtask card names its parent instead. */
  parentChip?: { short_id: string; title: string } | null;
}) {
  const activeSession = useInboxStore((s) => s.taskActiveSessions[task._id]) ?? null;
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
        <span className="flex items-center gap-1.5 min-w-0 text-[10px] font-mono text-sol-text-dim leading-none mt-0.5">
          {/* The id never breaks: a long provider identifier next to it would
              otherwise wrap "ct-45202" onto two lines on a narrow card. */}
          <span className="flex-shrink-0">{task.short_id}</span>
          {task.external && <IssueLink external={task.external} className="max-w-[9rem]" />}
          {parentChip && (
            <span className="flex items-center gap-0.5 min-w-0 opacity-80" title={`Subtask of ${parentChip.short_id}: ${parentChip.title}`}>
              <CornerDownRight className="w-2.5 h-2.5 flex-shrink-0" />
              <span className="truncate max-w-[7rem]">{parentChip.short_id}</span>
            </span>
          )}
        </span>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {activeSession ? (
            <ActiveSessionBadge session={activeSession} compact />
          ) : task.origin_session ? (
            <ActiveSessionBadge
              session={{
                _id: task.origin_session.conversation_id,
                session_id: task.origin_session.session_id,
                title: task.origin_session.title,
                started_by: task.origin_session.started_by,
                last_message_at: task.origin_session.last_message_at,
              }}
              dormant
              compact
            />
          ) : null}
          {assignee ? (() => {
            const av = (
              <AvatarImg
                src={assignee.image}
                alt={assignee.name}
                className="w-4 h-4 rounded-full"
                title={assignee.name}
                fallback={
                  <div className="w-4 h-4 rounded-full bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-[7px] font-medium text-sol-text-muted" title={assignee.name}>
                    {assignee.name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
                  </div>
                }
              />
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

const COLUMN_DRAG_TYPE = "application/x-codecast-kanban-column";

function KanbanView({
  statuses,
  grouped,
  keyFor,
  hiddenStatuses,
  onToggleHidden,
  onCardClick,
  onContextMenu,
  onAddTask,
  onStatusChange,
  onReorder,
  parentChipFor,
}: {
  /** The workspace's status vocabulary — one column per status, board-ordered. */
  statuses: TeamTaskStatus[];
  grouped: Record<string, TaskItem[]>;
  /** A task's current column key (resolved status id). */
  keyFor: (t: TaskItem) => string;
  hiddenStatuses: Set<string>;
  onToggleHidden: (status: string) => void;
  onCardClick: (task: TaskItem) => void;
  onContextMenu: (e: React.MouseEvent, task: TaskItem) => void;
  onAddTask: (status: string) => void;
  onStatusChange: (task: TaskItem, newStatusKey: string) => void;
  /** Persist a new column order (all status ids, board order). */
  onReorder: (order: string[]) => void;
  parentChipFor?: (task: TaskItem) => { short_id: string; title: string } | null;
}) {
  const visibleStatuses = statuses.filter((s) => !hiddenStatuses.has(s.id));
  const hiddenWithTasks = statuses.filter((s) => hiddenStatuses.has(s.id));
  const [dragging, setDragging] = useState<string | null>(null);
  const [draggingCol, setDraggingCol] = useState<string | null>(null);
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

  // Column drags ride a custom type so a drop can tell them apart from card
  // drags (text/plain). Types are readable during dragover, data only on drop.
  const onColDragStart = useCallback((e: React.DragEvent, status: string) => {
    e.dataTransfer.setData(COLUMN_DRAG_TYPE, status);
    e.dataTransfer.effectAllowed = "move";
    setDraggingCol(status);
  }, []);

  const onColDragEnd = useCallback(() => {
    setDraggingCol(null);
    setDragOver(null);
  }, []);

  const onDrop = useCallback((e: React.DragEvent, targetStatus: string) => {
    e.preventDefault();
    setDragOver(null);
    const colId = e.dataTransfer.getData(COLUMN_DRAG_TYPE);
    if (colId) {
      setDraggingCol(null);
      if (colId === targetStatus) return;
      // Dropping on a column takes its place: moving right lands after it,
      // moving left lands before it. Hidden columns keep their slots.
      const ids = statuses.map((s) => s.id);
      const from = ids.indexOf(colId);
      const to = ids.indexOf(targetStatus);
      if (from < 0 || to < 0) return;
      ids.splice(from, 1);
      // After the removal, index `to` is after the target when moving right
      // and before it when moving left, so the dragged column takes its place.
      ids.splice(to, 0, colId);
      onReorder(ids);
      return;
    }
    const shortId = e.dataTransfer.getData("text/plain");
    if (!shortId) return;
    const allTasks = Object.values(grouped).flat();
    const task = allTasks.find(t => t.short_id === shortId);
    if (!task || keyFor(task) === targetStatus) {
      setDragging(null);
      return;
    }
    onStatusChange(task, targetStatus);
    setDragging(null);
  }, [grouped, keyFor, onStatusChange, onReorder, statuses]);

  const handleDragOver = useCallback((e: React.DragEvent, status: string) => {
    // A pane/session drag crossing the board belongs to the stage's split
    // layer — lighting the column ring for it promises a drop this column
    // can't perform.
    if (dragCarriesPane(e.dataTransfer)) return;
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
        {visibleStatuses.map((col) => {
          const status = col.id;
          const cfg = statusVisual(col, statuses);
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
              } ${draggingCol === status ? "opacity-40" : ""}`}
            >
              <div
                draggable
                onDragStart={(e) => onColDragStart(e, status)}
                onDragEnd={onColDragEnd}
                className="flex items-center gap-2 px-1 py-2 mb-2 cursor-grab select-none"
              >
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
                    parentChip={parentChipFor?.(task)}
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
          {hiddenWithTasks.map((col) => {
            const cfg = statusVisual(col, statuses);
            const Icon = cfg.icon;
            return (
              <button
                key={col.id}
                onClick={() => onToggleHidden(col.id)}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-sol-bg-alt text-sol-text-muted text-xs transition-colors text-left"
              >
                <Icon className={`w-3 h-3 flex-shrink-0 ${cfg.color}`} />
                <span className="flex-1 truncate">{cfg.label}</span>
                <span className="text-[10px] text-sol-text-dim tabular-nums">{grouped[col.id]?.length || 0}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}


// Grouping vs sorting are independent axes (see useTaskUrlState). These name the
// legal values for each, so we can both validate input and migrate the legacy
// single `sort` param that overloaded the two.
// Legal group values are "none" or one or more axis names joined by "+"
// ("assignee", "assignee+project") — lib/taskGrouping owns that vocabulary.
const TASK_SORT_VALUES = new Set(["priority", "created", "updated", "title", "manual"]);
// Natural direction per sort field — picking a field resets to this so "Created"
// lands newest-first and "Priority"/"Title" land most-urgent / A→Z without a
// second click. The user can still flip it with the direction toggle.
const TASK_SORT_DEFAULT_DIR: Record<string, "asc" | "desc"> = {
  priority: "asc", title: "asc", created: "desc", updated: "desc", manual: "asc",
};
function taskDefaultDir(sort: string): "asc" | "desc" {
  return TASK_SORT_DEFAULT_DIR[sort] ?? "asc";
}
/** Resolve raw (URL or stored) group/sort/dir into a valid triple, migrating the
 *  legacy overloaded `sort`. Legacy values: a grouping word ("plan", "label", …)
 *  became `group=that, sort=priority`; a flat-sort word ("updated", …) became
 *  `group=none`; anything else falls to the default `group=status`. */
function normalizeTaskSort(rawGroup: string, rawSort: string, rawDir: string) {
  let group = isValidTaskGroup(rawGroup) ? rawGroup : "";
  let sort = TASK_SORT_VALUES.has(rawSort) ? rawSort : "";
  if (!group) {
    if (isValidTaskGroup(rawSort)) { group = rawSort; sort = sort || "priority"; }
    else if (TASK_SORT_VALUES.has(rawSort)) { group = "none"; }
    else group = "status";
  }
  if (!sort) sort = "priority";
  const dir: "asc" | "desc" = rawDir === "asc" || rawDir === "desc" ? rawDir : taskDefaultDir(sort);
  return { group, sort, dir };
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
  const rawGroup = (hasUrlParams ? searchParams.get("group") : taskView?.group) || "";
  const rawSort = (hasUrlParams ? searchParams.get("sort") : taskView?.sort) || "";
  const rawDir = (hasUrlParams ? searchParams.get("dir") : taskView?.dir) || "";
  const { group, sort, dir } = normalizeTaskSort(rawGroup, rawSort, rawDir);
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
  const session = hasUrlParams
    ? (searchParams.get("session") || "")
    : (taskView?.session ?? "");

  const setParam = useCallback((updates: Record<string, string>) => {
    const prefs: Record<string, any> = {};
    for (const [k, v] of Object.entries(updates)) {
      prefs[k] = v || undefined;
    }
    updateClientUI({ task_view: { ...taskView, ...prefs } });
    if (!isDetailPage) {
      const params = new URLSearchParams(searchParams.toString());
      // Sync store-only values into URL so they aren't lost when
      // hasUrlParams flips from false→true on first URL param addition
      if (taskView) {
        for (const [k, v] of Object.entries(taskView)) {
          if (v && typeof v === "string" && !params.has(k)) {
            params.set(k, v);
          }
        }
      }
      for (const [k, v] of Object.entries(updates)) {
        if (v) params.set(k, v);
        else params.delete(k);
      }
      const qs = params.toString();
      router.replace(qs ? `/tasks?${qs}` : "/tasks");
    }
  }, [searchParams, router, taskView, updateClientUI, isDetailPage]);

  // Serialize the *effective* view (whichever of URL params / store prefs is
  // live) into an absolute, deep-linkable URL. We can't just copy
  // window.location: on a fresh load the view reads from the store while the URL
  // stays bare `/tasks`, so the address bar wouldn't capture the active sort/
  // filters. Defaults (list view, status grouping) are omitted to keep links tidy.
  const buildShareUrl = useCallback(() => {
    const params = new URLSearchParams();
    const entries: Array<[string, string]> = [
      ["status", status],
      ["view", view === "list" ? "" : view],
      // Always emit `group`: its presence tells the reader this is the new
      // group/sort/dir scheme, so a bare flat-sort word is never mis-migrated as
      // a legacy "no grouping" link. `dir` only when it deviates from the field's
      // natural default, and `sort` only when not the default, to keep links tidy.
      ["group", group],
      ["sort", sort === "priority" ? "" : sort],
      ["dir", dir === taskDefaultDir(sort) ? "" : dir],
      ["priority", priority],
      ["label", label],
      ["assignee", assignee],
      ["statuses", statuses],
      ["source", sourceFilter],
      ["session", session],
    ];
    for (const [k, v] of entries) if (v) params.set(k, v);
    const qs = params.toString();
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    return `${origin}/tasks${qs ? `?${qs}` : ""}`;
  }, [status, view, group, sort, dir, priority, label, assignee, statuses, sourceFilter, session]);

  // Replace the whole pref set rather than merging into it. Restoring a saved
  // view has to REMOVE filters the view doesn't carry, which a merge can't do —
  // and the URL wins over stored prefs while it has params, so it is cleared in
  // the same move or the old filters would come straight back.
  const setTaskView = useCallback((prefs: Record<string, any>) => {
    updateClientUI({ task_view: prefs });
    if (!isDetailPage) router.replace("/tasks");
  }, [updateClientUI, router, isDetailPage]);

  // Grouping and sorting are separate controls. Picking a sort *field* resets the
  // direction to that field's natural default; the toggle flips it explicitly.
  const setGroup = useCallback((g: string) => setParam({ group: g }), [setParam]);

  // A group value names one or two axes ("assignee", "assignee+project"), but
  // the Display popover drives them as two controls, so translate both ways.
  const [primaryAxis, secondaryAxis] = useMemo(() => {
    const axes = parseTaskGroup(group);
    return [axes[0] ?? "none", axes[1] ?? "none"];
  }, [group]);
  // Changing the primary keeps the secondary where it still makes sense; "no
  // grouping" clears both, since there is nothing left to sub-divide.
  const setPrimaryAxis = useCallback((a: string) => {
    if (a === "none") { setGroup("none"); return; }
    setGroup(secondaryAxis !== "none" && secondaryAxis !== a ? `${a}+${secondaryAxis}` : a);
  }, [setGroup, secondaryAxis]);
  const setSecondaryAxis = useCallback((b: string) => {
    if (primaryAxis === "none") return;
    setGroup(b === "none" || b === primaryAxis ? primaryAxis : `${primaryAxis}+${b}`);
  }, [setGroup, primaryAxis]);
  const setSort = useCallback((s: string) => setParam({ sort: s, dir: taskDefaultDir(s) }), [setParam]);
  const toggleSortDir = useCallback(() => setParam({ dir: dir === "asc" ? "desc" : "asc" }), [setParam, dir]);

  return { status, view, group, sort, dir, priority, label, assignee, statuses, sourceFilter, session, setParam, setTaskView, setGroup, primaryAxis, secondaryAxis, setPrimaryAxis, setSecondaryAxis, setSort, toggleSortDir, buildShareUrl };
}

/**
 * The task list surface: tabs, filters, grouping, sort, board, palette, saved
 * views. `/tasks` renders it whole; a project renders the same surface scoped to
 * its own tasks, so working out of a project is the same list, not a second one.
 */
export function TaskListContent({ projectId }: { projectId?: string } = {}) {
  const router = useRouter();
  const params = useParams();
  const { status: urlStatus, view: viewMode, group, sort, dir, priority: priorityFilter, label: labelFilter, assignee: assigneeFilter, statuses: statusesFilter, sourceFilter, session: sessionFilter, setParam, setTaskView, setGroup, primaryAxis, secondaryAxis, setPrimaryAxis, setSecondaryAxis, setSort, toggleSortDir, buildShareUrl } = useTaskUrlState();
  const setTaskFilter = useInboxStore((s) => s.setTaskFilter);
  // The one sanctioned reader for a scoped collection — re-asserts the active
  // workspace over the cross-workspace store cache.
  const wsTasks = useWorkspaceCollection<TaskItem>("tasks");
  // Keyed lookup over the SAME scoped set, so a parent chip can never point at
  // a row outside the active workspace (the server refuses such a parent too).
  const tasksById = useMemo(
    () => Object.fromEntries(wsTasks.map((t) => [String(t._id), t])) as Record<string, TaskItem>,
    [wsTasks],
  );
  const projects = useInboxStore((s) => s.projects);
  const taskActiveSessions = useInboxStore((s) => s.taskActiveSessions);
  const taskOriginBadges = useInboxStore((s) => s.taskOriginBadges);
  const showCreate = useInboxStore((s) => s.createModal === 'task');
  const openCreateModal = useInboxStore((s) => s.openCreateModal);
  const createSavedView = useInboxStore((s) => s.createSavedView);
  const updateSavedView = useInboxStore((s) => s.updateSavedView);
  const taskView = useInboxStore((s) => s.clientState.ui?.task_view);
  // Column keys are status ids; the default status of each terminal category
  // keeps its category name as id, so "dropped" hides the dropped default even
  // on teams with custom lists.
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<string>>(new Set(["dropped"]));

  // Grouping by project is meaningless inside one project — every row shares it.
  const axisKeys = useMemo(
    () => TASK_AXIS_KEYS.filter((k) => !(projectId && k === "project")),
    [projectId]
  );
  // The view is shareable from wherever it is rendered; only the path differs,
  // since the filters/sort/grouping travel in the query string either way.
  const shareUrl = useCallback(() => {
    const url = buildShareUrl();
    return projectId ? url.replace("/tasks", `/projects/${projectId}`) : url;
  }, [buildShareUrl, projectId]);

  // One status control. `status` holds the selection: "" is the default (not
  // done), "all" is everything, otherwise a comma list of status categories.
  // Older links and saved views carried a separate multi `statuses` filter;
  // it is read as the same thing and cleared the moment the tabs write.
  const statusFilter = urlStatus || statusesFilter;
  const setStatusFilter = useCallback((s: string) => {
    setTaskFilter({ status: s });
    setParam({ status: s, statuses: "" });
  }, [setTaskFilter, setParam]);
  const setViewMode = useCallback((v: "list" | "kanban") => setParam({ view: v === "list" ? "" : v }), [setParam]);
  // The prefs a view should store: what is on screen now, minus bookkeeping.
  const livePrefs = useMemo(
    () => ({ ...taskView, status: statusFilter }) as TaskViewPrefs,
    [taskView, statusFilter]
  );
  const handleSaveView = useCallback((name: string) => {
    // A new view starts unstamped, then adopts the id the server hands back —
    // otherwise saving from inside a view would copy its identity too.
    createSavedView({ name, page: "tasks", prefs: prefsForSaving(livePrefs) });
  }, [createSavedView, livePrefs]);

  // Which saved view this list was opened from, and whether it has drifted.
  const savedViewRows = useInboxStore((s) => s.savedViews);
  const openedView = useMemo(() => {
    const id = currentViewId(livePrefs);
    return id ? (savedViewRows as any)[id] : undefined;
  }, [savedViewRows, livePrefs]);
  const dirtyView = useMemo(() => {
    if (!openedView || !isViewDirty(openedView, livePrefs)) return undefined;
    return {
      name: openedView.name as string,
      // Only the author may rewrite a view others are relying on.
      canUpdate: openedView.is_mine !== false,
      onUpdate: () => {
        updateSavedView(openedView._id, { prefs: prefsForSaving(livePrefs) });
        toast.success(`Updated "${openedView.name}"`);
      },
      onDiscard: () => {
        setTaskView({ ...(openedView.prefs ?? {}), [VIEW_ID_KEY]: openedView._id });
      },
    };
  }, [openedView, livePrefs, updateSavedView, setTaskView]);

  useWatchEffect(() => { setTaskFilter({ status: urlStatus }); }, [urlStatus]);

  const { hasMore, loadMore } = useSyncTasks();
  const currentUser = useViewerIdentity();
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  // One workspace pointer for the whole page: rows are scoped by activeTeamId
  // (filterToWorkspace below), so the roster must use the same source — a
  // currentUser.team_id fallback here made the two disagree in the personal
  // space (personal rows, default team's roster).
  const effectiveTeamId = activeTeamId as any;
  // The workspace's status vocabulary: the active team's custom statuses, or
  // the defaults in the personal space. Everything visible is one workspace
  // (filterToWorkspace below), so one list serves columns, groups and drops.
  const taskStatuses = useTeamTaskStatusList(activeTeamId);
  const kanbanKeyFor = useCallback((t: TaskItem) => taskStatusKey(t as any, taskStatuses), [taskStatuses]);
  // Board columns run pipeline order (open left, done right), then any order
  // the user dragged into place. The order is presentation, so it lives in the
  // per-user view prefs, not the URL.
  const kanbanOrder = taskView?.kanban_order;
  const boardStatuses = useMemo(
    () => boardOrderedStatuses(taskStatuses, kanbanOrder),
    [taskStatuses, kanbanOrder]
  );
  const updateClientUIStore = useInboxStore((s) => s.updateClientUI);
  const handleColumnReorder = useCallback(
    (order: string[]) => updateClientUIStore({ task_view: { ...taskView, kanban_order: order } }),
    [updateClientUIStore, taskView]
  );
  // The roster the header pump keeps in the store — persisted, so the assignee
  // filter and the assign palette have people to offer offline too. The pump
  // feeds only the active team, so the personal space reads as nobody rather
  // than as the last team's people.
  const roster = useTeamRosterIdentity();
  const teamMembers = effectiveTeamId ? roster : NO_MEMBERS;
  const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

  const updateTask = useInboxStore((s) => s.updateTask);

  const handleTitleEdit = useCallback(
    (task: TaskItem, title: string) => {
      updateTask(task.short_id, { title });
    },
    [updateTask]
  );

  const handleTriage = useCallback(
    (task: TaskItem, action: "active" | "dismissed") => {
      updateTask(task.short_id, { triage_status: action });
      toast.success(`${task.short_id} ${action === "active" ? "promoted" : "dismissed"}`);
    },
    [updateTask]
  );

  // Strict team scoping. `store.tasks` is a single global collection shared
  // across teams; it is NOT cleared on team switch, and the live sync only
  // overlays (never prunes — see useSyncTasks). Pruning of other-team rows is
  // owned solely by the throttled reconcile crawl, so after switching teams the
  // previously-viewed team's tasks linger here (and survive reloads via IDB)
  // until that crawl catches up. Re-assert the workspace boundary at read time
  // (lib/workspaceScope, the one shared predicate): a team view shows ONLY that
  // team's tasks — personal (teamless) tasks live in the personal view alone.
  const tasksList = useMemo(() => {
    const inWorkspace = wsTasks;
    // A project surface is the same pipeline narrowed at its source, so every
    // count, filter and group below reports on the project alone.
    const scoped = projectId
      ? inWorkspace.filter((t) => String((t as any).project_id || "") === projectId)
      : inWorkspace;
    // Derive the dormant session badge fields here — the single entry point of
    // the page's task pipeline — so every downstream filter/group/badge keeps
    // reading t.origin_session / t.source_agent_type unchanged. Server rows no
    // longer carry them (reading conversations inside webList re-ran the
    // multi-MB query on every message); taskOriginBadges is the one-shot
    // fetched map from useSyncTasks. Rows without a badge keep their identity
    // so memoized descendants stay stable.
    return scoped.map((t) => {
      const originId = t.created_from_conversation ?? t.conversation_ids?.[0];
      const badge = originId ? taskOriginBadges[originId] : undefined;
      const sourceAgent = t.created_from_conversation
        ? taskOriginBadges[t.created_from_conversation]?.agent_type ?? null
        : null;
      if (!badge && !sourceAgent) return t;
      return {
        ...t,
        origin_session: badge ? { ...badge, conversation_id: originId! } : null,
        source_agent_type: sourceAgent,
      };
    });
  }, [wsTasks, taskOriginBadges, projectId]);

  const allLabels = useMemo(() => {
    const set = new Set<string>(DEFAULT_LABELS);
    for (const t of tasksList) t.labels?.forEach((l: string) => set.add(l));
    return [...set].sort();
  }, [tasksList]);

  // Source filtering applied before other filters.
  // Active tasks = not suggested-insight and not dismissed. A promoted mined
  // task counts as active — promote is what lifts it out of triage.
  // The default view is the human's board: web-created tasks plus anything
  // promoted onto it (cast task create --human, or a triage accept). Every
  // machine-made unpromoted task (agent, plan_mode, todo_sync, import) sits
  // behind the Agent segment; "all" shows both. Insight suggestions stay
  // behind the separate triage link.
  // The one activity predicate, shared with mobile/CLI counts so every surface
  // agrees on which rows exist (see @codecast/shared/tasks).
  const isActive = isActiveTask;
  const isTriage = (t: TaskItem) => t.source === "insight" ? t.triage_status !== "dismissed" : t.triage_status === "suggested";
  // Which rows belong on the human's board is the shared isOnHumanBoard rule
  // (@codecast/shared/tasks): human/meeting origin, promoted, or assigned to a
  // person. Web and mobile both use it so the two boards can't drift.
  const onHumanBoard = isOnHumanBoard;
  const sourceFilteredTasks = useMemo(() => {
    if (sourceFilter === "agent") {
      return tasksList.filter((t) => !onHumanBoard(t) && isActive(t));
    } else if (sourceFilter === "all") {
      return tasksList.filter(isActive);
    } else if (sourceFilter === "triage") {
      return tasksList.filter(isTriage);
    } else if (sourceFilter === "dismissed") {
      return tasksList.filter((t) => t.triage_status === "dismissed");
    } else {
      // "" (default) and legacy "human" links both mean the human's board.
      return tasksList.filter((t) => onHumanBoard(t) && isActive(t));
    }
  }, [tasksList, sourceFilter]);


  const baseFilteredTasks = useMemo(() => {
    let list = sourceFilteredTasks;

    // Status filtering. An explicit selection (one status or several) is a
    // plain membership test; "all" imposes nothing; the default hides the
    // terminal states.
    if (statusFilter && statusFilter !== "all") {
      const set = new Set(statusFilter.split(","));
      list = list.filter((t) => set.has(t.status));
    } else if (statusFilter !== "all" && viewMode !== "kanban" && sourceFilter !== "triage" && sourceFilter !== "dismissed") {
      // Default "Not done" tab (no explicit status selected): exclude terminal
      // states so the list contents match the tab's label AND its badge count
      // (taskCounts.active, which already excludes done/dropped). The kanban
      // board is a full-pipeline view that legitimately renders Done/Dropped
      // columns, so it keeps all statuses; likewise the triage/dismissed
      // source views.
      list = list.filter((t) => t.status !== "done" && t.status !== "dropped");
    }

    if (priorityFilter) list = list.filter((t) => t.priority === priorityFilter);
    // Labels are multi-select, and a task carries several — so picking two
    // labels widens the view (either one matches), the same way Linear treats
    // repeated values of one field.
    if (labelFilter) {
      const wanted = labelFilter.split(",").filter(Boolean);
      list = list.filter((t) => t.labels?.some((l) => wanted.includes(l)));
    }
    if (assigneeFilter === "_unassigned") list = list.filter((t) => !t.assignee);
    else if (assigneeFilter) list = list.filter((t) => t.assignee === assigneeFilter);
    return list;
  }, [sourceFilteredTasks, priorityFilter, labelFilter, assigneeFilter, statusFilter, sourceFilter, viewMode]);

  // Session-linkage filter, layered last. "Has session" must match exactly what
  // the row shows a session pill for, so it mirrors the badge's union: a live
  // agent (taskActiveSessions overlay), an originating/linked session
  // (origin_session), or any linked conversation (session_count). session_count
  // alone misses agent-run tasks — assignToAgent binds the conversation's
  // active_task_id but historically didn't add it to conversation_ids, so those
  // show a live pill while session_count stays 0. Kept as its own memo so the
  // heartbeat-churned taskActiveSessions map only forces recompute when this
  // filter is actually engaged (otherwise the base list passes through by
  // reference and downstream groupings stay stable).
  const taskHasSession = useCallback(
    (t: TaskItem) => !!taskActiveSessions[t._id] || !!t.origin_session || (t.session_count ?? 0) > 0,
    [taskActiveSessions]
  );
  const filteredTasks = useMemo(() => {
    const base = (sessionFilter !== "has" && sessionFilter !== "none")
      ? baseFilteredTasks
      : baseFilteredTasks.filter(sessionFilter === "has" ? taskHasSession : (t) => !taskHasSession(t));
    // Derive assignee_info from the live roster so an optimistic re-assignment
    // (updateTask sets only the raw `assignee` id) shows the right person
    // instantly. Keep the same task reference when nothing changed so the
    // downstream sort/group memos stay referentially stable.
    return base.map((t) => {
      const info = resolveAssigneeInfo(t.assignee, t.assignee_info, teamMembers as any[], currentUser);
      const cur = t.assignee_info as any;
      const same = (!info && !cur) || (!!info && !!cur && info.name === cur.name && info.image === cur.image && info.github_username === cur.github_username);
      return same ? t : ({ ...t, assignee_info: info } as TaskItem);
    });
  }, [baseFilteredTasks, sessionFilter, taskHasSession, teamMembers, currentUser]);

  // One comparator drives both the flat list and within-group ordering, so the
  // chosen sort field + direction applies everywhere. Ties fall back to a stable
  // status→priority→recency chain (direction-independent) so equal keys don't
  // shuffle when the user flips asc/desc.
  // Sort, then nest: buildTaskTree reorders the sorted list so each subtask
  // follows its parent, keeping the sort order within every level. Every group
  // memo and the flat list funnel through here, so this one call is what makes
  // nesting show up in all of them. The tree never adds or drops a row — a
  // subtask whose parent was filtered out is promoted to the top level rather
  // than disappearing (or resurfacing its hidden parent).
  const sortTasks = useCallback((tasks: TaskItem[]) => {
    const statusIdx = (s: string) => STATUS_ORDER.indexOf(s as TaskStatus);
    const prio = (t: TaskItem) => PRIORITY_ORDER[t.priority] ?? 3;
    const flip = dir === "desc" ? -1 : 1;
    const sorted = [...tasks].sort((a, b) => {
      // Manual is an absolute rank the user placed by hand (sort_order, with
      // created_at as the unranked fallback on the same ms scale), so the
      // direction flip never applies — inverting it would invert what every
      // drag insertion meant.
      if (sort === "manual") {
        const d = (a.sort_order ?? a.created_at) - (b.sort_order ?? b.created_at);
        if (d !== 0) return d;
      }
      let r = 0;
      if (sort === "priority") r = prio(a) - prio(b);
      else if (sort === "created") r = a.created_at - b.created_at;
      else if (sort === "updated") r = a.updated_at - b.updated_at;
      else if (sort === "title") r = (a.title || "").localeCompare(b.title || "");
      if (r !== 0) return flip * r;
      const sd = statusIdx(a.status) - statusIdx(b.status);
      if (sd !== 0) return sd;
      const pd = prio(a) - prio(b);
      if (pd !== 0) return pd;
      return b.created_at - a.created_at;
    });
    return buildTaskTree(sorted).map((r) => r.task);
    // PRIORITY_ORDER / STATUS_ORDER are value-constant; omitted from deps to keep
    // this callback stable so the group memos don't re-sort every render.
  }, [sort, dir]);

  // Every grouping the list offers — including combined ones like
  // "Assignee · Project" — comes out of one keyed grouper (lib/taskGrouping),
  // so an added axis or pairing costs a descriptor rather than a memo.
  const groupCtx = useMemo(
    () => ({ projects, onFilterLabel: (label: string) => setParam({ label }), taskStatuses }),
    [projects, setParam, taskStatuses]
  );

  const listGroups = useMemo(
    () => buildTaskGroups({ group, tasks: filteredTasks, sortTasks, statusFilter, ctx: groupCtx }),
    [group, filteredTasks, sortTasks, statusFilter, groupCtx]
  );

  // The flat list is that grouping flattened, so keyboard order matches what the
  // headers show; ungrouped, it is the whole filtered set through the comparator.
  const flatTasks = useMemo(
    () => (listGroups ? listGroups.flatMap((g) => g.items) : sortTasks(filteredTasks)),
    [listGroups, sortTasks, filteredTasks]
  );

  const kanbanGrouped = useMemo(() => {
    return filteredTasks.reduce((acc: Record<string, TaskItem[]>, t) => {
      const s = kanbanKeyFor(t);
      if (!acc[s]) acc[s] = [];
      acc[s].push(t);
      return acc;
    }, {});
  }, [filteredTasks, kanbanKeyFor]);

  const taskCounts = useMemo(() => {
    const counts: Record<string, number> = { active: 0, all: 0 };
    for (const t of sourceFilteredTasks) {
      counts[t.status] = (counts[t.status] || 0) + 1;
      counts.all++;
      if (t.status !== "done" && t.status !== "dropped") counts.active++;
    }
    return counts;
  }, [sourceFilteredTasks]);
  // The status tabs that exist for this list: the four everyone has, plus the
  // categories only some teams use (in_review, dropped) once rows carry them.
  const statusTabKeys = useMemo(
    () => STATUS_ORDER.filter((st) => (st !== "in_review" && st !== "dropped") || (taskCounts[st] || 0) > 0),
    [taskCounts],
  );
  // What the current selection means as a set of visible statuses.
  const selectedStatuses = useMemo(() => {
    if (statusFilter === "all") return new Set(statusTabKeys);
    if (!statusFilter) return new Set(statusTabKeys.filter((st) => NOT_DONE.includes(st)));
    return new Set(statusFilter.split(","));
  }, [statusFilter, statusTabKeys]);
  // Add or remove one status. The result is written back in its shortest
  // form: the default set folds to "", the whole set to "all", and an empty
  // set means no constraint at all — the same as every checkbox filter.
  const toggleStatus = useCallback((key: string) => {
    const next = new Set(selectedStatuses);
    if (next.has(key)) next.delete(key); else next.add(key);
    const same = (keys: string[]) => keys.length === next.size && keys.every((k) => next.has(k));
    const notDone = statusTabKeys.filter((st) => NOT_DONE.includes(st));
    if (next.size === 0 || same(statusTabKeys)) setStatusFilter("all");
    else if (same(notDone)) setStatusFilter("");
    else setStatusFilter(STATUS_ORDER.filter((st) => next.has(st)).join(","));
  }, [selectedStatuses, statusTabKeys, setStatusFilter]);

  // View-scope pass, ONE tree walk per rendered list: indent per row (nesting
  // stays inside each group, so a parent under one header never adopts a child
  // filed under another) and the on-screen descendant count from the same rows.
  const viewNesting = useMemo(() => {
    const byId = new Map<string, { indent: number; depth: number; visibleDescendants: number }>();
    const collect = (items: TaskItem[]) => {
      for (const row of buildTaskTree(items)) {
        byId.set(row.task._id, { indent: row.indent, depth: row.depth, visibleDescendants: row.descendantCount });
      }
    };
    if (listGroups) for (const g of listGroups) collect(g.items);
    else collect(flatTasks);
    return byId;
  }, [listGroups, flatTasks]);

  // Collapse state is a device-local viewing preference (localStorage, not the
  // synced prefs bag — an unbounded per-task set doesn't belong in LWW sync).
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set();
    try {
      return new Set(JSON.parse(window.localStorage.getItem("codecast.tasks.collapsed") || "[]"));
    } catch { return new Set(); }
  });
  const toggleCollapsed = useCallback((id: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      // Cap growth: keep the most recent ~300 toggles.
      const arr = [...next].slice(-300);
      try { window.localStorage.setItem("codecast.tasks.collapsed", JSON.stringify(arr)); } catch {}
      return new Set(arr);
    });
  }, []);

  // Drop the on-screen subtree of collapsed parents. Uses true depth (indent
  // clamps at 2, so a depth-3 row shares its parent's indent).
  const applyCollapse = useCallback((items: TaskItem[]) => {
    if (collapsedIds.size === 0) return items;
    const out: TaskItem[] = [];
    let skipBelowDepth: number | null = null;
    for (const t of items) {
      const depth = viewNesting.get(t._id)?.depth ?? 0;
      if (skipBelowDepth !== null && depth > skipBelowDepth) continue;
      skipBelowDepth = null;
      out.push(t);
      if (collapsedIds.has(t._id)) skipBelowDepth = depth;
    }
    return out;
  }, [collapsedIds, viewNesting]);

  const displayGroups = useMemo(() => {
    if (!listGroups) return null;
    if (collapsedIds.size === 0) return listGroups;
    return listGroups.map((g) => ({ ...g, items: applyCollapse(g.items) }));
  }, [listGroups, applyCollapse, collapsedIds]);
  const displayFlat = useMemo(() => applyCollapse(flatTasks), [applyCollapse, flatTasks]);

  // --- Drag & drop semantics. GenericListView owns the gesture; these say what
  // a drop means for tasks: into a bucket = edit the grouped-by field(s), onto
  // a row = the combine dialog (subtask / duplicate), into a gap = manual rank.
  const [combine, setCombine] = useState<{ source: TaskItem; target: TaskItem } | null>(null);

  // Terminal statuses route through the single close gateway, same as kanban.
  const applyDropUpdates = useCallback((task: TaskItem, updates: Record<string, any>) => {
    // status_id travels WITH the status through the close gateway — sent on its
    // own it would move the category server-side and bypass the guard.
    const { status, status_id, ...rest } = updates;
    if (status === "done" || status === "dropped") {
      if (Object.keys(rest).length > 0) updateTask(task.short_id, rest);
      const res = closeTaskWithGuard(task.short_id, status, undefined, status_id);
      if (res.needsConfirm) return;
    } else {
      updateTask(task.short_id, updates);
    }
    // A pure reorder is its own feedback (the row lands where dropped).
    const fields = Object.keys(updates).filter((k) => k !== "sort_order");
    if (fields.length > 0) toast.success(`${task.short_id} moved`);
  }, [updateTask]);

  const handleDropOnGroup = useCallback((task: TaskItem, groupKey: string) => {
    const updates = taskGroupDropUpdates(group, groupKey, task, groupCtx);
    if (!updates) { toast.error("This grouping can't be changed by dragging"); return; }
    if (Object.keys(updates).length === 0) return;
    applyDropUpdates(task, updates);
  }, [group, groupCtx, applyDropUpdates]);

  const canDropOnGroup = useCallback((task: TaskItem, groupKey: string) => {
    const updates = taskGroupDropUpdates(group, groupKey, task, groupCtx);
    return updates !== null && Object.keys(updates).length > 0;
  }, [group, groupCtx]);

  // Manual rank: fractional midpoint between the nearest SIBLINGS (same parent)
  // around the insertion point — display neighbors can be another parent's
  // subtasks, which travel with their parent and would poison the math. A drop
  // into another group's gap also applies that bucket's field edits.
  const handleReorder = useCallback((item: TaskItem, before: TaskItem | null, after: TaskItem | null, groupKey: string | null) => {
    let updates: Record<string, any> = {};
    if (groupKey != null) {
      const gu = taskGroupDropUpdates(group, groupKey, item, groupCtx);
      if (gu === null) { toast.error("This grouping can't be changed by dragging"); return; }
      updates = gu;
    }
    const list = groupKey != null && displayGroups
      ? displayGroups.find((g) => g.key === groupKey)?.items ?? displayFlat
      : displayFlat;
    let idx: number;
    if (after) idx = list.findIndex((t) => t._id === after._id);
    else if (before) idx = list.findIndex((t) => t._id === before._id) + 1;
    else idx = list.length;
    if (idx < 0) return;
    const orderKeyOf = (t: TaskItem) => t.sort_order ?? t.created_at;
    const isSibling = (t: TaskItem) =>
      String(t.parent_id ?? "") === String(item.parent_id ?? "") && t._id !== item._id;
    let prev: TaskItem | null = null;
    let next: TaskItem | null = null;
    for (let i = idx - 1; i >= 0; i--) if (isSibling(list[i])) { prev = list[i]; break; }
    for (let i = idx; i < list.length; i++) if (isSibling(list[i])) { next = list[i]; break; }
    const pk = prev ? orderKeyOf(prev) : null;
    const nk = next ? orderKeyOf(next) : null;
    if (pk != null && nk != null) updates.sort_order = (pk + nk) / 2;
    else if (pk != null) updates.sort_order = pk + 60_000;
    else if (nk != null) updates.sort_order = nk - 60_000;
    if (Object.keys(updates).length === 0) return;
    applyDropUpdates(item, updates);
  }, [group, groupCtx, displayGroups, displayFlat, applyDropUpdates]);

  // Workspace-scope pass, computed once over the whole live set: TRUE deep
  // subtask counts and direct-children progress. The clutter this page exists
  // to fix is about ROWS, not awareness — agent execution subtasks stay off
  // the human board, but their parent must still say that machinery is running
  // under it, so these come from the unfiltered workspace, never the view.
  const familyIndex = useMemo(() => taskFamilyIndex(tasksList), [tasksList]);

  const isBotView = sourceFilter === "triage";
  const renderTaskRow = useCallback((task: TaskItem, state: ItemRowState) => {
    const nest = viewNesting.get(task._id);
    const total = familyIndex.descendants.get(task._id) ?? 0;
    // Floated subtask: parent_id set but the view's tree left this row at the
    // top level — the parent is filtered out (or off this group), so the row
    // carries an orientation chip back to it.
    const parentRow = task.parent_id && (nest?.depth ?? 0) === 0
      ? (tasksById[String(task.parent_id)] as TaskItem | undefined)
      : undefined;
    return (
      <TaskRow
        task={task}
        state={state}
        triageMode={isBotView}
        onTriage={isBotView ? handleTriage : undefined}
        indent={nest?.indent ?? 0}
        hiddenDescendantCount={Math.max(0, total - (nest?.visibleDescendants ?? 0))}
        progress={familyIndex.progress.get(task._id)}
        collapsed={collapsedIds.has(task._id)}
        onToggleCollapse={(nest?.visibleDescendants ?? 0) > 0 || collapsedIds.has(task._id) ? () => toggleCollapsed(task._id) : undefined}
        parentChip={parentRow ? { id: parentRow._id, short_id: parentRow.short_id, title: parentRow.title } : null}
      />
    );
  }, [isBotView, handleTriage, viewNesting, familyIndex, tasksById, collapsedIds, toggleCollapsed]);

  return (
    <>
    <GenericListView<TaskItem>
          activeItemId={(projectId ? params?.taskId : params?.id) as string | undefined}
          paletteTargetType="task"
          getComposeRef={(t) => t.short_id}
          title={projectId ? "Project tasks" : "Tasks"}
          tabs={[
            // Two presets, then the statuses they are made of. Each preset
            // declares its members so the pills/checkboxes show what it means.
            { key: "all", label: "All", count: taskCounts.all, icon: Layers, implies: statusTabKeys, title: "Every status, including Done and Dropped" },
            {
              key: "", label: "Not done", count: taskCounts.active, icon: Activity,
              implies: statusTabKeys.filter((st) => NOT_DONE.includes(st)),
              title: "Not finished: " + NOT_DONE.filter((st) => statusTabKeys.includes(st)).map((st) => STATUS_CONFIG[st].label).join(", "),
            },
            ...statusTabKeys.map((s) => ({
              key: s,
              label: STATUS_CONFIG[s].label,
              count: taskCounts[s] || 0,
              icon: STATUS_CONFIG[s].icon,
              toggle: true,
            })),
          ]}
          activeTab={statusFilter}
          onTabChange={setStatusFilter}
          onTabToggle={toggleStatus}
          groupBy={primaryAxis}
          groupOptions={[
            { value: "none", label: "No grouping" },
            ...axisKeys.map((k) => ({ value: k, label: TASK_AXES[k].label })),
          ]}
          onGroupChange={setPrimaryAxis}
          subGroupBy={secondaryAxis}
          subGroupOptions={[
            { value: "none", label: "Nothing" },
            ...axisKeys.filter((k) => k !== primaryAxis).map((k) => ({ value: k, label: TASK_AXES[k].label })),
          ]}
          onSubGroupChange={setSecondaryAxis}
          sortBy={sort}
          sortOptions={[
            { value: "priority", label: "Priority" },
            { value: "updated", label: "Updated" },
            { value: "created", label: "Created" },
            { value: "title", label: "Title" },
            { value: "manual", label: "Manual (drag to reorder)" },
          ]}
          onSortChange={setSort}
          sortDir={dir}
          onSortDirChange={toggleSortDir}
          filters={{
            hasActive: !!(priorityFilter || labelFilter || assigneeFilter || sourceFilter || sessionFilter),
            defs: [
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
                key: "label", label: "Label", icon: <Tag className="w-3 h-3" />, value: labelFilter, multi: true,
                options: [{ key: "", label: "Any" }, ...allLabels.map((l) => ({ key: l, label: l }))],
                onChange: (v: string) => setParam({ label: v }),
              },
              {
                key: "assignee", label: "Assignee", icon: <User className="w-3 h-3" />, value: assigneeFilter,
                options: [
                  { key: "", label: "Anyone" },
                  { key: "_unassigned", label: "Unassigned" },
                  ...teamMembers.map((m) => ({ key: m._id, label: m.name || m.email || m.github_username || m._id })),
                ],
                onChange: (v: string) => setParam({ assignee: v }),
              },
              {
                key: "session", label: "Session", icon: <MessageSquare className="w-3 h-3" />, value: sessionFilter,
                options: [
                  { key: "", label: "Any" },
                  { key: "has", label: "Has session", icon: MessageSquare, color: "text-sol-cyan" },
                  { key: "none", label: "No session", icon: Circle, color: "text-sol-text-dim" },
                ],
                onChange: (v: string) => setParam({ session: v }),
              },
              // Agent-internal work, mined suggestions, and the combined view
              // live here, tucked in the filter popover — the board is the
              // default and gets no header control of its own.
              {
                key: "source", label: "Source", icon: <Bot className="w-3 h-3" />, value: sourceFilter, showEmptyOption: true,
                options: [
                  { key: "", label: "Your board (default)", icon: User },
                  { key: "agent", label: "Agent-internal", icon: Bot, color: "text-sol-cyan" },
                  { key: "all", label: "All active", icon: Layers },
                  { key: "triage", label: "Suggested", icon: Lightbulb, color: "text-sol-yellow" },
                  { key: "dismissed", label: "Dismissed", icon: EyeOff, color: "text-sol-text-dim" },
                ],
                onChange: (v: string) => setParam({ source: v }),
              },
            ],
            onClear: () => setParam({ statuses: "", priority: "", label: "", assignee: "", source: "", session: "" }),
            onSaveView: handleSaveView,
            dirtyView,
          }}
          shareUrl={shareUrl}
          groups={displayGroups}
          flatItems={displayFlat}
          disableKeyboard={showCreate}
          renderRow={renderTaskRow}
          getItemId={(t) => t._id}
          getItemRoute={(t) => (projectId ? `/projects/${projectId}/${t._id}` : `/tasks/${t._id}`)}
          getSearchText={(t) => `${t.short_id} ${t.title}`}
          emptyIcon={<Circle className="w-8 h-8 opacity-30" />}
          emptyMessage="No tasks found"
          onCreate={() => openCreateModal('task', projectId ? { project_id: projectId } : undefined)}
          hasMore={hasMore}
          onLoadMore={loadMore}
          paletteShortcuts={[
            { key: "s", mode: "status", label: "status" },
            { key: "p", mode: "priority", label: "priority" },
            { key: "l", mode: "labels", label: "labels" },
            { key: "a", mode: "assign", label: "assign" },
          ]}
          paletteProps={{ teamMembers, currentUser: currentUser ?? undefined }}
          onItemEdit={handleTitleEdit}
          listFooter={undefined}
          syncScope="tasks"
          dnd={{
            onDropOnGroup: handleDropOnGroup,
            canDropOnGroup,
            onDropOnItem: (source, target) => setCombine({ source, target }),
            // Gaps only mean something when the user chose manual ordering;
            // otherwise the sort field owns row positions.
            onReorder: sort === "manual" ? handleReorder : undefined,
          }}
          displayExtra={
            <div>
              <div className="text-[10px] uppercase tracking-wider text-sol-text-dim px-1 mb-1">View</div>
              <SegmentedToggle
                fullWidth
                value={viewMode}
                onChange={(v) => setViewMode(v as "list" | "kanban")}
                items={[
                  { key: "list", label: "List", icon: List },
                  { key: "kanban", label: "Board", icon: LayoutGrid },
                ]}
              />
            </div>
          }
          contextMenuContent={(items) => (
            <TaskMenuItems
              tasks={items}
              onOpen={(t) => router.push(projectId ? `/projects/${projectId}/${t._id}` : `/tasks/${t._id}`)}
            />
          )}
          customContent={viewMode === "kanban" ? ({ openContextMenuForItems }) => (
            <KanbanView
              statuses={boardStatuses}
              grouped={kanbanGrouped}
              keyFor={kanbanKeyFor}
              onReorder={handleColumnReorder}
              hiddenStatuses={hiddenStatuses}
              onToggleHidden={(s) => setHiddenStatuses((prev) => {
                const next = new Set(prev);
                if (next.has(s)) next.delete(s); else next.add(s);
                return next;
              })}
              onCardClick={(t) => router.push(`/tasks/${t._id}`)}
              onContextMenu={(e, task) => openContextMenuForItems(e, [task])}
              onAddTask={() => openCreateModal('task', projectId ? { project_id: projectId } : undefined)}
              onStatusChange={(task, newStatusKey) => {
                // Columns are the team's statuses; resolve the key back to the
                // status to learn its category and write both fields.
                const target = statusByKey(taskStatuses, newStatusKey);
                if (!target) return;
                const fields = statusWriteFields(target);
                // Terminal moves go through the single close gateway \u2014 a kanban
                // drag must not bypass the open-subtasks guard. When it defers
                // to the dialog, don't also toast success.
                if (fields.status === "done" || fields.status === "dropped") {
                  const res = closeTaskWithGuard(task.short_id, fields.status, undefined, fields.status_id);
                  if (res.needsConfirm) return;
                } else {
                  updateTask(task.short_id, fields);
                }
                toast.success(`${task.short_id} \u2192 ${target.name}`);
              }}
              parentChipFor={(t) => {
                const p = t.parent_id ? (tasksById[String(t.parent_id)] as TaskItem | undefined) : undefined;
                return p ? { short_id: p.short_id, title: p.title } : null;
              }}
            />
          ) : undefined}
        >
        </GenericListView>
        {combine && (
          <TaskCombineDialog
            source={combine.source}
            target={combine.target}
            onClose={() => setCombine(null)}
          />
        )}
      </>
    );
}

export default function TasksPage() {
  // Selection lives in the URL: /tasks shows the list, /tasks/<id> shows the
  // list + the task detail. Both URLs render this same component (see TabContent),
  // so opening/closing a task reconciles in place — instant, no re-mount, no
  // refresh — and the URL stays the source of truth (deep-linkable).
  const params = useParams();
  const id = (params?.id as string | undefined) || undefined;
  return (
    <AuthGuard>
      <DashboardLayout>
        <DetailSplitLayout list={<TaskListContent />} closeHref="/tasks">
          {id ? (
            <ErrorBoundary name="TaskDetail" level="panel">
              <TaskDetailContent taskId={id} variant="page" />
            </ErrorBoundary>
          ) : null}
        </DetailSplitLayout>
      </DashboardLayout>
    </AuthGuard>
  );
}
