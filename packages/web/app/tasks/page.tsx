"use client";

import { useState, useCallback } from "react";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";

const api = _api as any;
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { Badge } from "../../components/ui/badge";
import {
  Plus,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  CircleDotDashed,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  Minus,
  Filter,
  Link2,
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

function TaskRow({ task, onClick }: { task: any; onClick: () => void }) {
  const status = STATUS_CONFIG[task.status as TaskStatus] || STATUS_CONFIG.open;
  const priority = PRIORITY_CONFIG[task.priority as TaskPriority] || PRIORITY_CONFIG.medium;
  const StatusIcon = status.icon;
  const PriorityIcon = priority.icon;

  const age = Date.now() - task.updated_at;
  const ageStr = age < 3600000
    ? `${Math.round(age / 60000)}m`
    : age < 86400000
      ? `${Math.round(age / 3600000)}h`
      : `${Math.round(age / 86400000)}d`;

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-sol-bg-alt/50 transition-colors text-left group border-b border-sol-border/30"
    >
      <StatusIcon className={`w-4 h-4 flex-shrink-0 ${status.color}`} />
      <span className="text-xs font-mono text-sol-text-dim w-16 flex-shrink-0">{task.short_id}</span>
      <span className="flex-1 text-sm text-sol-text truncate">{task.title}</span>
      {task.blocked_by?.length > 0 && (
        <Link2 className="w-3.5 h-3.5 text-sol-red flex-shrink-0" />
      )}
      {task.labels?.map((l: string) => (
        <Badge key={l} variant="outline" className="text-[10px] px-1.5 py-0 border-sol-border/50 text-sol-text-dim">
          {l}
        </Badge>
      ))}
      <PriorityIcon className={`w-3.5 h-3.5 flex-shrink-0 ${priority.color}`} />
      <span className="text-xs text-sol-text-dim w-8 text-right tabular-nums">{ageStr}</span>
    </button>
  );
}

