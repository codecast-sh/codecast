"use client";

import { useState, useCallback, useEffect, useRef, useMemo, Fragment } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, TaskItem } from "../../store/inboxStore";
import { useSyncTasks, useSyncTaskDetail } from "../../hooks/useSyncTasks";
import { useWorkspaceArgs } from "../../hooks/useWorkspaceArgs";
import { TaskCommandPalette } from "../../components/TaskCommandPalette";

const api = _api as any;
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { Badge } from "../../components/ui/badge";
import { toast } from "sonner";
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
  Command,
  Check,
  X,
} from "lucide-react";

type TaskStatus = "draft" | "open" | "in_progress" | "in_review" | "done" | "dropped";
type TaskPriority = "urgent" | "high" | "medium" | "low" | "none";

const STATUS_CONFIG: Record<TaskStatus, { icon: typeof Circle; label: string; color: string }> = {
  draft: { icon: CircleDotDashed, label: "Draft", color: "text-sol-text-dim" },
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

const STATUS_ORDER: TaskStatus[] = ["in_progress", "open", "draft", "in_review", "done", "dropped"];

function CreatorAvatar({ creator }: { creator?: { name: string; image?: string } }) {
  if (!creator) return null;
  if (creator.image) {
    return <img src={creator.image} alt={creator.name} title={creator.name} className="w-5 h-5 rounded-full flex-shrink-0" />;
  }
  const initials = creator.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className="w-5 h-5 rounded-full flex-shrink-0 bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-[8px] font-medium text-sol-text-muted" title={creator.name}>
      {initials}
    </div>
  );
}

