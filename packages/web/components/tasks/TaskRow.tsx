import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ShortId } from "../ShortId";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useInboxStore, type TaskItem } from "../../store/inboxStore";
import { AssigneeFace } from "../identity/AssigneeFace";
import { LivePulseHalo } from "../LivenessDot";
import { TaskSessionBadge } from "./TaskSessionBadge";
import { IssueLink } from "./IssueLink";
import { TaskLineChip } from "./StationStrip";
import { TaskDecisionChip } from "../decisions/TaskDecisions";
import { TaskStatusBadge } from "../TaskStatusBadge";
import { LabelChips } from "../LabelChips";
import { AgentTypeIcon, formatAgentType } from "../AgentTypeIcon";
import type { ItemRowState } from "../ListRowShell";
import { taskLivenessState } from "../../lib/liveness";
import { statusVisual, taskStatusOf, useTeamTaskStatusList } from "../../lib/taskStatuses";
import { getLabelColor } from "../../lib/labelColors";
import { taskOrigin } from "@codecast/shared/tasks";
import {
  Link2,
  X,
  Bot,
  Users,
  Check,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Copy,
} from "lucide-react";
import { taskPriority } from "../../lib/taskPriority";
import { useTaskActiveSession } from "./taskActiveSession";

// The task list row and the board card. The tasks page lays them out; every
// write goes through the callbacks it passes (ItemRowState, onAssign), so a
// surface outside the app (the marketing hero) renders them from fixtures.

// Linear's progress circle, tiny: a ring that fills as direct subtasks close.
export function SubtaskRing({ done, total }: { done: number; total: number }) {
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

export type { TaskPriority } from "../../lib/taskPriority";

export function TaskRow({ task, state, onFilterLabel, triageMode, onTriage, indent = 0, hiddenDescendantCount = 0, progress, collapsed = false, onToggleCollapse, parentChip }: {
  task: TaskItem;
  state: ItemRowState;
  onFilterLabel: (label: string) => void;
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
  const activeSession = useTaskActiveSession(task._id);
  // Resolve through the task's own team so a row shows that team's vocabulary
  // ("Working on") even if it ever renders outside its workspace view.
  const teamStatuses = useTeamTaskStatusList((task as any).team_id);
  const status = statusVisual(taskStatusOf(task as any, teamStatuses), teamStatuses);
  const priority = taskPriority(task.priority);
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
      <ShortId id={task.short_id} className="text-xs text-sol-text-dim w-16 cq-hide-compact" />
      {task.external && <IssueLink external={task.external} className="cq-hide-compact" />}
      <TaskDecisionChip taskId={task._id} />
      <TaskLineChip task={task as any} />
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
        <TaskSessionBadge task={task} className="cq-hide-compact" />
      ) : task.origin_session ? (
        <span className="flex items-center gap-1 flex-shrink-0 cq-hide-compact">
          <TaskSessionBadge task={task} />
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
        <LabelChips labels={task.labels} onLabelClick={onFilterLabel} className="cq-hide-compact" />
      )}
      {task.assignee_info && (() => {
        const avatar = <AssigneeFace info={task.assignee_info} size={20} />;
        return (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); state.onOpenPalette("assign"); }}
            className="flex items-center gap-1 flex-shrink-0 rounded-full hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sol-cyan cq-hide-compact"
            title={`Change assignee: ${task.assignee_info.name}`}
            aria-label={`Change assignee: ${task.assignee_info.name}`}
          >
            {avatar}
          </button>
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

export function KanbanCard({
  task,
  onFilterLabel,
  isDragging,
  onClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
  parentChip,
  onAssign,
}: {
  task: TaskItem;
  onFilterLabel: (label: string) => void;
  isDragging?: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  /** The board flattens trees; a subtask card names its parent instead. */
  parentChip?: { short_id: string; title: string } | null;
  /** Opens the assignee picker; the board opens the store's palette. */
  onAssign?: () => void;
}) {
  const priority = taskPriority(task.priority, "none");
  const PriorityIcon = priority.icon;
  const assignee = task.assignee_info;
  const firstLabel = task.labels?.[0];

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
          <ShortId id={task.short_id} />
          {task.external && <IssueLink external={task.external} className="max-w-[9rem]" />}
          {parentChip && (
            <span className="flex items-center gap-0.5 min-w-0 opacity-80" title={`Subtask of ${parentChip.short_id}: ${parentChip.title}`}>
              <CornerDownRight className="w-2.5 h-2.5 flex-shrink-0" />
              <span className="truncate max-w-[7rem]">{parentChip.short_id}</span>
            </span>
          )}
        </span>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <TaskSessionBadge task={task} compact />
          {assignee ? (() => {
            const av = <AssigneeFace info={assignee} size={16} />;
            return (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); if (onAssign) onAssign(); else useInboxStore.getState().openPalette({ targets: [task], targetType: "task", mode: "assign" }); }}
                className="rounded-full hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sol-cyan"
                title={`Change assignee: ${assignee.name}`}
                aria-label={`Change assignee: ${assignee.name}`}
              >
                {av}
              </button>
            );
          })() : null}
        </div>
      </div>
      <p className="text-[13px] text-sol-text leading-snug mb-3 line-clamp-3 font-medium">{task.title}</p>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <PriorityIcon className={`w-3 h-3 flex-shrink-0 ${priority.color}`} />
          <TaskLineChip task={task as any} />
          {firstLabel && (() => {
            const lc = getLabelColor(firstLabel);
            return (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onFilterLabel(firstLabel); }}
                title={`Filter by label: ${firstLabel}`}
                aria-label={`Filter by label: ${firstLabel}`}
                className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border hover:brightness-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sol-cyan ${lc.bg} ${lc.border} ${lc.text}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${lc.dot}`} />
                {firstLabel}
              </button>
            );
          })()}
        </div>
        <span className="text-[10px] text-sol-text-dim tabular-nums">{fmtDate(task.updated_at)}</span>
      </div>
    </div>
  );
}
