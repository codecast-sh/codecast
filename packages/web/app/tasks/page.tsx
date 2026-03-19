"use client";
import { useState, useCallback, useRef, useMemo, Fragment } from "react";
import { useWatchEffect } from "../../hooks/useWatchEffect";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, TaskItem } from "../../store/inboxStore";
import { useSyncTasks, useSyncTaskDetail } from "../../hooks/useSyncTasks";
import { useWorkspaceArgs } from "../../hooks/useWorkspaceArgs";

import { TaskCommandPalette } from "../../components/TaskCommandPalette";
import { AssigneeSelect } from "../../components/AssigneeSelect";

const api = _api as any;
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { TaskStatusBadge } from "../../components/TaskStatusBadge";
import { toast } from "sonner";
import { getLabelColor, DEFAULT_LABELS } from "../../lib/labelColors";
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
  Clock,
  FileCode,
  ListChecks,
  ShieldCheck,
  ChevronDown,
  Tag,
  Search,
  LayoutGrid,
  List,
  EyeOff,
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

const STATUS_ORDER: TaskStatus[] = ["in_progress", "open", "backlog", "in_review", "done", "dropped"];

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

  useWatchEffect(() => {
    if (isFocused && rowRef.current) {
      rowRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [isFocused]);

  useWatchEffect(() => { setEditValue(task.title); }, [task.title]);

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
      {(task as any).activeSession && (() => {
        const { session_id, agent_status, agent_type, title } = (task as any).activeSession;
        const isBlocked = agent_status === "permission_blocked";
        const isIdle = agent_status === "idle" || agent_status === "stopped";
        const dotClass = isBlocked ? "bg-orange-400" : isIdle ? "bg-sol-text-dim" : "bg-emerald-400 animate-pulse";
        const badgeClass = isBlocked
          ? "bg-orange-500/15 text-orange-400 hover:bg-orange-500/25"
          : isIdle
          ? "bg-sol-bg-alt text-sol-text-dim hover:bg-sol-bg-highlight"
          : "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25";
        const statusLabel = isBlocked ? "blocked" : isIdle ? "idle"
          : agent_type === "codex" ? "codex" : agent_type === "cursor" ? "cursor" : agent_type === "gemini" ? "gemini" : "live";
        return (
          <Link
            href={`/conversation/${session_id}`}
            onClick={(e) => e.stopPropagation()}
            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] cursor-pointer transition-colors flex-shrink-0 ${badgeClass}`}
            title={title || "Active session"}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
            {statusLabel}
          </Link>
        );
      })()}
      {(task as any).plan && (
        <Link
          href={`/plans/${(task as any).plan._id}`}
          onClick={(e) => e.stopPropagation()}
          className="text-[10px] px-1.5 py-0 rounded bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/20 flex-shrink-0 hover:bg-sol-cyan/20 transition-colors max-w-[120px] truncate"
          title={(task as any).plan.title}
        >
          {(task as any).plan.title}
        </Link>
      )}
      {task.source === "insight" && (
        <span className="text-[10px] px-1.5 py-0 rounded bg-sol-violet/10 text-sol-violet border border-sol-violet/20 flex-shrink-0">mined</span>
      )}
      {task.execution_status && (
        <TaskStatusBadge status={task.execution_status} type="execution" className="flex-shrink-0" />
      )}
      {task.blocked_by && task.blocked_by.length > 0 && (
        <Link2 className="w-3.5 h-3.5 text-sol-red flex-shrink-0" />
      )}
      {task.labels?.map((l: string) => {
        const lc = getLabelColor(l);
        return (
          <span key={l} className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0 rounded-full border ${lc.bg} ${lc.border} ${lc.text}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${lc.dot}`} />
            {l}
          </span>
        );
      })}
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


const CREATE_STATUS_OPTIONS = [
  { key: "open", label: "Open", icon: Circle, color: "text-sol-blue" },
  { key: "backlog", label: "Backlog", icon: CircleDotDashed, color: "text-sol-text-dim" },
  { key: "in_progress", label: "In Progress", icon: CircleDot, color: "text-sol-yellow" },
];