function TaskRow({
  task,
  isFocused,
  isSelected,
  isEditing,
  onSelect,
  onClick,
  onStatusClick,
  onPriorityClick,
  onContextMenu,
  onTitleEdit,
  onEditDone,
}: {
  task: TaskItem;
  isFocused: boolean;
  isSelected: boolean;
  isEditing: boolean;
  onSelect: () => void;
  onClick: () => void;
  onStatusClick: () => void;
  onPriorityClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onTitleEdit: (title: string) => void;
  onEditDone: () => void;
}) {
  const status = STATUS_CONFIG[task.status as TaskStatus] || STATUS_CONFIG.open;
  const priority = PRIORITY_CONFIG[task.priority as TaskPriority] || PRIORITY_CONFIG.medium;
  const StatusIcon = status.icon;
  const PriorityIcon = priority.icon;
  const rowRef = useRef<HTMLDivElement>(null);
  const [editValue, setEditValue] = useState(task.title);

  useEffect(() => {
    if (isFocused && rowRef.current) {
      rowRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [isFocused]);

  useEffect(() => { setEditValue(task.title); }, [task.title]);

  const commitEdit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== task.title) onTitleEdit(trimmed);
    onEditDone();
  }, [editValue, task.title, onTitleEdit, onEditDone]);

  const age = Date.now() - task.updated_at;
  const ageStr = age < 3600000
    ? `${Math.round(age / 60000)}m`
    : age < 86400000
      ? `${Math.round(age / 3600000)}h`
      : `${Math.round(age / 86400000)}d`;

  return (
    <div
      ref={rowRef}
      data-task-id={task._id}
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`w-full flex items-center gap-3 px-4 py-2.5 transition-colors text-left group border-b border-sol-border/30 cursor-pointer select-none ${
        isFocused
          ? "bg-sol-cyan/8 border-l-[3px] border-l-sol-cyan"
          : "hover:bg-sol-bg-alt/50 border-l-[3px] border-l-transparent"
      } ${isSelected ? "bg-sol-cyan/5" : ""}`}
    >
      <button
        onClick={(e) => { e.stopPropagation(); onSelect(); }}
        className={`w-4 h-4 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${
          isSelected
            ? "bg-sol-cyan border-sol-cyan"
            : isFocused
              ? "border-sol-text-dim/40"
              : "border-sol-border/60 opacity-0 group-hover:opacity-100"
        }`}
      >
        {isSelected && <Check className="w-3 h-3 text-sol-bg" />}
      </button>

      <button
        onClick={(e) => { e.stopPropagation(); onStatusClick(); }}
        className="flex-shrink-0 hover:scale-125 transition-transform"
        title="Change status (s)"
      >
        <StatusIcon className={`w-4 h-4 ${status.color}`} />
      </button>
      <span className="text-xs font-mono text-sol-text-dim w-16 flex-shrink-0">{task.short_id}</span>
      {isEditing ? (
        <input
          autoFocus
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") { setEditValue(task.title); onEditDone(); }
            e.stopPropagation();
          }}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 text-sm text-sol-text bg-transparent border-b border-sol-cyan outline-none py-0"
        />
      ) : (
        <span className="flex-1 text-sm text-sol-text truncate">{task.title}</span>
      )}
      {(task as any).activeSession && (
        <Link
          href={`/conversation/${(task as any).activeSession.session_id}`}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 text-[10px] cursor-pointer hover:bg-emerald-500/25 transition-colors flex-shrink-0"
          title={(task as any).activeSession.title || "Active session"}
        >
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
          live
        </Link>
      )}
      {(task as any).plan && (
        <Link
          href={`/plans/${(task as any).plan._id}`}
          onClick={(e) => e.stopPropagation()}
          className="text-[10px] px-1.5 py-0 rounded bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/20 flex-shrink-0 hover:bg-sol-cyan/20 transition-colors"
          title={`Plan: ${(task as any).plan.title}`}
        >
          {(task as any).plan.short_id}
        </Link>
      )}
      {task.source === "insight" && (
        <span className="text-[10px] px-1.5 py-0 rounded bg-sol-violet/10 text-sol-violet border border-sol-violet/20 flex-shrink-0">mined</span>
      )}
      {task.blocked_by && task.blocked_by.length > 0 && (
        <Link2 className="w-3.5 h-3.5 text-sol-red flex-shrink-0" />
      )}
      {task.labels?.map((l: string) => (
        <Badge key={l} variant="outline" className="text-[10px] px-1.5 py-0 border-sol-border/50 text-sol-text-dim">
          {l}
        </Badge>
      ))}
      {task.assignee_info && (
        <div className="flex items-center gap-1 flex-shrink-0" title={`Assigned: ${task.assignee_info.name}`}>
          {task.assignee_info.image ? (
            <img src={task.assignee_info.image} alt={task.assignee_info.name} className="w-5 h-5 rounded-full ring-1 ring-sol-cyan/30" />
          ) : (
            <div className="w-5 h-5 rounded-full bg-sol-cyan/10 border border-sol-cyan/30 flex items-center justify-center text-[8px] font-medium text-sol-cyan">
              {task.assignee_info.name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase()}
            </div>
          )}
        </div>
      )}
      {!task.assignee_info && <CreatorAvatar creator={task.creator} />}
      <button
        onClick={(e) => { e.stopPropagation(); onPriorityClick(); }}
        className="flex-shrink-0 hover:scale-125 transition-transform"
        title="Set priority (p)"
      >
        <PriorityIcon className={`w-3.5 h-3.5 ${priority.color}`} />
      </button>
      <span className="text-xs text-sol-text-dim w-8 text-right tabular-nums">{ageStr}</span>
    </div>
  );
}

