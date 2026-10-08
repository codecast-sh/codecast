"use client";
import { useAssistantScope, useHostedMode, useModeWords } from "../../lib/surfaces";
import { isAssistantTask } from "../../lib/assistantScope";
import { AssistantScopeSwitch, MoreInEverything } from "../../components/AssistantScopeSwitch";
import { useWorkspaceArgs } from "../../hooks/useWorkspaceArgs";
import { createTaskAndAdopt } from "../../lib/taskActions";
import { useState, useCallback, useMemo } from "react";
import { sharePageUrl } from "../../lib/utils";
import { ShortId } from "../../components/ShortId";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useCoarseNow } from "../../hooks/useCoarseNow";
import { useRouter, useSearchParams, useParams, usePathname } from "next/navigation";
import { useInboxStore, TaskItem, TaskViewPrefs, ProjectItem, resolveAssigneeInfo } from "../../store/inboxStore";
import { useTeamRosterIdentity, useViewerIdentity, type RosterIdentity } from "../../hooks/useTeamRoster";
import { useSyncTasks } from "../../hooks/useSyncTasks";
import { TaskDetailContent } from "./[id]/page";
import { DetailSplitLayout } from "../../components/DetailSplitLayout";
import { dragCarriesPane } from "../../lib/stage";
import { chainAssignees, sameAssigneeInfo } from "@codecast/shared/contracts/orgAssignee";
import { useOrgRoles } from "../../hooks/useOrgRoles";
import { useRolesAndPeopleOptions } from "../../hooks/useRolesAndPeopleOptions";
import { useInitiatives } from "../../hooks/useInitiatives";
import { projectInitiativeIndex } from "../../lib/initiatives";
import { useSyncOrgTreeFeeder } from "../../hooks/useSyncOrgTree";
import { ErrorBoundary } from "../../components/ErrorBoundary";

import { GenericListView, ListGroup, ItemRowState } from "../../components/GenericListView";
import { TaskMenuItems } from "../../components/menus/ObjectContextMenus";
import { SegmentedToggle } from "../../components/SegmentedToggle";
import { TaskRow, KanbanCard } from "../../components/tasks/TaskRow";

// The personal space has no roster; a stable empty list keeps the memos quiet.
const NO_MEMBERS: RosterIdentity[] = [];
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { TASK_STATUS, TASK_STATUS_ORDER, type TaskStatus } from "../../components/TaskStatusBadge";
import { buildTaskGroups, canSubGroup, isValidTaskGroup, parseTaskGroup, taskGroupDropUpdates, TASK_AXES, TASK_AXIS_KEYS } from "../../lib/taskGrouping";
import { boardOrderedStatuses, statusByKey, statusVisual, statusWriteFields, taskStatusKey, taskStatusOf, useTeamTaskStatusList } from "../../lib/taskStatuses";
import type { TeamTaskStatus } from "@codecast/shared/tasks";
import { IssueLink } from "../../components/tasks/IssueLink";
import { useSyncRuns } from "../../hooks/useSyncRuns";
import { toast } from "sonner";
import { DEFAULT_LABELS } from "../../lib/labelColors";
import { useWorkspaceCollection } from "../../hooks/useWorkspaceCollection";
import { currentViewId, isViewDirty, prefsForSaving, VIEW_ID_KEY } from "../../lib/savedViews";
import { buildTaskTree, isActiveTask, isOnHumanBoard, taskFamilyIndex } from "@codecast/shared/tasks";
import { applyTaskDrop, closeTaskWithGuard, setTaskParent } from "../../lib/taskActions";
import { undoAsOne } from "../../store/undoActions";
import { gestureToast } from "../../store/undoStack";
import { FeatureUpsell } from "../../components/agentFeatures/FeatureUpsell";
import { COMPLETION_WINDOWS, completionWindow, filterTasksByCompletion, pendingTaskCompletionsSig } from "../../lib/taskCompletion";
import { tasksForSource } from "../../lib/taskSource";
import { isReadyInStore, readySig, UNBLOCKED_VIEW } from "../../lib/taskBlockers";
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
  Clock,
  CalendarDays,
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
  MessageSquare,
  FolderKanban,
  Layers,
  Activity,
  CornerDownRight,
  Copy,
  CirclePlay,
} from "lucide-react";

