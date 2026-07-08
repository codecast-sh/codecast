"use client";
import { useState, useCallback, useMemo } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useRouter, useSearchParams, useParams, usePathname } from "next/navigation";
import Link from "next/link";
import { useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, TaskItem, TaskViewPrefs, ProjectItem, resolveAssigneeInfo } from "../../store/inboxStore";
import { useSyncTasks } from "../../hooks/useSyncTasks";
import { TaskDetailContent } from "./[id]/page";
import { DetailSplitLayout } from "../../components/DetailSplitLayout";
import { ErrorBoundary } from "../../components/ErrorBoundary";

import { GenericListView, ListGroup, ItemRowState } from "../../components/GenericListView";
import { SegmentedToggle } from "../../components/SegmentedToggle";
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
  Lightbulb,
  Check,
  MessageSquare,
  FolderKanban,
  Layers,
  Activity,
} from "lucide-react";

type TaskStatus = "backlog" | "open" | "in_progress" | "in_review" | "done" | "dropped";
type TaskPriority = "urgent" | "high" | "medium" | "low" | "none";

const STATUS_CONFIG: Record<TaskStatus, { icon: typeof Circle; label: string; color: string }> = {
  backlog: { icon: CircleDotDashed, label: "Backlog", color: "text-sol-text-dim" },
  open: { icon: Circle, label: "Open", color: "text-sol-blue" },
  in_progress: { icon: CircleDot, label: "In Progress", color: "text-sol-yellow" },
  in_review: { icon: CircleDot, label: "In Review", color: "text-sol-violet" },
  done: { icon: CheckCircle2, label: "Done", color: "text-sol-green" },
  dropped: { icon: XCircle, label: "Dropped", color: "text-sol-text-dim" },
};

const PRIORITY_CONFIG: Record<TaskPriority, { icon: typeof Minus; label: string; color: string }> = {
  urgent: { icon: AlertTriangle, label: "Urgent", color: "text-sol-red" },
  high: { icon: ArrowUp, label: "High", color: "text-sol-orange" },
  medium: { icon: Minus, label: "Medium", color: "text-sol-text-muted" },
  low: { icon: ArrowDown, label: "Low", color: "text-sol-text-dim" },
  none: { icon: Minus, label: "None", color: "text-sol-text-dim" },
};

const STATUS_ORDER: TaskStatus[] = ["in_progress", "in_review", "open", "backlog", "done", "dropped"];