function CreateTaskModal({ onClose }: { onClose: () => void }) {
  const createTask = useInboxStore((s) => s.createTask);
  const webCreate = useMutation(api.tasks.webCreate);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [taskType, setTaskType] = useState("task");
  const [priority, setPriority] = useState("medium");

  const handleSubmit = useCallback(async () => {
    if (!title.trim()) return;
    const opts = {
      title: title.trim(),
      description: description.trim() || undefined,
      task_type: taskType,
      priority,
      status: "open",
    };
    createTask(opts);
    toast.success(`Created: ${title.trim()}`);
    try {
      await webCreate(opts);
    } catch {}
    onClose();
  }, [title, description, taskType, priority, createTask, webCreate, onClose]);

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center pt-[15vh]" onClick={onClose}>
      <div className="bg-sol-bg border border-sol-border rounded-xl shadow-2xl w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <div className="p-6">
          <h2 className="text-lg font-semibold text-sol-text mb-4">New Task</h2>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
            autoFocus
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
            className="w-full text-sm px-3 py-2 rounded-lg bg-sol-bg-alt border border-sol-border/50 text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan mb-3"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description (optional)"
            rows={3}
            className="w-full text-sm px-3 py-2 rounded-lg bg-sol-bg-alt border border-sol-border/50 text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan mb-3 resize-none"
          />
          <div className="flex gap-3 mb-4">
            <select
              value={taskType}
              onChange={(e) => setTaskType(e.target.value)}
              className="text-sm px-3 py-2 rounded-lg bg-sol-bg-alt border border-sol-border/50 text-sol-text focus:outline-none focus:border-sol-cyan"
            >
              <option value="task">Task</option>
              <option value="feature">Feature</option>
              <option value="bug">Bug</option>
              <option value="chore">Chore</option>
            </select>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className="text-sm px-3 py-2 rounded-lg bg-sol-bg-alt border border-sol-border/50 text-sol-text focus:outline-none focus:border-sol-cyan"
            >
              <option value="urgent">Urgent</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-sol-text-muted hover:text-sol-text transition-colors">
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!title.trim()}
              className="px-4 py-2 text-sm rounded-lg bg-sol-cyan text-sol-bg hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              Create
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TaskPreviewPanel({ taskId, onClose, onOpen }: { taskId: string; onClose: () => void; onOpen: () => void }) {
  useSyncTaskDetail(taskId);
  const detail = useInboxStore((s) => s.taskDetails[taskId]);
  const listItem = useInboxStore((s) => s.tasks[taskId]);
  const data = detail || listItem;

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
            {data.labels.map((l: string) => (
              <Badge key={l} variant="outline" className="text-[10px] px-1.5 py-0 border-sol-border/50 text-sol-text-dim">{l}</Badge>
            ))}
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
        {(detail as any)?.comments && (detail as any).comments.length > 0 && (
          <div className="border-t border-sol-border/20 pt-3">
            <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide mb-2">
              Comments ({(detail as any).comments.length})
            </div>
            <div className="space-y-2">
              {(detail as any).comments.slice(0, 5).map((c: any) => (
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

export default function TasksPage() {
  const router = useRouter();
  const statusFilter = useInboxStore((s) => s.taskFilter.status);
  const setTaskFilter = useInboxStore((s) => s.setTaskFilter);
  const tasks = useInboxStore((s) => s.tasks);
  const [showCreate, setShowCreate] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdMode, setCmdMode] = useState<"root" | "status" | "priority" | "labels" | "assign">("root");
  const [showHelp, setShowHelp] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [previewTaskId, setPreviewTaskId] = useState<string | null>(null);

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<"status" | "priority" | "created" | "updated">("status");

  useSyncTasks(statusFilter || undefined);
  const workspaceArgs = useWorkspaceArgs();
  const projects = useQuery(api.projects.webList,
    workspaceArgs === "skip" ? "skip" : { ...workspaceArgs }
  );

  const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };

  const tasksList = useMemo(() => Object.values(tasks), [tasks]);

  const flatTasks = useMemo(() => {
    if (sortBy !== "status") {
      const sorted = [...tasksList];
      if (sortBy === "priority") sorted.sort((a, b) => (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3));
      else if (sortBy === "created") sorted.sort((a, b) => b.created_at - a.created_at);
      else if (sortBy === "updated") sorted.sort((a, b) => b.updated_at - a.updated_at);
      return sorted;
    }
    if (statusFilter) return tasksList;
    const grouped = tasksList.reduce((acc: Record<string, TaskItem[]>, t) => {
      const s = t.status as string;
      if (!acc[s]) acc[s] = [];
      acc[s].push(t);
      return acc;
    }, {});
    return STATUS_ORDER.flatMap((s) =>
      collapsedGroups.has(s) ? [] : (grouped[s] || [])
    );
  }, [tasksList, statusFilter, collapsedGroups, sortBy]);

  const focusedTask = flatTasks[focusIndex] || null;

  const getTargetTasks = useCallback((): TaskItem[] => {
    if (selectedIds.size > 0) {
      return flatTasks.filter((t) => selectedIds.has(t._id));
    }
    return focusedTask ? [focusedTask] : [];
  }, [selectedIds, flatTasks, focusedTask]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const [cmdTargetOverride, setCmdTargetOverride] = useState<TaskItem[] | null>(null);

  const webUpdate = useMutation(api.tasks.webUpdate);
  const updateTask = useInboxStore((s) => s.updateTask);

  const toggleGroup = useCallback((status: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      return next;
    });
  }, []);

  const handleTitleEdit = useCallback(
    async (task: TaskItem, title: string) => {
      updateTask(task.short_id, { title });
      try { await webUpdate({ short_id: task.short_id, title }); } catch {}
    },
    [updateTask, webUpdate]
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, task: TaskItem) => {
      e.preventDefault();
      setCmdTargetOverride([task]);
      setCmdMode("root");
      setCmdOpen(true);
    },
    []
  );

  const openCmdPalette = useCallback(
    (mode: "root" | "status" | "priority" | "labels" | "assign" = "root") => {
      setCmdTargetOverride(null);
      setCmdMode(mode);
      setCmdOpen(true);
    },
    []
  );

  const openCmdForTask = useCallback(
    (task: TaskItem, mode: "root" | "status" | "priority" | "labels" | "assign") => {
      setCmdTargetOverride([task]);
      setCmdMode(mode);
      setCmdOpen(true);
    },
    []
  );

  // Keyboard shortcuts
  useEffect(() => {
    if (showCreate || cmdOpen || editingTaskId) return;
    if (showHelp) {
      const helpHandler = (e: KeyboardEvent) => {
        if (e.key === "?" || e.key === "Escape") {
          e.preventDefault();
          e.stopImmediatePropagation();
          setShowHelp(false);
        }
      };
      window.addEventListener("keydown", helpHandler, true);
      return () => window.removeEventListener("keydown", helpHandler, true);
    }

    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

      // Cmd+K: command palette (stopImmediatePropagation to override global palette)
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        openCmdPalette("root");
        return;
      }

      const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };

      // j/k: navigate
      if (e.key === "j" && !e.metaKey && !e.ctrlKey) {
        stop();
        setFocusIndex((i) => Math.min(i + 1, flatTasks.length - 1));
        return;
      }
      if (e.key === "k" && !e.metaKey && !e.ctrlKey) {
        stop();
        setFocusIndex((i) => Math.max(i - 1, 0));
        return;
      }

      // x: toggle selection on focused task
      if (e.key === "x" && !e.metaKey && !e.ctrlKey) {
        stop();
        if (focusedTask) toggleSelect(focusedTask._id);
        return;
      }

      // Enter: open task detail
      if (e.key === "Enter") {
        stop();
        if (focusedTask) router.push(`/tasks/${focusedTask._id}`);
        return;
      }

      // Escape: close preview, then clear selection
      if (e.key === "Escape") {
        if (previewTaskId) {
          stop();
          setPreviewTaskId(null);
          return;
        }
        if (selectedIds.size > 0) {
          stop();
          setSelectedIds(new Set());
          return;
        }
      }

      // s: change status
      if (e.key === "s" && !e.metaKey && !e.ctrlKey) {
        stop();
        openCmdPalette("status");
        return;
      }

      // p: set priority
      if (e.key === "p" && !e.metaKey && !e.ctrlKey) {
        stop();
        openCmdPalette("priority");
        return;
      }

      // l: labels
      if (e.key === "l" && !e.metaKey && !e.ctrlKey) {
        stop();
        openCmdPalette("labels");
        return;
      }

      // c: create task
      if (e.key === "c" && !e.metaKey && !e.ctrlKey) {
        stop();
        setShowCreate(true);
        return;
      }

      // e: edit title inline
      if (e.key === "e" && !e.metaKey && !e.ctrlKey) {
        stop();
        if (focusedTask) setEditingTaskId(focusedTask._id);
        return;
      }

      // d: drop/delete task
      if (e.key === "d" && !e.metaKey && !e.ctrlKey) {
        stop();
        openCmdPalette("root");
        return;
      }

      // Cmd+A: select all
      if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
        stop();
        setSelectedIds(new Set(flatTasks.map((t) => t._id)));
        return;
      }

      // Space: toggle preview panel (like Linear peek)
      if (e.key === " " && !e.metaKey && !e.ctrlKey) {
        stop();
        if (focusedTask) {
          setPreviewTaskId((prev) => prev === focusedTask._id ? null : focusedTask._id);
        }
        return;
      }

      // Home/End
      if (e.key === "Home") {
        stop();
        setFocusIndex(0);
        return;
      }
      if (e.key === "End") {
        stop();
        setFocusIndex(Math.max(0, flatTasks.length - 1));
        return;
      }

      // ?: show keyboard shortcuts help
      if (e.key === "?" && !e.metaKey && !e.ctrlKey) {
        stop();
        setShowHelp((h) => !h);
        return;
      }

      // Filter shortcuts: 1=Active, 2=Draft, 3=Open, 4=In Progress, 5=Done
      const filterKeys: Record<string, string> = { "1": "", "2": "draft", "3": "open", "4": "in_progress", "5": "done" };
      if (filterKeys[e.key] !== undefined && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
        stop();
        setTaskFilter({ status: filterKeys[e.key] });
        setFocusIndex(0);
        return;
      }
    };

    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [showCreate, showHelp, cmdOpen, editingTaskId, flatTasks, focusedTask, focusIndex, selectedIds, previewTaskId, openCmdPalette, toggleSelect, setTaskFilter, router]);

  // Keep focus in bounds when tasks change
  useEffect(() => {
    if (focusIndex >= flatTasks.length && flatTasks.length > 0) {
      setFocusIndex(flatTasks.length - 1);
    }
  }, [flatTasks.length, focusIndex]);

  // Update preview when focus moves (if preview is open)
  useEffect(() => {
    if (previewTaskId && focusedTask && previewTaskId !== focusedTask._id) {
      setPreviewTaskId(focusedTask._id);
    }
  }, [focusIndex]);

  const grouped = tasksList.reduce((acc: Record<string, TaskItem[]>, t) => {
    const s = t.status as string;
    if (!acc[s]) acc[s] = [];
    acc[s].push(t);
    return acc;
  }, {});

  const taskCounts = useMemo(() => {
    const counts: Record<string, number> = { active: 0 };
    for (const t of tasksList) {
      counts[t.status] = (counts[t.status] || 0) + 1;
      if (t.status !== "done" && t.status !== "dropped") counts.active++;
    }
    return counts;
  }, [tasksList]);

  // Track flat index across status groups for rendering
  let flatIndex = 0;

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="h-full flex flex-col">
          <div className="flex items-center justify-between px-6 py-4 border-b border-sol-border/30">
            <div className="flex items-center gap-4">
              <h1 className="text-lg font-semibold text-sol-text tracking-tight">Tasks</h1>
              <div className="flex gap-1">
                <button
                  onClick={() => setTaskFilter({ status: "" })}
                  className={`text-xs px-2.5 py-1 rounded-md transition-colors flex items-center gap-1.5 ${
                    !statusFilter ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"
                  }`}
                >
                  Active
                  {taskCounts.active > 0 && <span className="text-[10px] tabular-nums opacity-60">{taskCounts.active}</span>}
                </button>
                {(["draft", "open", "in_progress", "done"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setTaskFilter({ status: s })}
                    className={`text-xs px-2.5 py-1 rounded-md transition-colors flex items-center gap-1.5 ${
                      statusFilter === s ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"
                    }`}
                  >
                    {STATUS_CONFIG[s].label}
                    {(taskCounts[s] || 0) > 0 && <span className="text-[10px] tabular-nums opacity-60">{taskCounts[s]}</span>}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <select
                value={sortBy}
                onChange={(e) => { setSortBy(e.target.value as any); setFocusIndex(0); }}
                className="text-xs px-2 py-1 rounded-md bg-sol-bg-alt border border-sol-border/40 text-sol-text-dim focus:outline-none focus:border-sol-cyan cursor-pointer"
              >
                <option value="status">Group by status</option>
                <option value="priority">Sort by priority</option>
                <option value="updated">Sort by updated</option>
                <option value="created">Sort by created</option>
              </select>
              {selectedIds.size > 0 && (
                <span className="text-xs text-sol-cyan mr-2">{selectedIds.size} selected</span>
              )}
              <button
                onClick={() => openCmdPalette("root")}
                className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-sol-border/40 text-sol-text-dim hover:text-sol-text hover:border-sol-border transition-colors"
                title="Command palette (Cmd+K)"
              >
                <Command className="w-3 h-3" />K
              </button>
              <button
                onClick={() => setShowCreate(true)}
                className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-sol-cyan text-sol-bg hover:opacity-90 transition-opacity"
              >
                <Plus className="w-4 h-4" />
                New
              </button>
            </div>
          </div>

          <div className="flex-1 flex overflow-hidden">
          <div className="flex-1 overflow-y-auto">
            {tasksList.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-48 text-sol-text-dim">
                <Circle className="w-8 h-8 mb-2 opacity-30" />
                <p className="text-sm">No tasks found</p>
                <button
                  onClick={() => setShowCreate(true)}
                  className="mt-3 text-sm text-sol-cyan hover:underline"
                >
                  Create your first task
                </button>
              </div>
            ) : (statusFilter || sortBy !== "status") ? (
              <div>
                {flatTasks.map((t, i) => (
                  <TaskRow
                    key={t._id}
                    task={t}
                    isFocused={focusIndex === i}
                    isSelected={selectedIds.has(t._id)}
                    isEditing={editingTaskId === t._id}
                    onSelect={() => toggleSelect(t._id)}
                    onClick={() => router.push(`/tasks/${t._id}`)}
                    onStatusClick={() => openCmdForTask(t, "status")}
                    onPriorityClick={() => openCmdForTask(t, "priority")}
                    onContextMenu={(e) => handleContextMenu(e, t)}
                    onTitleEdit={(title) => handleTitleEdit(t, title)}
                    onEditDone={() => setEditingTaskId(null)}
                  />
                ))}
              </div>
            ) : (
              STATUS_ORDER.filter((s) => grouped[s]?.length).map((s) => {
                const group = grouped[s];
                const isCollapsed = collapsedGroups.has(s);
                const startIdx = flatIndex;
                flatIndex += isCollapsed ? 0 : group.length;
                return (
                  <div key={s}>
                    <button
                      onClick={() => toggleGroup(s)}
                      className="w-full flex items-center gap-2 px-4 py-2 bg-sol-bg-alt/30 border-b border-sol-border/20 hover:bg-sol-bg-alt/50 transition-colors text-left"
                    >
                      <svg className={`w-3 h-3 text-sol-text-dim transition-transform ${isCollapsed ? "" : "rotate-90"}`} fill="currentColor" viewBox="0 0 20 20">
                        <path d="M6 4l8 6-8 6V4z" />
                      </svg>
                      {(() => {
                        const cfg = STATUS_CONFIG[s];
                        const Icon = cfg.icon;
                        return <Icon className={`w-3.5 h-3.5 ${cfg.color}`} />;
                      })()}
                      <span className="text-xs font-medium text-sol-text-dim uppercase tracking-wide">
                        {STATUS_CONFIG[s].label}
                      </span>
                      <span className="text-xs text-sol-text-dim">({group.length})</span>
                    </button>
                    {!isCollapsed && group.map((t, gi) => (
                      <TaskRow
                        key={t._id}
                        task={t}
                        isFocused={focusIndex === startIdx + gi}
                        isSelected={selectedIds.has(t._id)}
                        isEditing={editingTaskId === t._id}
                        onSelect={() => toggleSelect(t._id)}
                        onClick={() => router.push(`/tasks/${t._id}`)}
                        onStatusClick={() => openCmdForTask(t, "status")}
                        onPriorityClick={() => openCmdForTask(t, "priority")}
                        onContextMenu={(e) => handleContextMenu(e, t)}
                        onTitleEdit={(title) => handleTitleEdit(t, title)}
                        onEditDone={() => setEditingTaskId(null)}
                      />
                    ))}
                  </div>
                );
              })
            )}

            {projects && projects.length > 0 && (
              <div className="border-t border-sol-border/30 px-6 py-3">
                <div className="text-xs font-medium text-sol-text-dim uppercase tracking-wide mb-2">Projects</div>
                <div className="flex gap-2 flex-wrap">
                  {projects.map((p: any) => {
                    const counts = p.task_counts || {};
                    return (
                      <div key={p._id} className="text-xs px-3 py-1.5 rounded-lg bg-sol-bg-alt border border-sol-border/30 text-sol-text-muted">
                        <span className="font-medium text-sol-text">{p.title}</span>
                        {counts.total > 0 && (
                          <span className="ml-2 tabular-nums">
                            {counts.done}/{counts.total}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {previewTaskId && (
            <TaskPreviewPanel
              taskId={previewTaskId}
              onClose={() => setPreviewTaskId(null)}
              onOpen={() => { router.push(`/tasks/${previewTaskId}`); }}
            />
          )}
          </div>

          {/* Keyboard shortcuts footer */}
          <div className="flex items-center gap-4 px-6 py-2 border-t border-sol-border/20 text-[10px] text-sol-text-dim">
            <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">j</kbd><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono ml-0.5">k</kbd> navigate</span>
            <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">x</kbd> select</span>
            <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">s</kbd> status</span>
            <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">p</kbd> priority</span>
            <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">l</kbd> labels</span>
            <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">c</kbd> create</span>
            <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">{"␣"}</kbd> peek</span>
            <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">{"⏎"}</kbd> open</span>
            <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">{"⌘K"}</kbd> cmd</span>
            <span className="ml-auto"><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">?</kbd> help</span>
          </div>
        </div>

        {showCreate && <CreateTaskModal onClose={() => setShowCreate(false)} />}

        <TaskCommandPalette
          open={cmdOpen}
          onClose={() => setCmdOpen(false)}
          targetTasks={cmdTargetOverride || getTargetTasks()}
          initialMode={cmdMode}
        />

        {showHelp && (
          <div className="fixed inset-0 z-[300] flex items-center justify-center" onClick={() => setShowHelp(false)}>
            <div className="fixed inset-0 bg-black/50" />
            <div className="relative bg-sol-bg border border-sol-border rounded-xl shadow-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
              <h2 className="text-sm font-semibold text-sol-text mb-4">Keyboard Shortcuts</h2>
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
                {[
                  ["j / k", "Navigate up/down"],
                  ["x", "Toggle selection"],
                  ["Space", "Preview task"],
                  ["Enter", "Open task detail"],
                  ["s", "Change status"],
                  ["p", "Set priority"],
                  ["l", "Add labels"],
                  ["c", "Create new task"],
                  ["e", "Edit title"],
                  ["d", "Command palette"],
                  ["\u2318K", "Command palette"],
                  ["\u2318A", "Select all"],
                  ["Esc", "Clear selection"],
                  ["1-5", "Filter: Active/Draft/Open/Progress/Done"],
                  ["Home / End", "Jump to first/last"],
                  ["?", "Toggle this help"],
                ].map(([key, desc]) => (
                  <Fragment key={key}>
                    <kbd className="px-1.5 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono text-sol-text text-right">{key}</kbd>
                    <span className="text-sol-text-muted py-0.5">{desc}</span>
                  </Fragment>
                ))}
              </div>
              <button onClick={() => setShowHelp(false)} className="mt-4 text-xs text-sol-text-dim hover:text-sol-text transition-colors">
                Press ? or Esc to close
              </button>
            </div>
          </div>
        )}
      </DashboardLayout>
    </AuthGuard>
  );
}