// One task-status vocabulary, shared with TaskStatusBadge and the groupers.
const STATUS_CONFIG = TASK_STATUS;

const STATUS_ORDER = TASK_STATUS_ORDER;
/** What the default "Active" tab shows: work that is live. Done and Dropped are
 *  finished, and Backlog is not started — a pile you keep rather than a queue
 *  you work, so it belongs behind the Status filter, not in the default list. */
const ACTIVE: TaskStatus[] = STATUS_ORDER.filter((st) => st !== "done" && st !== "dropped" && st !== "backlog");

/** Compact one-line rendering of a task inside the combine dialog, so the
 *  reader sees exactly which two rows the drop involved. */
function TaskMiniCard({ task }: { task: TaskItem }) {
  const teamStatuses = useTeamTaskStatusList((task as any).team_id);
  const status = statusVisual(taskStatusOf(task as any, teamStatuses), teamStatuses);
  const StatusIcon = status.icon;
  return (
    <div className="flex items-center gap-2 rounded-md border border-sol-border/40 bg-sol-bg-alt/40 px-2.5 py-1.5 min-w-0">
      <StatusIcon className={`w-3.5 h-3.5 flex-shrink-0 ${status.color}`} />
      <ShortId id={task.short_id} className="text-xs text-sol-text-dim" />
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
    // One gesture, one undo: the link and the close come back together.
    undoAsOne(`Marked ${source.short_id} as a duplicate of ${target.short_id}`, () => {
      updateTask(source.short_id, { duplicate_of: target.short_id });
      closeTaskWithGuard(source.short_id, "dropped");
    });
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

const COLUMN_DRAG_TYPE = "application/x-codecast-kanban-column";

function KanbanView({
  statuses,
  onFilterLabel,
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
  onFilterLabel: (label: string) => void;
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
                    onFilterLabel={onFilterLabel}
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
/** x on a hosted to-do: check it off, or open it again, as one gesture with
 *  its Undo toast. Closing goes through the one close gateway, so a to-do
 *  with open subtasks still asks first. */
function toggleTodoDone(task: TaskItem): void {
  const done = task.status === "done";
  gestureToast(done ? `Reopened “${task.title}”` : `Done: “${task.title}”`, () => {
    if (done) useInboxStore.getState().updateTask(task.short_id, { status: "open" });
    else closeTaskWithGuard(task.short_id, "done");
  });
}

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

/** The view a hosted person starts from, on Personal and on a team: open
 *  to-dos, newest first, in one list. On Personal every to-do is theirs, so
 *  grouping by who holds it would only file most of them under
 *  "Unassigned"; on a team it put a person's header over each handful. A
 *  link's own view and any grouping other than by person still win. */
export function hostedPersonalView(view: { group: string; sort: string; dir: "asc" | "desc" }, rawGroup: string): { group: string; sort: string; dir: "asc" | "desc" } {
  if (rawGroup && !/\b(assignee|chain)\b/.test(view.group)) return view;
  return { group: "none", sort: "created", dir: "desc" };
}

function useTaskUrlState(hosted = false, scoped = false) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const savedTaskView = useInboxStore((s) => s.clientState.ui?.task_view);
  const updateSavedUI = useInboxStore((s) => s.updateClientUI);
  // A list scoped to a role's area or to one project's board starts from that
  // scope alone: the filters the person set on the Tasks page (another
  // workspace's labels, "All", a project) would hide the work or count rows
  // the board does not hold, so a scoped list keeps its own view, for as long
  // as it is open, and never rewrites the Tasks page's saved one.
  const [scopedView, setScopedView] = useState<TaskViewPrefs | undefined>(undefined);
  const taskView = scoped ? scopedView : savedTaskView;
  const updateClientUI = useCallback((patch: { task_view: TaskViewPrefs }) => (scoped ? setScopedView(patch.task_view) : updateSavedUI(patch)), [scoped, updateSavedUI]);

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
  const normalized = normalizeTaskSort(rawGroup, rawSort, rawDir);
  const { group, sort, dir } = hosted && !hasUrlParams ? hostedPersonalView(normalized, rawGroup) : normalized;
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
  const completed = completionWindow(hasUrlParams ? searchParams.get("completed") : taskView?.completed);
  const effectivePrefs = useMemo(() => ({
    ...taskView,
    status, view, priority, label, assignee, statuses,
    group: rawGroup,
    sort: rawSort,
    dir: rawDir,
    source: sourceFilter,
    session, completed,
  }), [taskView, status, view, rawGroup, rawSort, rawDir, priority, label, assignee, statuses, sourceFilter, session, completed]);

  const setParam = useCallback((updates: Record<string, string>) => {
    const prefs: Record<string, any> = {};
    for (const [k, v] of Object.entries(updates)) {
      prefs[k] = v || undefined;
    }
    updateClientUI({ task_view: { ...effectivePrefs, ...prefs } });
    if (!isDetailPage) {
      const params = new URLSearchParams(searchParams.toString());
      // Sync store-only values into URL so they aren't lost when
      // hasUrlParams flips from false→true on first URL param addition
      if (!hasUrlParams) {
        for (const [k, v] of Object.entries(effectivePrefs)) {
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
  }, [searchParams, router, effectivePrefs, hasUrlParams, updateClientUI, isDetailPage]);

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
      ["completed", completed],
    ];
    for (const [k, v] of entries) if (v) params.set(k, v);
    const qs = params.toString();
    return sharePageUrl(`/tasks${qs ? `?${qs}` : ""}`);
  }, [status, view, group, sort, dir, priority, label, assignee, statuses, sourceFilter, session, completed]);

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

  return { status, view, group, sort, dir, priority, label, assignee, statuses, sourceFilter, session, completed, effectivePrefs, setParam, setTaskView, setGroup, primaryAxis, secondaryAxis, setPrimaryAxis, setSecondaryAxis, setSort, toggleSortDir, buildShareUrl };
}

/**
 * The task list surface: tabs, filters, grouping, sort, board, palette, saved
 * views. `/tasks` renders it whole; a project renders the same surface scoped to
 * its own tasks, so working out of a project is the same list, not a second one.
 */
/** A set of projects and plans to narrow the list to (an org role's scope,
 *  docs/architecture/scopes-and-feed.md F1): a task is in when its project or
 *  its plan is listed. The caller expands a plan's project into planIds. */
export type TaskListScope = { projectIds: string[]; planIds: string[] };

const RUNS_FEED_ARGS = { limit: 200 };

export function TaskListContent({ projectId, scope }: { projectId?: string; scope?: TaskListScope } = {}) {
  const modeWords = useModeWords();
  const hostedMode = useHostedMode();
  // An add row's writes name their workspace, as the create form's do.
  const workspaceArgs = useWorkspaceArgs();
  const router = useRouter();
  const params = useParams();
  const { status: urlStatus, view: viewMode, group, sort, dir, priority: priorityFilter, label: labelFilter, assignee: assigneeFilter, statuses: statusesFilter, sourceFilter, session: sessionFilter, completed: completedFilter, effectivePrefs, setParam, setTaskView, setGroup, primaryAxis, secondaryAxis, setPrimaryAxis, setSecondaryAxis, setSort, toggleSortDir, buildShareUrl } = useTaskUrlState(hostedMode, !!scope || !!projectId);
  const completionClock = useCoarseNow(60_000);
  const pendingCompletions = useInboxStore((s) => completedFilter ? pendingTaskCompletionsSig(s.pending) : "");
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
  // Blockers and parents resolve against every task the store holds (a
  // blocker may live in another project) and each row's snapshot. The page
  // wakes on the signature of those answers, not on every task write.
  const blockerSig = useInboxStore(useCallback((s) => readySig(wsTasks, s.tasks), [wsTasks]));
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

  // The initiative a task serves, read through its project
  // (initiatives-projects-role-page.md I1).
  const initiatives = useInitiatives();
  const initiativeOfProject = useMemo(() => projectInitiativeIndex(initiatives), [initiatives]);
  // Grouping by project is meaningless inside one project — every row shares
  // it, and so its initiative. A workspace with no initiatives offers no axis.
  const axisKeys = useMemo(
    () => TASK_AXIS_KEYS.filter((k) => !(projectId && (k === "project" || k === "initiative")) && !(k === "initiative" && initiatives.length === 0)),
    [projectId, initiatives.length]
  );
  // The view is shareable from wherever it is rendered; only the path differs,
  // since the filters/sort/grouping travel in the query string either way.
  const shareUrl = useCallback(() => {
    const url = buildShareUrl();
    return projectId ? url.replace("/tasks", `/projects/${projectId}`) : url;
  }, [buildShareUrl, projectId]);

  // One status selection, two controls over it (the preset pills and the Status
  // filter). `status` holds it: "" is the default (active work), "all" is
  // everything, otherwise a comma list of statuses — the team's own status ids,
  // which on a default team are the category names. Older links and saved views
  // carried a separate multi `statuses` filter, and named categories; both are
  // read as the same thing and rewritten the moment either control writes.
  const statusFilter = urlStatus || statusesFilter || (completedFilter ? "done" : "");
  const setViewMode = useCallback((v: "list" | "kanban") => setParam({ view: v === "list" ? "" : v }), [setParam]);
  // The prefs a view should store: what is on screen now, minus bookkeeping.
  const livePrefs = useMemo(
    () => ({ ...effectivePrefs, status: statusFilter, statuses: "" }) as TaskViewPrefs,
    [effectivePrefs, statusFilter]
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
  // The line chip on each row reads the workspace's runs from the store
  // (the-line.md L10); this is the one feeder behind it, mounted per list.
  useSyncRuns(RUNS_FEED_ARGS);
  const currentUser = useViewerIdentity();
  const viewerId = currentUser?._id ? String(currentUser._id) : null;
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
  const setStatusFilter = useCallback((s: string) => {
    // The "completed in the last N days" window only means anything while
    // finished work is on screen, so a selection that drops it drops the window
    // too. A team's done status may be named anything, so ask the category.
    const keys = new Set(s.split(","));
    const keepsDone = s === "all" || keys.has("done")
      || taskStatuses.some((st) => st.category === "done" && keys.has(st.id));
    setTaskFilter({ status: s });
    setParam({ status: s, statuses: "", ...(keepsDone ? {} : { completed: "" }) });
  }, [setTaskFilter, setParam, taskStatuses]);
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
  // Roles own tasks like people do (org-roles-run-work.md R5). The board only
  // names roles and reads who reports to whom, so it takes the wake signature
  // reader, never the whole tree (a message under any node would repaint it),
  // and mounts the feeder because nothing guarantees the org page came first.
  useSyncOrgTreeFeeder();
  const { roles: orgRoles } = useOrgRoles();
  // The assignee filter lists people, then roles, each under its own heading
  // and drawn with its face (hooks/useRolesAndPeopleOptions, the list an
  // initiative's owner picker shares). People come first so the list a person
  // already knows keeps its order. "My reporting chain" is the filter form of
  // the Chain grouping: my tasks and those of every role that answers to me.
  const { people, roles: roleOptions } = useRolesAndPeopleOptions(teamMembers);
  const assigneeOptions = useMemo(() => [
    { key: "", label: "Anyone" },
    { key: "_unassigned", label: "Unassigned" },
    ...(roleOptions.length ? [{ key: "_chain", label: "My reporting chain" }] : []),
    ...people,
    ...roleOptions,
  ], [people, roleOptions]);
  const myChain = useMemo(
    () => (assigneeFilter === "_chain" && currentUser ? new Set(chainAssignees(currentUser._id, orgRoles)) : null),
    [assigneeFilter, currentUser, orgRoles]
  );
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
      : scope
        ? inWorkspace.filter((t) => scope.projectIds.includes(String((t as any).project_id || "")) || scope.planIds.includes(String((t as any).plan_id || "")))
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
  }, [wsTasks, taskOriginBadges, projectId, scope]);

  // The Assistant scope (lib/assistantScope): the person's own errands and
  // what the assistant added for them, not the to-dos coding work files. A
  // project or role surface is already narrowed and ignores it.
  const { only: assistantOnly } = useAssistantScope();
  const scopeApplies = assistantOnly && !projectId && !scope;
  const scopedTasksList = useMemo(
    () => (scopeApplies ? tasksList.filter(isAssistantTask) : tasksList),
    [scopeApplies, tasksList],
  );
  // What Everything adds to the board: human-board to-dos the scope leaves out.
  const outOfScope = useMemo(
    () => (scopeApplies ? tasksList.filter((t) => isActiveTask(t) && isOnHumanBoard(t) && !isAssistantTask(t)).length : 0),
    [scopeApplies, tasksList],
  );

  const allLabels = useMemo(() => {
    const set = new Set<string>(DEFAULT_LABELS);
    for (const t of scopedTasksList) t.labels?.forEach((l: string) => set.add(l));
    return [...set].sort();
  }, [scopedTasksList]);

  // Source filtering applied before other filters (tasksForSource).
  const sourceFilteredTasks = useMemo(() => tasksForSource(scopedTasksList, sourceFilter), [scopedTasksList, sourceFilter]);

  const completionTick = completedFilter ? completionClock : 0;
  const completionFilteredTasks = useMemo(
    () => filterTasksByCompletion(sourceFilteredTasks, completedFilter, Date.now(), useInboxStore.getState().pending),
    [sourceFilteredTasks, completedFilter, completionTick, pendingCompletions],
  );

  // Only the Unblocked view filters on what blockers say.
  const unblockedViewSig = statusFilter === UNBLOCKED_VIEW ? blockerSig : null;
  const baseFilteredTasks = useMemo(() => {
    let list = completionFilteredTasks;

    // Status filtering. An explicit selection (one status or several) is a
    // plain membership test; "all" imposes nothing; the default hides the
    // terminal states. Unblocked is the CLI's ready (task-graph.md TG1): open
    // work nothing holds back.
    if (statusFilter === UNBLOCKED_VIEW) {
      const storeTasks = useInboxStore.getState().tasks;
      list = list.filter((t) => isReadyInStore(t, storeTasks, viewerId));
    } else if (statusFilter && statusFilter !== "all") {
      const set = new Set(statusFilter.split(","));
      // A selection names STATUSES, which on a team with custom ones are finer
      // than categories ("Today" and "In Progress" both sit in in_progress), so
      // membership tests the resolved status. A category name survives as a key
      // only where the team has no status of that id — an older link or saved
      // view, which still means "everything in this category".
      const legacyCats = new Set(
        [...set].filter((k) => (STATUS_ORDER as string[]).includes(k) && !taskStatuses.some((st) => st.id === k)),
      );
      list = list.filter((t) => set.has(kanbanKeyFor(t)) || legacyCats.has(t.status));
    } else if (statusFilter !== "all" && viewMode !== "kanban" && sourceFilter !== "triage" && sourceFilter !== "dismissed") {
      // Default "Active" tab (no explicit status selected): live work only, so
      // the list matches the tab's label AND its badge count (taskCounts.active,
      // which drops the same three). The kanban board is a full-pipeline view
      // that legitimately renders Backlog and Done columns, so it keeps every
      // status; likewise the triage/dismissed source views.
      list = list.filter((t) => (ACTIVE as string[]).includes(t.status));
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
    else if (assigneeFilter === "_chain") list = list.filter((t) => !!t.assignee && !!myChain?.has(t.assignee));
    else if (assigneeFilter) list = list.filter((t) => t.assignee === assigneeFilter);
    return list;
  }, [completionFilteredTasks, priorityFilter, labelFilter, assigneeFilter, myChain, statusFilter, sourceFilter, viewMode, taskStatuses, kanbanKeyFor, unblockedViewSig, viewerId]);

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
      const info = resolveAssigneeInfo(t.assignee, t.assignee_info, teamMembers as any[], currentUser, orgRoles);
      return sameAssigneeInfo(info, t.assignee_info) ? t : ({ ...t, assignee_info: info } as TaskItem);
    });
  }, [baseFilteredTasks, sessionFilter, taskHasSession, teamMembers, currentUser, orgRoles]);

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
    () => ({ projects, onFilterLabel: (label: string) => setParam({ label }), taskStatuses, roles: orgRoles, teamMembers, currentUser, initiativeOfProject, plainHeaders: hostedMode }),
    [projects, setParam, taskStatuses, orgRoles, teamMembers, currentUser, initiativeOfProject, hostedMode]
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

  // Counts for both vocabularies at once: by category (what the presets mean)
  // and by resolved status (what the Status filter offers, custom ones included).
  const taskCounts = useMemo(() => {
    const counts: Record<string, number> = { active: 0, all: 0, [UNBLOCKED_VIEW]: 0 };
    const storeTasks = useInboxStore.getState().tasks;
    for (const t of completionFilteredTasks) {
      counts[t.status] = (counts[t.status] || 0) + 1;
      const key = kanbanKeyFor(t);
      if (key !== t.status) counts[key] = (counts[key] || 0) + 1;
      counts.all++;
      if ((ACTIVE as string[]).includes(t.status)) counts.active++;
      if (isReadyInStore(t, storeTasks, viewerId)) counts[UNBLOCKED_VIEW]++;
    }
    return counts;
  }, [completionFilteredTasks, kanbanKeyFor, blockerSig, viewerId]);
  // One status vocabulary, two controls over it. The pills carry the three
  // answers people want without thinking — the live work, everything, the
  // finished work — and every finer selection (one status, a handful, a team's
  // custom ones) is the Status filter beside Priority and Assignee. Both write
  // the same `status` value, so whichever you use the other tells the truth.
  // Dropped is the one status worth hiding while it is empty — it is a category
  // most teams never use. It comes back the moment a row carries it, or while
  // the current selection names it, so no selection can point at a status the
  // list does not offer.
  const statusOptionList = useMemo(() => {
    const picked = new Set(statusFilter.split(","));
    return boardStatuses.filter(
      (st) => st.category !== "dropped" || (taskCounts[st.id] || 0) > 0 || picked.has(st.id),
    );
  }, [boardStatuses, taskCounts, statusFilter]);
  // A selection is written in board order so the same set is always the same
  // string — that is what lets the presets below be compared by value.
  const canonicalStatuses = useCallback(
    (keys: Iterable<string>) => {
      const want = new Set(keys);
      return statusOptionList.filter((st) => want.has(st.id)).map((st) => st.id).join(",");
    },
    [statusOptionList],
  );
  const activeValue = useMemo(
    () => canonicalStatuses(statusOptionList.filter((st) => ACTIVE.includes(st.category as TaskStatus)).map((st) => st.id)),
    [canonicalStatuses, statusOptionList],
  );
  const doneValue = useMemo(
    () => canonicalStatuses(statusOptionList.filter((st) => st.category === "done").map((st) => st.id)),
    [canonicalStatuses, statusOptionList],
  );
  // What the popover shows ticked. "all" means no constraint, so nothing is
  // ticked and its "Any status" row is the selected one.
  const statusFilterValue = useMemo(() => {
    if (statusFilter === "all") return "";
    if (!statusFilter) return activeValue;
    // Unblocked is a pill of its own, not a set of statuses: nothing is ticked.
    if (statusFilter === UNBLOCKED_VIEW) return UNBLOCKED_VIEW;
    return canonicalStatuses(statusFilter.split(","));
  }, [statusFilter, activeValue, canonicalStatuses]);
  // Ticking statuses in the popover folds back into the shortest value that
  // means the same thing, so picking exactly the open statuses lands you back
  // on the "Active" pill rather than on an identical-looking custom set.
  const setStatusSelection = useCallback((v: string) => {
    const picked = canonicalStatuses(v.split(",").filter(Boolean));
    if (!picked) setStatusFilter("all");
    else if (picked === canonicalStatuses(statusOptionList.map((st) => st.id))) setStatusFilter("all");
    else if (picked === activeValue) setStatusFilter("");
    else setStatusFilter(picked);
  }, [canonicalStatuses, statusOptionList, activeValue, setStatusFilter]);

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

  // One drop is one undo; terminal statuses route through the single close
  // gateway, same as kanban (applyTaskDrop).
  const applyDropUpdates = useCallback((task: TaskItem, updates: Record<string, any>) => {
    if (applyTaskDrop(task.short_id, updates).needsConfirm) return;
    // A pure reorder is its own feedback (the row lands where dropped).
    const fields = Object.keys(updates).filter((k) => k !== "sort_order");
    if (fields.length > 0) toast.success(`${task.short_id} moved`);
  }, []);

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
        onFilterLabel={groupCtx.onFilterLabel}
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
  }, [isBotView, handleTriage, viewNesting, familyIndex, tasksById, collapsedIds, toggleCollapsed, groupCtx.onFilterLabel]);

  return (
    <>
    <GenericListView<TaskItem>
          banner={
            <FeatureUpsell
              slug="tasks"
              className="mx-4 mt-3"
              reason="Let agents file and update their own tasks, so work they take on shows up on this board with its progress."
            />
          }
          activeItemId={(projectId ? params?.taskId : params?.id) as string | undefined}
          paletteTargetType="task"
          getComposeRef={(t) => t.short_id}
          title={projectId ? "Project tasks" : scope ? "Tasks in scope" : modeWords.tasksPage}
          tabs={[
            // The answers worth a click: the live work, what can start now,
            // everything, the finished work. Anything finer is the Status filter in the bar
            // below — the pills would otherwise grow a segment per custom
            // status until the header could not hold them.
            { key: "", label: "Active", count: taskCounts.active, icon: Activity,
              title: "Live work: " + statusOptionList.filter((st) => ACTIVE.includes(st.category as TaskStatus)).map((st) => st.name).join(", ") },
            // A hosted to-do list has no dependency graph to read.
            ...(hostedMode ? [] : [{ key: UNBLOCKED_VIEW, label: "Unblocked", count: taskCounts[UNBLOCKED_VIEW], icon: CirclePlay,
              title: "Open work nothing holds back: every blocking task closed, every wait met" }]),
            { key: "all", label: "All", count: taskCounts.all, icon: Layers, title: "Every status, Backlog and Done and Dropped included" },
            { key: doneValue || "done", label: "Done", count: taskCounts.done || 0, icon: STATUS_CONFIG.done.icon,
              title: "Finished work" },
          ]}
          activeTab={statusFilter}
          onTabChange={setStatusFilter}
          groupBy={primaryAxis}
          groupOptions={[
            { value: "none", label: "No grouping" },
            ...axisKeys.map((k) => ({ value: k, label: TASK_AXES[k].label })),
          ]}
          onGroupChange={setPrimaryAxis}
          subGroupBy={secondaryAxis}
          subGroupOptions={[
            { value: "none", label: "Nothing" },
            ...axisKeys.filter((k) => canSubGroup(primaryAxis, k)).map((k) => ({ value: k, label: TASK_AXES[k].label })),
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
            hasActive: !!(priorityFilter || labelFilter || assigneeFilter || sourceFilter || sessionFilter || completedFilter || (statusFilter && statusFilter !== "all")),
            defs: [
              {
                key: "status", label: "Status", icon: <Circle className="w-3 h-3" />, value: statusFilterValue, multi: true,
                // The pills already say Active / Unblocked / All / Done, so
                // those values draw no chip — the chip appears exactly when the
                // selection is something the pill row cannot show.
                presetValues: ["", activeValue, doneValue, UNBLOCKED_VIEW],
                options: [
                  { key: "", label: "Any status" },
                  ...statusOptionList.map((st) => {
                    const v = statusVisual(st, taskStatuses);
                    return { key: st.id, label: v.label, icon: v.icon, color: v.color, count: taskCounts[st.id] || 0 };
                  }),
                ],
                onChange: setStatusSelection,
              },
              {
                key: "completed", label: "Completed", icon: <CalendarDays className="w-3 h-3" />, value: completedFilter,
                options: [{ key: "", label: "Any time" }, ...COMPLETION_WINDOWS],
                onChange: (v: string) => setParam(v ? { completed: v, status: "done", statuses: "" } : { completed: "" }),
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
                key: "label", label: "Label", icon: <Tag className="w-3 h-3" />, value: labelFilter, multi: true,
                options: [{ key: "", label: "Any" }, ...allLabels.map((l) => ({ key: l, label: l }))],
                onChange: (v: string) => setParam({ label: v }),
              },
              {
                key: "assignee", label: "Assignee", icon: <User className="w-3 h-3" />, value: assigneeFilter,
                options: assigneeOptions,
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
            onClear: () => setParam({ status: "", statuses: "", priority: "", label: "", assignee: "", source: "", session: "", completed: "" }),
            onSaveView: handleSaveView,
            dirtyView,
          }}
          shareUrl={shareUrl}
          groups={displayGroups}
          flatItems={displayFlat}
          disableKeyboard={showCreate}
          renderRow={renderTaskRow}
          renderPreview={(t, onClose, onOpen) => (
            <ErrorBoundary name="TaskPeek" level="panel">
              <TaskDetailContent taskId={t._id} variant="inline" onClose={onClose} onOpen={onOpen} />
            </ErrorBoundary>
          )}
          getItemId={(t) => t._id}
          getItemRoute={(t) => (projectId ? `/projects/${projectId}/${t._id}` : `/tasks/${t._id}`)}
          getSearchText={(t) => `${t.short_id} ${t.title}`}
          emptyIcon={statusFilter === UNBLOCKED_VIEW ? <CirclePlay className="w-8 h-8 opacity-30" /> : <Circle className="w-8 h-8 opacity-30" />}
          emptyMessage={
            hostedMode ? "No to-dos yet"
            // An empty Unblocked view is an answer, not a broken filter, unless
            // a narrower filter emptied it. Readiness turns tasks away for more
            // than blockers (superseded, a parent being worked), so the words
            // name what holds them without claiming every one waits.
            : statusFilter === UNBLOCKED_VIEW && !(priorityFilter || labelFilter || assigneeFilter || sessionFilter) ? (
              taskCounts.open ? (
                <>
                  Nothing can start right now
                  <span className="block mt-1 text-xs text-sol-text-dim">Open tasks here are waiting on another task, a PR, a decision, a time or their parent</span>
                </>
              ) : "No open tasks"
            )
            : "No tasks found"
          }
          onCreate={() => openCreateModal('task', projectId ? { project_id: projectId } : undefined)}
          // Hosted mode adds a to-do the way one writes a list: type, Enter.
          quickAdd={hostedMode ? { placeholder: "New to-do", onAdd: (title) => void createTaskAndAdopt({ title, task_type: "task", status: "open", ...(workspaceArgs === "skip" ? {} : workspaceArgs), ...(projectId ? { project_id: projectId } : {}) }) } : undefined}
          hasMore={hasMore}
          onLoadMore={loadMore}
          // Hosted to-dos check off with x, the list's one verb there (hosted
          // rows have no selection), with the gesture's Undo toast.
          onToggleItem={hostedMode ? toggleTodoDone : undefined}
          paletteShortcuts={[
            { key: "s", mode: "status", label: "status" },
            { key: "p", mode: "priority", label: "priority" },
            { key: "l", mode: "labels", label: "labels" },
            { key: "a", mode: "assign", label: "assign" },
          ]}
          paletteProps={{ teamMembers, currentUser: currentUser ?? undefined }}
          onItemEdit={handleTitleEdit}
          headerExtra={!projectId && !scope ? <AssistantScopeSwitch label="Which to-dos this lists" hidden={outOfScope} /> : undefined}
          listFooter={scopeApplies && outOfScope > 0 ? <div className="px-4 pb-3"><MoreInEverything hidden={outOfScope} /></div> : undefined}
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
              onFilterLabel={groupCtx.onFilterLabel}
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