const CREATE_PRIORITY_OPTIONS = [
  { key: "urgent", label: "Urgent", icon: AlertTriangle, color: "text-sol-red" },
  { key: "high", label: "High", icon: ArrowUp, color: "text-sol-orange" },
  { key: "medium", label: "Medium", icon: Minus, color: "text-sol-text-muted" },
  { key: "low", label: "Low", icon: ArrowDown, color: "text-sol-text-dim" },
];

function PropertyChip<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { key: T; label: string; icon: any; color?: string }[];
  onChange: (v: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.key === value) || options[0];
  const Icon = current.icon;

  useWatchEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs border border-sol-border/30 hover:border-sol-border/60 text-sol-text-muted hover:text-sol-text transition-colors"
      >
        <Icon className={`w-3.5 h-3.5 ${current.color || ""}`} />
        <span>{current.label}</span>
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-40 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[60] py-1">
          {options.map((opt) => {
            const OptIcon = opt.icon;
            return (
              <button
                key={opt.key}
                onClick={() => { onChange(opt.key); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                  opt.key === value ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt"
                }`}
              >
                <OptIcon className={`w-3.5 h-3.5 ${opt.color || ""}`} />
                <span className="flex-1 text-left">{opt.label}</span>
                {opt.key === value && <Check className="w-3 h-3 text-sol-cyan" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LabelsChip({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useWatchEffect(() => {
    if (!open) return;
    setTimeout(() => inputRef.current?.focus(), 0);
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const filtered = [...new Set([...DEFAULT_LABELS, ...value])]
    .filter((l) => !search.trim() || l.toLowerCase().includes(search.toLowerCase()));

  const canCreate = search.trim() && !filtered.some((l) => l.toLowerCase() === search.trim().toLowerCase());

  const toggle = (label: string) => {
    onChange(value.includes(label) ? value.filter((l) => l !== label) : [...value, label]);
  };

  const createAndAdd = () => {
    const name = search.trim().toLowerCase();
    if (name && !value.includes(name)) {
      onChange([...value, name]);
    }
    setSearch("");
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors border ${
          value.length > 0
            ? "border-sol-border/60 bg-sol-bg-alt text-sol-text"
            : "border-sol-border/30 hover:border-sol-border/60 text-sol-text-dim hover:text-sol-text"
        }`}
      >
        <Tag className="w-3.5 h-3.5" />
        {value.length > 0 ? (
          <span>{value.length === 1 ? value[0] : `${value.length} labels`}</span>
        ) : (
          <span>Labels</span>
        )}
        <ChevronDown className="w-3 h-3 opacity-60" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-48 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-[60] overflow-hidden">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-sol-border/30">
            <Search className="w-3.5 h-3.5 text-sol-text-dim flex-shrink-0" />
            <input
              ref={inputRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Type to search or create..."
              className="flex-1 text-xs bg-transparent text-sol-text placeholder:text-sol-text-dim outline-none"
              onKeyDown={(e) => {
                if (e.key === "Escape") setOpen(false);
                if (e.key === "Enter" && canCreate) { e.preventDefault(); createAndAdd(); }
              }}
            />
          </div>
          <div className="py-1 max-h-48 overflow-y-auto">
            {canCreate && (
              <button
                onClick={createAndAdd}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-sol-cyan hover:bg-sol-bg-alt transition-colors"
              >
                <Plus className="w-3 h-3 flex-shrink-0" />
                <span className="flex-1 text-left">Create "{search.trim()}"</span>
              </button>
            )}
            {filtered.map((label) => {
              const color = getLabelColor(label);
              return (
                <button
                  key={label}
                  onClick={() => toggle(label)}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                    value.includes(label) ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted hover:bg-sol-bg-alt"
                  }`}
                >
                  <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${color.dot}`} />
                  <span className="flex-1 text-left">{label}</span>
                  {value.includes(label) && <Check className="w-3.5 h-3.5 text-sol-cyan flex-shrink-0" />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function CreateTaskModal({ onClose, teamMembers, currentUser }: { onClose: () => void; teamMembers?: any[] | null; currentUser?: any }) {
  const createTask = useInboxStore((s) => s.createTask);
  const webCreate = useMutation(api.tasks.webCreate);
  const workspaceArgs = useWorkspaceArgs();

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<string>("medium");
  const [status, setStatus] = useState<string>("open");
  const [assignee, setAssignee] = useState<string | null>(null);
  const [assigneeInfo, setAssigneeInfo] = useState<{ name: string; image?: string } | null>(null);
  const [labels, setLabels] = useState<string[]>([]);
  const [createMore, setCreateMore] = useState(false);

  const titleRef = useRef<HTMLInputElement>(null);

  const handleSubmit = useCallback(async () => {
    if (!title.trim()) return;
    const opts: any = {
      title: title.trim(),
      description: description.trim() || undefined,
      task_type: "task",
      priority,
      status,
      assignee: assignee || undefined,
      labels: labels.length > 0 ? labels : undefined,
    };
    createTask(opts);
    try {
      const wsArgs = workspaceArgs === "skip" ? {} : workspaceArgs;
      await webCreate({ ...opts, ...wsArgs });
      toast.success(`Created: ${title.trim()}`);
    } catch (e: any) {
      console.error("Task creation failed:", e);
      toast.error(`Failed to create task: ${e?.message || "Unknown error"}`);
    }
    if (createMore) {
      setTitle("");
      setDescription("");
      setTimeout(() => titleRef.current?.focus(), 0);
    } else {
      onClose();
    }
  }, [title, description, priority, status, assignee, labels, createMore, createTask, webCreate, onClose]);

  return (
    <div
      className="fixed inset-0 bg-black/50 z-50 flex items-start justify-center pt-[12vh]"
      onClick={onClose}
    >
      <div
        className="bg-sol-bg border border-sol-border rounded-xl shadow-2xl w-full max-w-[540px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 pt-5 pb-2">
          <input
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Task title"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); }
              if (e.key === "Escape") onClose();
            }}
            className="w-full text-base font-medium text-sol-text placeholder:text-sol-text-dim/50 bg-transparent outline-none"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Add description..."
            rows={3}
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
            className="w-full mt-2 text-sm text-sol-text-muted placeholder:text-sol-text-dim/40 bg-transparent outline-none resize-none"
          />
        </div>

        <div className="flex items-center gap-1.5 px-4 py-3 border-t border-sol-border/20 flex-wrap">
          <PropertyChip value={status as any} options={CREATE_STATUS_OPTIONS as any} onChange={(v) => setStatus(v)} />
          <PropertyChip value={priority as any} options={CREATE_PRIORITY_OPTIONS as any} onChange={(v) => setPriority(v)} />
          <LabelsChip value={labels} onChange={setLabels} />
          <AssigneeSelect
            value={assignee}
            valueInfo={assigneeInfo}
            onChange={(id, info) => { setAssignee(id); setAssigneeInfo(info); }}
            teamMembers={teamMembers}
            currentUser={currentUser}
          />
          <div className="flex-1" />
          <label className="flex items-center gap-1.5 text-xs text-sol-text-dim cursor-pointer select-none hover:text-sol-text transition-colors">
            <input
              type="checkbox"
              checked={createMore}
              onChange={(e) => setCreateMore(e.target.checked)}
              className="w-3 h-3 accent-[var(--sol-cyan)]"
            />
            Create more
          </label>
          <button
            onClick={handleSubmit}
            disabled={!title.trim()}
            className="px-3 py-1.5 text-xs rounded-lg bg-sol-cyan text-sol-bg font-medium hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            Create
          </button>
        </div>
      </div>
    </div>
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
  onClick,
  onContextMenu,
}: {
  task: TaskItem;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const priority = PRIORITY_CONFIG[task.priority as TaskPriority] || PRIORITY_CONFIG.none;
  const PriorityIcon = priority.icon;
  const assignee = task.assignee_info;

  return (
    <div
      onClick={onClick}
      onContextMenu={onContextMenu}
      className="bg-white dark:bg-sol-bg-alt border border-sol-border/40 rounded-lg sm:rounded-xl p-3 cursor-pointer shadow-sm hover:border-sol-yellow/50 hover:shadow-md transition-all select-none"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="text-[10px] font-mono text-sol-text-dim leading-none mt-0.5">{task.short_id}</span>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {(task as any).activeSession && (() => {
            const { agent_status, agent_type } = (task as any).activeSession;
            const isBlocked = agent_status === "permission_blocked";
            const isIdle = agent_status === "idle" || agent_status === "stopped";
            const dotClass = isBlocked ? "bg-orange-400" : isIdle ? "bg-sol-text-dim" : "bg-emerald-400 animate-pulse";
            const badgeClass = isBlocked
              ? "bg-orange-500/15 text-orange-400"
              : isIdle
              ? "bg-sol-bg-alt text-sol-text-dim"
              : "bg-emerald-500/15 text-emerald-400";
            const statusLabel = isBlocked ? "blocked" : isIdle ? "idle"
              : agent_type === "codex" ? "codex" : agent_type === "cursor" ? "cursor" : agent_type === "gemini" ? "gemini" : "live";
            return (
              <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[9px] ${badgeClass}`}>
                <span className={`w-1 h-1 rounded-full ${dotClass}`} />
                {statusLabel}
              </span>
            );
          })()}
          {assignee ? (
            assignee.image ? (
              <img src={assignee.image} alt={assignee.name} className="w-4 h-4 rounded-full" title={assignee.name} />
            ) : (
              <div className="w-4 h-4 rounded-full bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center text-[7px] font-medium text-sol-text-muted" title={assignee.name}>
                {assignee.name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()}
              </div>
            )
          ) : null}
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
}: {
  grouped: Record<string, TaskItem[]>;
  hiddenStatuses: Set<string>;
  onToggleHidden: (status: string) => void;
  onCardClick: (task: TaskItem) => void;
  onContextMenu: (e: React.MouseEvent, task: TaskItem) => void;
  onAddTask: (status: string) => void;
}) {
  const visibleStatuses = STATUS_ORDER.filter((s) => !hiddenStatuses.has(s) && (grouped[s]?.length || true));
  const hiddenWithTasks = STATUS_ORDER.filter((s) => hiddenStatuses.has(s));

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Columns */}
      <div className="flex-1 flex gap-3 overflow-x-auto px-4 py-4 pb-6">
        {visibleStatuses.map((status) => {
          const cfg = STATUS_CONFIG[status as TaskStatus];
          const Icon = cfg.icon;
          const tasks = grouped[status] || [];
          return (
            <div key={status} className="flex flex-col w-[272px] flex-shrink-0 min-h-0">
              {/* Column header */}
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
              {/* Cards */}
              <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                {tasks.map((task) => (
                  <KanbanCard
                    key={task._id}
                    task={task}
                    onClick={() => onCardClick(task)}
                    onContextMenu={(e) => onContextMenu(e, task)}
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

      {/* Hidden columns panel */}
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
  const [viewMode, setViewMode] = useState<"list" | "kanban">("list");
  const [hiddenStatuses, setHiddenStatuses] = useState<Set<string>>(new Set(["dropped"]));

  const { hasMore, loadMore } = useSyncTasks(statusFilter || undefined);
  const currentUser = useQuery(api.users.getCurrentUser);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const effectiveTeamId = (activeTeamId || (currentUser as any)?.team_id) as any;
  const teamMembers = useQuery(api.teams.getTeamMembers, effectiveTeamId ? { team_id: effectiveTeamId } : "skip");
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

  useWatchEffect(() => {
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

      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        openCmdPalette("root");
        return;
      }

      const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };

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

      if (e.key === "x" && !e.metaKey && !e.ctrlKey) {
        stop();
        if (focusedTask) toggleSelect(focusedTask._id);
        return;
      }

      if (e.key === "Enter") {
        stop();
        if (focusedTask) router.push(`/tasks/${focusedTask._id}`);
        return;
      }

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

      if (e.key === "s" && !e.metaKey && !e.ctrlKey) {
        stop();
        openCmdPalette("status");
        return;
      }

      if (e.key === "p" && !e.metaKey && !e.ctrlKey) {
        stop();
        openCmdPalette("priority");
        return;
      }

      if (e.key === "l" && !e.metaKey && !e.ctrlKey) {
        stop();
        openCmdPalette("labels");
        return;
      }

      if (e.key === "a" && !e.metaKey && !e.ctrlKey) {
        stop();
        openCmdPalette("assign");
        return;
      }

      if (e.key === "c" && !e.metaKey && !e.ctrlKey) {
        stop();
        setShowCreate(true);
        return;
      }

      if (e.key === "e" && !e.metaKey && !e.ctrlKey) {
        stop();
        if (focusedTask) setEditingTaskId(focusedTask._id);
        return;
      }

      if (e.key === "d" && !e.metaKey && !e.ctrlKey) {
        stop();
        openCmdPalette("root");
        return;
      }

      if (e.key === "a" && (e.metaKey || e.ctrlKey)) {
        stop();
        setSelectedIds(new Set(flatTasks.map((t) => t._id)));
        return;
      }

      if (e.key === " " && !e.metaKey && !e.ctrlKey) {
        stop();
        if (focusedTask) {
          setPreviewTaskId((prev) => prev === focusedTask._id ? null : focusedTask._id);
        }
        return;
      }

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

      if (e.key === "?" && !e.metaKey && !e.ctrlKey) {
        stop();
        setShowHelp((h) => !h);
        return;
      }

      const filterKeys: Record<string, string> = { "1": "", "2": "backlog", "3": "open", "4": "in_progress", "5": "done" };
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

  useWatchEffect(() => {
    if (focusIndex >= flatTasks.length && flatTasks.length > 0) {
      setFocusIndex(flatTasks.length - 1);
    }
  }, [flatTasks.length, focusIndex]);

  useWatchEffect(() => {
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
                {(["backlog", "open", "in_progress", "done"] as const).map((s) => (
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
              {viewMode === "list" && (
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
              )}
              {/* View toggle */}
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

          {viewMode === "kanban" ? (
            <KanbanView
              grouped={grouped}
              hiddenStatuses={hiddenStatuses}
              onToggleHidden={(s) => setHiddenStatuses((prev) => {
                const next = new Set(prev);
                if (next.has(s)) next.delete(s); else next.add(s);
                return next;
              })}
              onCardClick={(t) => router.push(`/tasks/${t._id}`)}
              onContextMenu={handleContextMenu}
              onAddTask={() => { setShowCreate(true); }}
            />
          ) : (
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

            {hasMore && (
              <div className="px-6 py-3 border-t border-sol-border/20">
                <button
                  onClick={loadMore}
                  className="text-xs text-sol-text-dim hover:text-sol-text transition-colors"
                >
                  Load more tasks
                </button>
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
          )}

          {/* Keyboard shortcuts footer */}
          <div className="flex items-center gap-4 px-6 py-2 border-t border-sol-border/20 text-[10px] text-sol-text-dim">
            <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">j</kbd><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono ml-0.5">k</kbd> navigate</span>
            <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">x</kbd> select</span>
            <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">s</kbd> status</span>
            <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">p</kbd> priority</span>
            <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">l</kbd> labels</span>
            <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">a</kbd> assign</span>
            <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">c</kbd> create</span>
            <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">{"␣"}</kbd> peek</span>
            <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">{"⏎"}</kbd> open</span>
            <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">{"⌘K"}</kbd> cmd</span>
            <span className="ml-auto"><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">?</kbd> help</span>
          </div>
        </div>

        {showCreate && <CreateTaskModal onClose={() => setShowCreate(false)} teamMembers={teamMembers} currentUser={currentUser} />}

        <TaskCommandPalette
          open={cmdOpen}
          onClose={() => setCmdOpen(false)}
          targetTasks={cmdTargetOverride || getTargetTasks()}
          initialMode={cmdMode}
          teamMembers={teamMembers}
          currentUser={currentUser}
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
                  ["a", "Assign task"],
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