export function TaskRow({ task, state, triageMode, onTriage }: { task: TaskItem; state: ItemRowState; triageMode?: boolean; onTriage?: (task: TaskItem, action: "active" | "dismissed") => void }) {
  const activeSession = useInboxStore((s) => s.taskActiveSessions[task._id]) ?? null;
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
        {activeSession && taskLivenessState(task.status, activeSession) === "active" ? (
          <LivenessDot state="active" size="sm" />
        ) : (
          <StatusIcon className={`w-4 h-4 ${status.color}`} />
        )}
      </button>
      <span className="text-xs font-mono text-sol-text-dim w-16 flex-shrink-0 cq-hide-compact">{task.short_id}</span>
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
        <div className="flex items-center gap-1 flex-shrink-0 cq-hide-compact">
          {task.labels.map((l: string) => {
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
        <span className="text-[10px] font-mono text-sol-text-dim leading-none mt-0.5">{task.short_id}</span>
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


// Grouping vs sorting are independent axes (see useTaskUrlState). These name the
// legal values for each, so we can both validate input and migrate the legacy
// single `sort` param that overloaded the two.
const TASK_GROUP_VALUES = new Set(["none", "status", "project", "plan", "assignee", "label", "session"]);
const TASK_SORT_VALUES = new Set(["priority", "created", "updated", "title"]);
// Natural direction per sort field — picking a field resets to this so "Created"
// lands newest-first and "Priority"/"Title" land most-urgent / A→Z without a
// second click. The user can still flip it with the direction toggle.
const TASK_SORT_DEFAULT_DIR: Record<string, "asc" | "desc"> = {
  priority: "asc", title: "asc", created: "desc", updated: "desc",
};
function taskDefaultDir(sort: string): "asc" | "desc" {
  return TASK_SORT_DEFAULT_DIR[sort] ?? "asc";
}
/** Resolve raw (URL or stored) group/sort/dir into a valid triple, migrating the
 *  legacy overloaded `sort`. Legacy values: a grouping word ("plan", "label", …)
 *  became `group=that, sort=priority`; a flat-sort word ("updated", …) became
 *  `group=none`; anything else falls to the default `group=status`. */
function normalizeTaskSort(rawGroup: string, rawSort: string, rawDir: string) {
  let group = TASK_GROUP_VALUES.has(rawGroup) ? rawGroup : "";
  let sort = TASK_SORT_VALUES.has(rawSort) ? rawSort : "";
  if (!group) {
    if (TASK_GROUP_VALUES.has(rawSort)) { group = rawSort; sort = sort || "priority"; }
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

  // Grouping and sorting are separate controls. Picking a sort *field* resets the
  // direction to that field's natural default; the toggle flips it explicitly.
  const setGroup = useCallback((g: string) => setParam({ group: g }), [setParam]);
  const setSort = useCallback((s: string) => setParam({ sort: s, dir: taskDefaultDir(s) }), [setParam]);
  const toggleSortDir = useCallback(() => setParam({ dir: dir === "asc" ? "desc" : "asc" }), [setParam, dir]);

  return { status, view, group, sort, dir, priority, label, assignee, statuses, sourceFilter, session, setParam, setGroup, setSort, toggleSortDir, buildShareUrl };
}

export function TaskListContent() {
  const router = useRouter();
  const params = useParams();
  const { status: urlStatus, view: viewMode, group, sort, dir, priority: priorityFilter, label: labelFilter, assignee: assigneeFilter, statuses: statusesFilter, sourceFilter, session: sessionFilter, setParam, setGroup, setSort, toggleSortDir, buildShareUrl } = useTaskUrlState();
  const setTaskFilter = useInboxStore((s) => s.setTaskFilter);
  const tasks = useInboxStore((s) => s.tasks);
  const projects = useInboxStore((s) => s.projects);
  const taskActiveSessions = useInboxStore((s) => s.taskActiveSessions);
  const taskOriginBadges = useInboxStore((s) => s.taskOriginBadges);
  const showCreate = useInboxStore((s) => s.createModal === 'task');
  const openCreateModal = useInboxStore((s) => s.openCreateModal);
  const saveView = useInboxStore((s) => s.saveView);
  const taskView = useInboxStore((s) => s.clientState.ui?.task_view);
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<string>>(new Set(["dropped"]));

  const statusFilter = urlStatus;
  const setStatusFilter = useCallback((s: string) => {
    setTaskFilter({ status: s });
    setParam({ status: s });
  }, [setTaskFilter, setParam]);
  const setViewMode = useCallback((v: "list" | "kanban") => setParam({ view: v === "list" ? "" : v }), [setParam]);
  const handleSaveView = useCallback((name: string) => {
    saveView({ name, page: "tasks", prefs: { ...taskView, status: statusFilter } as TaskViewPrefs });
  }, [saveView, taskView, statusFilter]);

  useWatchEffect(() => { setTaskFilter({ status: urlStatus }); }, [urlStatus]);

  const { hasMore, loadMore } = useSyncTasks();
  const currentUser = useQuery(api.users.getCurrentUser);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const effectiveTeamId = (activeTeamId || (currentUser as any)?.team_id) as any;
  const teamMembers = useQuery(api.teams.getTeamMembers, effectiveTeamId ? { team_id: effectiveTeamId } : "skip");
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

  // Defensive team scoping. `store.tasks` is a single global collection shared
  // across teams; it is NOT cleared on team switch, and the live sync only
  // overlays (never prunes — see useSyncTasks). Pruning of other-team rows is
  // owned solely by the throttled reconcile crawl, so after switching teams the
  // previously-viewed team's tasks linger here (and survive reloads via IDB)
  // until that crawl catches up. Mirror the server's workspace scoping at read
  // time: in a team view keep this team's tasks plus server-rescued teamless
  // orphans; in the personal view keep only teamless tasks.
  const tasksList = useMemo(() => {
    const all = Object.values(tasks);
    const scoped = all.filter((t) =>
      activeTeamId ? (!t.team_id || t.team_id === activeTeamId) : !t.team_id
    );
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
  }, [tasks, activeTeamId, taskOriginBadges]);

  const allLabels = useMemo(() => {
    const set = new Set<string>(DEFAULT_LABELS);
    for (const t of tasksList) t.labels?.forEach((l: string) => set.add(l));
    return [...set].sort();
  }, [tasksList]);

  // Source filtering applied before other filters.
  // Active tasks = not suggested-insight and not dismissed.
  // "human" = created via web UI, "agent" = created via cast CLI in a session.
  // Insight suggestions are tucked away behind a separate triage link.
  const isActive = (t: TaskItem) => t.triage_status !== "suggested" && t.triage_status !== "dismissed" && t.source !== "insight";
  const isTriage = (t: TaskItem) => t.source === "insight" ? t.triage_status !== "dismissed" : t.triage_status === "suggested";
  const sourceFilteredTasks = useMemo(() => {
    if (sourceFilter === "human") {
      return tasksList.filter((t) => t.source === "human" && isActive(t));
    } else if (sourceFilter === "agent") {
      return tasksList.filter((t) => t.source === "agent" && isActive(t));
    } else if (sourceFilter === "triage") {
      return tasksList.filter(isTriage);
    } else if (sourceFilter === "dismissed") {
      return tasksList.filter((t) => t.triage_status === "dismissed");
    } else {
      return tasksList.filter(isActive);
    }
  }, [tasksList, sourceFilter]);

  const suggestedCount = useMemo(() => {
    return tasksList.filter(isTriage).length;
  }, [tasksList]);

  const baseFilteredTasks = useMemo(() => {
    let list = sourceFilteredTasks;

    // Status filtering. Precedence: a single-status tab (open/done/…) wins; then
    // the multi-status dropdown; then the per-tab fallback. The "All" tab imposes
    // no status constraint of its own but still honours the dropdown, and unlike
    // the default "Active" tab it does NOT hide terminal Done/Dropped.
    if (statusFilter && statusFilter !== "all") {
      list = list.filter((t) => t.status === statusFilter);
    } else if (statusesFilter) {
      const set = new Set(statusesFilter.split(","));
      list = list.filter((t) => set.has(t.status));
    } else if (statusFilter !== "all" && viewMode !== "kanban" && sourceFilter !== "triage" && sourceFilter !== "dismissed") {
      // Default "Active" tab (no explicit status selected): exclude terminal
      // states so the list contents match the tab's label AND its badge count
      // (taskCounts.active, which already excludes done/dropped). Without this,
      // done/dropped tasks leak into the Active view. The kanban board is a
      // full-pipeline view that legitimately renders Done/Dropped columns, so
      // it keeps all statuses; likewise the triage/dismissed source views.
      list = list.filter((t) => t.status !== "done" && t.status !== "dropped");
    }

    if (priorityFilter) list = list.filter((t) => t.priority === priorityFilter);
    if (labelFilter) list = list.filter((t) => t.labels?.includes(labelFilter));
    if (assigneeFilter === "_unassigned") list = list.filter((t) => !t.assignee);
    else if (assigneeFilter) list = list.filter((t) => t.assignee === assigneeFilter);
    return list;
  }, [sourceFilteredTasks, priorityFilter, labelFilter, assigneeFilter, statusFilter, statusesFilter, sourceFilter, viewMode]);

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
  const sortTasks = useCallback((tasks: TaskItem[]) => {
    const statusIdx = (s: string) => STATUS_ORDER.indexOf(s as TaskStatus);
    const prio = (t: TaskItem) => PRIORITY_ORDER[t.priority] ?? 3;
    const flip = dir === "desc" ? -1 : 1;
    return [...tasks].sort((a, b) => {
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
    // PRIORITY_ORDER / STATUS_ORDER are value-constant; omitted from deps to keep
    // this callback stable so the group memos don't re-sort every render.
  }, [sort, dir]);

  const planGroups = useMemo(() => {
    if (group !== "plan") return null;
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
      g.tasks = sortTasks(g.tasks);
    }
    return ordered;
  }, [filteredTasks, group, sortTasks]);

  const assigneeGroups = useMemo(() => {
    if (group !== "assignee") return null;
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
      g.tasks = sortTasks(g.tasks);
    }
    return ordered;
  }, [filteredTasks, group, sortTasks]);

  const sessionGroups = useMemo(() => {
    if (group !== "session") return null;
    const bySession: Record<string, { session: NonNullable<TaskItem["origin_session"]>; tasks: TaskItem[] }> = {};
    const noSession: TaskItem[] = [];
    for (const t of filteredTasks) {
      if (t.origin_session) {
        const key = t.origin_session.session_id;
        if (!bySession[key]) bySession[key] = { session: t.origin_session, tasks: [] };
        bySession[key].tasks.push(t);
      } else {
        noSession.push(t);
      }
    }
    // Sort groups by most recent task first
    const ordered = Object.values(bySession)
      .sort((a, b) => Math.max(...b.tasks.map(t => t.created_at)) - Math.max(...a.tasks.map(t => t.created_at)));
    if (noSession.length > 0) {
      ordered.push({ session: { conversation_id: "", session_id: "", title: undefined }, tasks: noSession });
    }
    for (const g of ordered) {
      g.tasks = sortTasks(g.tasks);
    }
    return ordered;
  }, [filteredTasks, group, sortTasks]);

  const projectGroups = useMemo(() => {
    if (group !== "project") return null;
    const byProject: Record<string, { project: ProjectItem | undefined; tasks: TaskItem[] }> = {};
    const noProject: TaskItem[] = [];
    for (const t of filteredTasks) {
      const pid = (t as any).project_id;
      if (pid) {
        if (!byProject[pid]) byProject[pid] = { project: projects[pid], tasks: [] };
        byProject[pid].tasks.push(t);
      } else {
        noProject.push(t);
      }
    }
    const ordered = Object.values(byProject)
      .sort((a, b) => (a.project?.title || "").localeCompare(b.project?.title || ""));
    if (noProject.length > 0) {
      ordered.push({ project: undefined, tasks: noProject });
    }
    for (const g of ordered) {
      g.tasks = sortTasks(g.tasks);
    }
    return ordered;
  }, [filteredTasks, group, sortTasks, projects]);

  // Group by the task's primary label (labels[0]) — the same representative
  // label the kanban card shows. A task lands in exactly one bucket so its
  // _id stays a unique virtualizer key (GenericListView keys rows by id);
  // tasks with no labels collect in a trailing "No label" group.
  const labelGroups = useMemo(() => {
    if (group !== "label") return null;
    const byLabel: Record<string, { label: string; tasks: TaskItem[] }> = {};
    const noLabel: TaskItem[] = [];
    for (const t of filteredTasks) {
      const primary = t.labels?.[0];
      if (primary) {
        if (!byLabel[primary]) byLabel[primary] = { label: primary, tasks: [] };
        byLabel[primary].tasks.push(t);
      } else {
        noLabel.push(t);
      }
    }
    const ordered = Object.values(byLabel)
      .sort((a, b) => a.label.localeCompare(b.label));
    if (noLabel.length > 0) {
      ordered.push({ label: "", tasks: noLabel });
    }
    for (const g of ordered) {
      g.tasks = sortTasks(g.tasks);
    }
    return ordered;
  }, [filteredTasks, group, sortTasks]);

  // Status grouping is suppressed when a single-status tab is active (every row
  // would share that status), collapsing to a flat sorted list instead. Each
  // status bucket is ordered by the active sort field + direction, same as every
  // other grouping.
  const statusGroups = useMemo(() => {
    if (group !== "status") return null;
    if (statusFilter && statusFilter !== "all") return null;
    const byStatus: Record<string, TaskItem[]> = {};
    for (const t of filteredTasks) (byStatus[t.status as string] ??= []).push(t);
    return STATUS_ORDER
      .filter((s) => byStatus[s]?.length)
      .map((s) => ({ status: s, tasks: sortTasks(byStatus[s]) }));
  }, [group, statusFilter, filteredTasks, sortTasks]);

  // Exactly one *Groups memo is non-null at a time (each gates on `group`), so
  // the flat list is just that grouping flattened — or, when ungrouped, the whole
  // filtered set run through the comparator.
  const flatTasks = useMemo(() => {
    const active = planGroups || assigneeGroups || sessionGroups || projectGroups || labelGroups || statusGroups;
    if (active) return active.flatMap((g: any) => g.tasks);
    return sortTasks(filteredTasks);
  }, [filteredTasks, sortTasks, planGroups, assigneeGroups, sessionGroups, projectGroups, labelGroups, statusGroups]);

  const kanbanGrouped = useMemo(() => {
    return filteredTasks.reduce((acc: Record<string, TaskItem[]>, t) => {
      const s = t.status as string;
      if (!acc[s]) acc[s] = [];
      acc[s].push(t);
      return acc;
    }, {});
  }, [filteredTasks]);

  const listGroups = useMemo((): ListGroup<TaskItem>[] | null => {
    if (group === "plan" && planGroups) {
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
    if (group === "assignee" && assigneeGroups) {
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
    if (group === "session" && sessionGroups) {
      return sessionGroups.map((g) => ({
        key: g.session.session_id || "__no_session",
        label: g.session.session_id
          ? (g.session.title || g.session.session_id.slice(0, 8))
          : "No session",
        icon: <MessageSquare className={`w-3.5 h-3.5 ${g.session.session_id ? "text-sol-cyan" : "text-sol-text-dim"}`} />,
        extra: g.session.conversation_id ? (
          <Link href={`/sessions/${g.session.conversation_id}`} onClick={(e) => e.stopPropagation()} className="text-[10px] text-sol-cyan hover:underline flex-shrink-0">
            View session
          </Link>
        ) : undefined,
        items: g.tasks,
      }));
    }
    if (group === "project" && projectGroups) {
      return projectGroups.map((g) => ({
        key: g.project?._id || "__no_project",
        label: g.project?.title || "No project",
        icon: <FolderKanban className={`w-3.5 h-3.5 ${g.project ? "text-sol-cyan" : "text-sol-text-dim"}`} />,
        extra: g.project ? (
          <Link href={`/projects/${g.project._id}`} onClick={(e) => e.stopPropagation()} className="text-[10px] text-sol-cyan hover:underline flex-shrink-0">
            View project
          </Link>
        ) : undefined,
        items: g.tasks,
      }));
    }
    if (group === "label" && labelGroups) {
      return labelGroups.map((g) => {
        const lc = g.label ? getLabelColor(g.label) : null;
        return {
          key: g.label || "__no_label",
          label: g.label || "No label",
          icon: lc ? (
            <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${lc.dot}`} />
          ) : (
            <Tag className="w-3.5 h-3.5 text-sol-text-dim" />
          ),
          extra: g.label ? (
            <button
              onClick={(e) => { e.stopPropagation(); setParam({ label: g.label }); }}
              className="text-[10px] text-sol-cyan hover:underline flex-shrink-0"
            >
              Filter
            </button>
          ) : undefined,
          items: g.tasks,
        };
      });
    }
    if (!statusGroups) return null;
    return statusGroups.map(({ status: s, tasks }) => {
      const cfg = STATUS_CONFIG[s];
      const Icon = cfg.icon;
      return { key: s, label: cfg.label, icon: <Icon className={`w-3.5 h-3.5 ${cfg.color}`} />, items: tasks };
    });
  }, [group, planGroups, assigneeGroups, sessionGroups, projectGroups, labelGroups, statusGroups, setParam]);

  const taskCounts = useMemo(() => {
    const counts: Record<string, number> = { active: 0, all: 0 };
    for (const t of sourceFilteredTasks) {
      counts[t.status] = (counts[t.status] || 0) + 1;
      counts.all++;
      if (t.status !== "done" && t.status !== "dropped") counts.active++;
    }
    return counts;
  }, [sourceFilteredTasks]);

  const isBotView = sourceFilter === "triage";
  const renderTaskRow = useCallback((task: TaskItem, state: ItemRowState) => (
    <TaskRow task={task} state={state} triageMode={isBotView} onTriage={isBotView ? handleTriage : undefined} />
  ), [isBotView, handleTriage]);

  return (
    <GenericListView<TaskItem>
          activeItemId={params?.id as string | undefined}
          paletteTargetType="task"
          title="Tasks"
          tabs={[
            { key: "all", label: "All", count: taskCounts.all, icon: Layers },
            { key: "", label: "Active", count: taskCounts.active, icon: Activity },
            ...((["backlog", "open", "in_progress", "done"] as const).map((s) => ({
              key: s,
              label: STATUS_CONFIG[s].label,
              count: taskCounts[s] || 0,
              icon: STATUS_CONFIG[s].icon,
            }))),
          ]}
          activeTab={statusFilter}
          onTabChange={setStatusFilter}
          groupBy={group}
          groupOptions={[
            { value: "none", label: "No grouping" },
            { value: "status", label: "Status" },
            { value: "project", label: "Project" },
            { value: "plan", label: "Plan" },
            { value: "assignee", label: "Assignee" },
            { value: "label", label: "Label" },
            { value: "session", label: "Session" },
          ]}
          onGroupChange={setGroup}
          sortBy={sort}
          sortOptions={[
            { value: "priority", label: "Priority" },
            { value: "updated", label: "Updated" },
            { value: "created", label: "Created" },
            { value: "title", label: "Title" },
          ]}
          onSortChange={setSort}
          sortDir={dir}
          onSortDirChange={toggleSortDir}
          filters={{
            hasActive: !!(statusesFilter || priorityFilter || labelFilter || assigneeFilter || sourceFilter || sessionFilter),
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
              {
                key: "session", label: "Session", icon: <MessageSquare className="w-3 h-3" />, value: sessionFilter,
                options: [
                  { key: "", label: "Any" },
                  { key: "has", label: "Has session", icon: MessageSquare, color: "text-sol-cyan" },
                  { key: "none", label: "No session", icon: Circle, color: "text-sol-text-dim" },
                ],
                onChange: (v: string) => setParam({ session: v }),
              },
            ],
            onClear: () => setParam({ statuses: "", priority: "", label: "", assignee: "", source: "", session: "" }),
            onSaveView: handleSaveView,
          }}
          shareUrl={buildShareUrl}
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
          onItemEdit={handleTitleEdit}
          listFooter={undefined}
          syncScope="tasks"
          headerExtra={
            <>
              <SegmentedToggle
                collapse
                value={sourceFilter}
                onChange={(v) => setParam({ source: v })}
                items={[
                  { key: "", label: "All", title: "All tasks" },
                  { key: "human", icon: User, title: "Created via web UI" },
                  { key: "agent", icon: Bot, title: "Created via cast CLI in a session" },
                ]}
              />
              {suggestedCount > 0 && (
                <button
                  onClick={() => setParam({ source: sourceFilter === "triage" ? "" : "triage" })}
                  className={`cq-header-collapse flex items-center gap-1.5 h-7 px-2 text-xs rounded-md border transition-colors ${sourceFilter === "triage" ? "border-sol-yellow/40 bg-sol-yellow/10 text-sol-yellow" : "border-sol-border/40 text-sol-text-dim hover:text-sol-text"}`}
                  title="Review suggested insights"
                >
                  <Lightbulb className="w-3.5 h-3.5" />
                  <span>{suggestedCount}</span>
                </button>
              )}
            </>
          }
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
              onStatusChange={(task, newStatus) => {
                updateTask(task.short_id, { status: newStatus });
                toast.success(`${task.short_id} \u2192 ${newStatus.replace("_", " ")}`);
              }}
            />
          ) : undefined}
        >
        </GenericListView>
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
        <DetailSplitLayout list={<TaskListContent />}>
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