function TaskDetail({ task, onClose }: { task: any; onClose: () => void }) {
  const status = STATUS_CONFIG[task.status as TaskStatus] || STATUS_CONFIG.open;
  const priority = PRIORITY_CONFIG[task.priority as TaskPriority] || PRIORITY_CONFIG.medium;
  const updateTask = useMutation(api.tasks.webUpdate);
  const addComment = useMutation(api.tasks.webAddComment);
  const [comment, setComment] = useState("");

  const handleStatusChange = useCallback(async (newStatus: string) => {
    await updateTask({ short_id: task.short_id, status: newStatus });
  }, [task.short_id, updateTask]);

  const handleAddComment = useCallback(async () => {
    if (!comment.trim()) return;
    await addComment({
      short_id: task.short_id,
      text: comment.trim(),
      comment_type: "note",
    });
    setComment("");
  }, [comment, task.short_id, addComment]);

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center pt-[10vh]" onClick={onClose}>
      <div
        className="bg-sol-bg border border-sol-border rounded-xl shadow-2xl w-full max-w-2xl max-h-[70vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6">
          <div className="flex items-start gap-3 mb-4">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-mono text-sol-text-dim">{task.short_id}</span>
                <Badge variant="outline" className={`text-xs ${status.color} border-current/30`}>
                  {status.label}
                </Badge>
                <Badge variant="outline" className={`text-xs ${priority.color} border-current/30`}>
                  {priority.label}
                </Badge>
              </div>
              <h2 className="text-xl font-semibold text-sol-text">{task.title}</h2>
            </div>
            <button onClick={onClose} className="text-sol-text-dim hover:text-sol-text p-1">
              <XCircle className="w-5 h-5" />
            </button>
          </div>

          {task.description && (
            <div className="text-sm text-sol-text-muted whitespace-pre-wrap mb-4 p-3 bg-sol-bg-alt rounded-lg">
              {task.description}
            </div>
          )}

          <div className="flex gap-2 mb-4 flex-wrap">
            {task.blocked_by?.length > 0 && (
              <div className="text-xs text-sol-red flex items-center gap-1">
                <Link2 className="w-3 h-3" />
                Blocked by: {task.blocked_by.join(", ")}
              </div>
            )}
            {task.blocks?.length > 0 && (
              <div className="text-xs text-sol-text-dim flex items-center gap-1">
                Blocks: {task.blocks.join(", ")}
              </div>
            )}
          </div>

          <div className="flex gap-2 mb-6">
            {(["open", "in_progress", "in_review", "done", "dropped"] as TaskStatus[]).map((s) => {
              const cfg = STATUS_CONFIG[s];
              const Icon = cfg.icon;
              return (
                <button
                  key={s}
                  onClick={() => handleStatusChange(s)}
                  disabled={task.status === s}
                  className={`text-xs px-3 py-1.5 rounded-lg border transition-colors ${
                    task.status === s
                      ? "bg-sol-bg-highlight border-sol-border text-sol-text"
                      : "border-sol-border/30 text-sol-text-dim hover:text-sol-text hover:border-sol-border"
                  }`}
                >
                  <Icon className={`w-3 h-3 inline mr-1 ${cfg.color}`} />
                  {cfg.label}
                </button>
              );
            })}
          </div>

          {task.comments?.length > 0 && (
            <div className="mb-4">
              <h3 className="text-sm font-medium text-sol-text-dim mb-2">Comments</h3>
              <div className="space-y-2">
                {task.comments.map((c: any) => {
                  const ago = Date.now() - c.created_at;
                  const agoStr = ago < 3600000 ? `${Math.round(ago / 60000)}m ago` : ago < 86400000 ? `${Math.round(ago / 3600000)}h ago` : `${Math.round(ago / 86400000)}d ago`;
                  return (
                    <div key={c._id} className="text-sm p-2 rounded bg-sol-bg-alt">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sol-text">{c.author}</span>
                        <span className="text-xs text-sol-text-dim">{agoStr}</span>
                        {c.comment_type !== "note" && (
                          <Badge variant="outline" className="text-[10px] px-1">{c.comment_type}</Badge>
                        )}
                      </div>
                      <div className="text-sol-text-muted whitespace-pre-wrap">{c.text}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <input
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && handleAddComment()}
              placeholder="Add a comment..."
              className="flex-1 text-sm px-3 py-2 rounded-lg bg-sol-bg-alt border border-sol-border/50 text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan"
            />
            <button
              onClick={handleAddComment}
              disabled={!comment.trim()}
              className="px-3 py-2 text-sm rounded-lg bg-sol-cyan text-sol-bg hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              Send
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CreateTaskModal({ onClose, projectId }: { onClose: () => void; projectId?: string }) {
  const createTask = useMutation(api.tasks.webCreate);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [taskType, setTaskType] = useState("task");
  const [priority, setPriority] = useState("medium");

  const handleSubmit = useCallback(async () => {
    if (!title.trim()) return;
    await createTask({
      title: title.trim(),
      description: description.trim() || undefined,
      task_type: taskType,
      priority,
      project_id: projectId,
      status: "open",
    });
    onClose();
  }, [title, description, taskType, priority, projectId, createTask, onClose]);

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

export default function TasksPage() {
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [selectedTask, setSelectedTask] = useState<any>(null);
  const [showCreate, setShowCreate] = useState(false);

  const tasks = useQuery(api.tasks.webList, {
    status: statusFilter || undefined,
  });

  const taskDetail = useQuery(
    api.tasks.webGet,
    selectedTask?.short_id ? { short_id: selectedTask.short_id } : "skip"
  );

  const projects = useQuery(api.projects.webList, {});

  const grouped = (tasks || []).reduce((acc: Record<string, any[]>, t: any) => {
    const s = t.status as string;
    if (!acc[s]) acc[s] = [];
    acc[s].push(t);
    return acc;
  }, {});

  return (
    <AuthGuard>
      <DashboardLayout hideSidebar>
        <div className="h-full flex flex-col">
          <div className="flex items-center justify-between px-6 py-4 border-b border-sol-border/30">
            <div className="flex items-center gap-4">
              <h1 className="text-lg font-semibold text-sol-text tracking-tight">Tasks</h1>
              <div className="flex gap-1">
                <button
                  onClick={() => setStatusFilter("")}
                  className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                    !statusFilter ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"
                  }`}
                >
                  Active
                </button>
                {(["draft", "open", "in_progress", "done"] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setStatusFilter(s)}
                    className={`text-xs px-2.5 py-1 rounded-md transition-colors ${
                      statusFilter === s ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-dim hover:text-sol-text"
                    }`}
                  >
                    {STATUS_CONFIG[s].label}
                  </button>
                ))}
              </div>
            </div>
            <button
              onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-sol-cyan text-sol-bg hover:opacity-90 transition-opacity"
            >
              <Plus className="w-4 h-4" />
              New
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            {!tasks ? (
              <div className="flex items-center justify-center h-32 text-sol-text-dim text-sm">Loading...</div>
            ) : tasks.length === 0 ? (
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
            ) : statusFilter ? (
              <div>
                {tasks.map((t: any) => (
                  <TaskRow key={t._id} task={t} onClick={() => setSelectedTask(t)} />
                ))}
              </div>
            ) : (
              STATUS_ORDER.filter((s) => grouped[s]?.length).map((s) => (
                <div key={s}>
                  <div className="flex items-center gap-2 px-4 py-2 bg-sol-bg-alt/30 border-b border-sol-border/20">
                    {(() => {
                      const cfg = STATUS_CONFIG[s];
                      const Icon = cfg.icon;
                      return <Icon className={`w-3.5 h-3.5 ${cfg.color}`} />;
                    })()}
                    <span className="text-xs font-medium text-sol-text-dim uppercase tracking-wide">
                      {STATUS_CONFIG[s].label}
                    </span>
                    <span className="text-xs text-sol-text-dim">({grouped[s].length})</span>
                  </div>
                  {grouped[s].map((t: any) => (
                    <TaskRow key={t._id} task={t} onClick={() => setSelectedTask(t)} />
                  ))}
                </div>
              ))
            )}
          </div>

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

        {selectedTask && taskDetail && (
          <TaskDetail task={taskDetail} onClose={() => setSelectedTask(null)} />
        )}

        {showCreate && <CreateTaskModal onClose={() => setShowCreate(false)} />}
      </DashboardLayout>
    </AuthGuard>
  );
}
