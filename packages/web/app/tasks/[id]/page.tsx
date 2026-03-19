"use client";
import { useState, useCallback, useRef, Fragment } from "react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, TaskDetail, TaskItem } from "../../../store/inboxStore";
import { useSyncTaskDetail } from "../../../hooks/useSyncTasks";
import { TaskCommandPalette } from "../../../components/TaskCommandPalette";
import { WorkflowContextPanel } from "../../../components/WorkflowContextPanel";
import { MarkdownRenderer } from "../../../components/tools/MarkdownRenderer";
import { toast } from "sonner";
import { AuthGuard } from "../../../components/AuthGuard";
import { DashboardLayout } from "../../../components/DashboardLayout";

const api = _api as any;
import { Badge } from "../../../components/ui/badge";
import { TaskStatusBadge } from "../../../components/TaskStatusBadge";
import { getLabelColor } from "../../../lib/labelColors";
import Link from "next/link";
import {
  ArrowLeft,
  Circle,
  CircleDot,
  CircleDotDashed,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  Minus,
  MessageSquare,
  FolderGit2,
  FileText,
  ExternalLink,
  Clock,
  Zap,
  Bot,
  ChevronDown,
  GitBranch,
  Radio,
  FileCode,
  ListChecks,
  ShieldCheck,
} from "lucide-react";

const STATUS_OPTIONS = [
  { key: "backlog", icon: CircleDotDashed, label: "Backlog", color: "text-sol-text-dim" },
  { key: "open", icon: Circle, label: "Open", color: "text-sol-blue" },
  { key: "in_progress", icon: CircleDot, label: "In Progress", color: "text-sol-yellow" },
  { key: "in_review", icon: CircleDot, label: "In Review", color: "text-sol-violet" },
  { key: "done", icon: CheckCircle2, label: "Done", color: "text-sol-green" },
  { key: "dropped", icon: XCircle, label: "Dropped", color: "text-sol-text-dim" },
] as const;

const PRIORITY_OPTIONS = [
  { key: "urgent", icon: AlertTriangle, label: "Urgent", color: "text-sol-red" },
  { key: "high", icon: ArrowUp, label: "High", color: "text-sol-orange" },
  { key: "medium", icon: Minus, label: "Medium", color: "text-sol-text-muted" },
  { key: "low", icon: ArrowDown, label: "Low", color: "text-sol-text-dim" },
  { key: "none", icon: Minus, label: "None", color: "text-sol-text-dim" },
] as const;

const STATUS_MAP: Record<string, typeof STATUS_OPTIONS[number]> = Object.fromEntries(STATUS_OPTIONS.map((s) => [s.key, s]));

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function formatRelative(ts: number) {
  const ago = Date.now() - ts;
  if (ago < 3600000) return `${Math.round(ago / 60000)}m ago`;
  if (ago < 86400000) return `${Math.round(ago / 3600000)}h ago`;
  return `${Math.round(ago / 86400000)}d ago`;
}

function Avatar({ name, image, size = "sm" }: { name: string; image?: string; size?: "sm" | "md" }) {
  const px = size === "md" ? "w-7 h-7" : "w-5 h-5";
  const textSize = size === "md" ? "text-[10px]" : "text-[8px]";
  if (image) {
    return <img src={image} alt={name} className={`${px} rounded-full flex-shrink-0`} />;
  }
  const initials = name.split(" ").map(w => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <div className={`${px} rounded-full flex-shrink-0 bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center ${textSize} font-medium text-sol-text-muted`}>
      {initials}
    </div>
  );
}

type DropdownOption = { key: string; icon: any; label: string; color: string };

function Dropdown({
  value,
  options,
  onChange,
  shortcutHint,
}: {
  value: string;
  options: readonly DropdownOption[];
  onChange: (key: string) => void;
  shortcutHint?: string;
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

  useWatchEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setOpen(false); return; }
      const idx = options.findIndex((o) => o.label.toLowerCase().startsWith(e.key.toLowerCase()));
      if (idx >= 0) { onChange(options[idx].key); setOpen(false); }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, options, onChange]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs hover:bg-sol-bg-alt transition-colors"
        title={shortcutHint}
      >
        <Icon className={`w-3.5 h-3.5 ${current.color}`} />
        <span className="text-sol-text-muted">{current.label}</span>
        <ChevronDown className="w-3 h-3 text-sol-text-dim" />
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-44 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-50 py-1 overflow-hidden">
          {options.map((opt) => {
            const OptIcon = opt.icon;
            return (
              <button
                key={opt.key}
                onClick={() => { onChange(opt.key); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-sol-bg-alt transition-colors ${
                  opt.key === value ? "bg-sol-bg-highlight text-sol-text" : "text-sol-text-muted"
                }`}
              >
                <OptIcon className={`w-3.5 h-3.5 ${opt.color}`} />
                {opt.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const OUTCOME_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  shipped: { bg: "bg-emerald-500/15", text: "text-emerald-400", label: "Shipped" },
  progress: { bg: "bg-sol-blue/15", text: "text-sol-blue", label: "Progress" },
  exploration: { bg: "bg-sol-violet/15", text: "text-sol-violet", label: "Exploration" },
  blocked: { bg: "bg-sol-red/15", text: "text-sol-red", label: "Blocked" },
  abandoned: { bg: "bg-sol-text-dim/15", text: "text-sol-text-dim", label: "Abandoned" },
};

function formatDuration(start: number, end: number) {
  const mins = Math.round((end - start) / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remainMins = mins % 60;
  return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`;
}

function SessionCard({ session }: { session: any }) {
  const isActive = session.is_active;
  const outcome = session.outcome_type ? OUTCOME_STYLES[session.outcome_type] : null;
  const projectName = session.project_path?.split("/").pop();

  return (
    <Link
      href={`/conversation/${session.session_id || session._id}`}
      className={`block px-4 py-3 hover:bg-sol-bg-alt/50 transition-colors ${isActive ? "border-l-2 border-emerald-400" : ""}`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            {isActive && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 text-[10px] font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                live
              </span>
            )}
            <span className="text-sm font-medium text-sol-text truncate">
              {session.title || "Untitled Session"}
            </span>
          </div>
          {session.headline && (
            <p className="text-xs text-sol-text-muted line-clamp-2 mb-1.5">{session.headline}</p>
          )}
          <div className="flex items-center gap-3 text-[11px] text-sol-text-dim flex-wrap">
            {projectName && (
              <span className="flex items-center gap-1">
                <FolderGit2 className="w-3 h-3" />
                {projectName}
              </span>
            )}
            {session.git_branch && (
              <span className="flex items-center gap-1 font-mono">
                <GitBranch className="w-3 h-3" />
                {session.git_branch}
              </span>
            )}
            <span className="flex items-center gap-1">
              <MessageSquare className="w-3 h-3" />
              {session.message_count}
            </span>
            {session.started_at && session.updated_at && (
              <span className="flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {formatDuration(session.started_at, session.updated_at)}
              </span>
            )}
            <span>{formatRelative(session.updated_at || session.started_at)}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {outcome && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded ${outcome.bg} ${outcome.text}`}>
              {outcome.label}
            </span>
          )}
          <ExternalLink className="w-3.5 h-3.5 text-sol-text-dim" />
        </div>
      </div>
      {isActive && session.recent_messages && session.recent_messages.length > 0 && (
        <div className="mt-2 ml-0 border-t border-sol-border/10 pt-2 space-y-1">
          {session.recent_messages.map((msg: any) => (
            <div key={msg._id} className="flex gap-2 text-[11px]">
              <span className={`flex-shrink-0 font-medium ${msg.role === "user" ? "text-sol-cyan" : "text-sol-violet"}`}>
                {msg.role === "user" ? "you" : "agent"}
              </span>
              <span className="text-sol-text-dim truncate">{msg.content}</span>
            </div>
          ))}
        </div>
      )}
    </Link>
  );
}

function HistoryItem({ entry }: { entry: any }) {
  const statusCfg = entry.field === "status" ? STATUS_MAP[entry.new_value] : null;
  return (
    <div className="flex items-center gap-2 text-xs text-sol-text-dim py-1.5">
      {entry.actor ? (
        <Avatar name={entry.actor.name} image={entry.actor.image} />
      ) : (
        <div className="w-5 h-5 rounded-full flex-shrink-0 bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center">
          <Bot className="w-3 h-3 text-sol-text-dim" />
        </div>
      )}
      <span className="text-sol-text-muted">{entry.actor?.name || "System"}</span>
      {entry.action === "created" ? (
        <span>created this task</span>
      ) : entry.field === "status" && statusCfg ? (
        <>
          <span>changed status to</span>
          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${statusCfg.color} border-current/30`}>
            {statusCfg.label}
          </Badge>
        </>
      ) : (
        <>
          <span>changed {entry.field}</span>
          {entry.old_value && <span className="line-through opacity-60">{entry.old_value}</span>}
          <span>&rarr;</span>
          <span className="text-sol-text-muted">{entry.new_value}</span>
        </>
      )}
      <span className="ml-auto flex-shrink-0">{formatRelative(entry.created_at)}</span>
    </div>
  );
}

function ExecutionDetailsSection({ data }: { data: any }) {
  const hasExecution = data.execution_status || data.steps?.length || data.acceptance_criteria?.length ||
    data.files_changed?.length || data.execution_concerns || data.estimated_minutes != null || data.actual_minutes != null;
  if (!hasExecution) return null;

  return (
    <div className="mb-6">
      <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wide mb-2 flex items-center gap-1.5">
        Execution
        {data.execution_status && (
          <TaskStatusBadge status={data.execution_status} type="execution" className="normal-case tracking-normal" />
        )}
      </h2>
      <div className="border border-sol-border/30 rounded-lg bg-sol-bg-alt/20 p-4 space-y-4">
        {(data.estimated_minutes != null || data.actual_minutes != null) && (
          <div className="flex items-center gap-4 text-xs">
            <Clock className="w-3.5 h-3.5 text-sol-text-dim flex-shrink-0" />
            {data.estimated_minutes != null && (
              <span className="text-sol-text-dim">Estimated: <span className="text-sol-text-muted font-medium">{data.estimated_minutes}m</span></span>
            )}
            {data.actual_minutes != null && (
              <span className="text-sol-text-dim">Actual: <span className="text-sol-text-muted font-medium">{data.actual_minutes}m</span></span>
            )}
          </div>
        )}

        {data.execution_concerns && (
          <div className="text-sm p-3 rounded-lg bg-sol-yellow/5 border border-sol-yellow/20 text-sol-yellow">
            {data.execution_concerns}
          </div>
        )}

        {data.acceptance_criteria && data.acceptance_criteria.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 text-xs font-medium text-sol-text-dim mb-2">
              <ListChecks className="w-3.5 h-3.5" />
              Acceptance Criteria
            </div>
            <div className="space-y-1.5">
              {data.acceptance_criteria.map((c: string, i: number) => (
                <div key={i} className="flex items-start gap-2.5 text-sm text-sol-text-muted">
                  <ShieldCheck className="w-3.5 h-3.5 text-sol-text-dim flex-shrink-0 mt-0.5" />
                  <span>{c}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {data.steps && data.steps.length > 0 && (
          <div>
            <div className="text-xs font-medium text-sol-text-dim mb-2">Steps</div>
            <div className="space-y-1.5">
              {data.steps.map((s: any, i: number) => (
                <div key={i} className="flex items-start gap-2.5 text-sm">
                  <span className={`flex-shrink-0 mt-0.5 ${s.done ? "text-sol-green" : "text-sol-text-dim"}`}>
                    {s.done ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Circle className="w-3.5 h-3.5" />}
                  </span>
                  <div className="min-w-0">
                    <span className={s.done ? "text-sol-text-muted line-through" : "text-sol-text-muted"}>{s.title}</span>
                    {s.verification && (
                      <div className="text-xs text-sol-text-dim mt-0.5">{s.verification}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {data.files_changed && data.files_changed.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 text-xs font-medium text-sol-text-dim mb-2">
              <FileCode className="w-3.5 h-3.5" />
              Files Changed ({data.files_changed.length})
            </div>
            <div className="space-y-0.5">
              {data.files_changed.map((f: string) => (
                <div key={f} className="text-xs font-mono text-sol-text-dim truncate">{f}</div>
              ))}
            </div>
          </div>
        )}

        {data.verification_evidence && (
          <div>
            <div className="text-xs font-medium text-sol-text-dim mb-1.5">Verification Evidence</div>
            <div className="text-sm text-sol-text-muted whitespace-pre-wrap">{data.verification_evidence}</div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function TaskDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  useSyncTaskDetail(id);

  const detail = useInboxStore((s) => s.taskDetails[id]) as TaskDetail | undefined;
  const listItem = useInboxStore((s) => s.tasks[id]);
  const data = detail || (listItem as TaskDetail | undefined);
  const updateTask = useInboxStore((s) => s.updateTask);
  const webUpdate = useMutation(api.tasks.webUpdate);
  const webAddComment = useMutation(api.tasks.webAddComment);
  const currentUser = useQuery(api.users.getCurrentUser);
  const activeTeamId = useInboxStore((s) => s.clientState.ui?.active_team_id);
  const effectiveTeamId = (activeTeamId || (currentUser as any)?.team_id) as any;
  const teamMembers = useQuery(api.teams.getTeamMembers, effectiveTeamId ? { team_id: effectiveTeamId } : "skip");
  const [comment, setComment] = useState("");
  const [submittingComment, setSubmittingComment] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const [editingDesc, setEditingDesc] = useState(false);
  const [descDraft, setDescDraft] = useState("");
  const descRef = useRef<HTMLTextAreaElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const [cmdOpen, setCmdOpen] = useState(false);
  const [cmdMode, setCmdMode] = useState<"root" | "status" | "priority" | "labels" | "assign">("root");
  const [showHelp, setShowHelp] = useState(false);

  const handleUpdate = useCallback(async (fields: Record<string, any>) => {
    if (!data?.short_id) return;
    updateTask(data.short_id, fields);
    try {
      await webUpdate({ short_id: data.short_id, ...fields });
    } catch {}
  }, [data?.short_id, updateTask, webUpdate]);

  const handleAddComment = useCallback(async () => {
    if (!comment.trim() || !data?.short_id || submittingComment) return;
    const text = comment.trim();
    setComment("");
    setSubmittingComment(true);
    try {
      await webAddComment({ short_id: data.short_id, text, comment_type: "note" });
    } catch {
      setComment(text);
      toast.error("Failed to add comment");
    } finally {
      setSubmittingComment(false);
    }
  }, [comment, data?.short_id, submittingComment, webAddComment]);

  const startEditTitle = useCallback(() => {
    if (!data) return;
    setTitleDraft(data.title);
    setEditingTitle(true);
    setTimeout(() => titleRef.current?.focus(), 0);
  }, [data]);

  const commitTitle = useCallback(() => {
    setEditingTitle(false);
    if (titleDraft.trim() && titleDraft.trim() !== data?.title) {
      handleUpdate({ title: titleDraft.trim() });
    }
  }, [titleDraft, data?.title, handleUpdate]);

  const startEditDesc = useCallback(() => {
    setDescDraft(data?.description || "");
    setEditingDesc(true);
    setTimeout(() => descRef.current?.focus(), 0);
  }, [data?.description]);

  const commitDesc = useCallback(() => {
    setEditingDesc(false);
    const trimmed = descDraft.trim();
    if (trimmed !== (data?.description || "")) {
      handleUpdate({ description: trimmed });
    }
  }, [descDraft, data?.description, handleUpdate]);

  const openCmd = useCallback((mode: "root" | "status" | "priority" | "labels" | "assign") => {
    setCmdMode(mode);
    setCmdOpen(true);
  }, []);

  useWatchEffect(() => {
    if (cmdOpen) return;
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

      const stop = () => { e.preventDefault(); e.stopImmediatePropagation(); };

      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        stop();
        openCmd("root");
      } else if (e.key === "s" && !e.metaKey && !e.ctrlKey) {
        stop();
        openCmd("status");
      } else if (e.key === "p" && !e.metaKey && !e.ctrlKey) {
        stop();
        openCmd("priority");
      } else if (e.key === "l" && !e.metaKey && !e.ctrlKey) {
        stop();
        openCmd("labels");
      } else if (e.key === "e" && !e.metaKey && !e.ctrlKey) {
        stop();
        startEditTitle();
      } else if (e.key === "Backspace" && !e.metaKey && !e.ctrlKey) {
        stop();
        router.push("/tasks");
      } else if (e.key === "Escape" && !e.metaKey && !e.ctrlKey) {
        stop();
        router.push("/tasks");
      } else if (e.key === "?" && !e.metaKey && !e.ctrlKey) {
        stop();
        setShowHelp((h) => !h);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [cmdOpen, showHelp, data, openCmd, startEditTitle, router]);

  if (!data) {
    return (
      <AuthGuard>
        <DashboardLayout>
          <div className="flex items-center justify-center h-64 text-sol-text-dim text-sm">Loading...</div>
        </DashboardLayout>
      </AuthGuard>
    );
  }

  const status = STATUS_MAP[data.status] || STATUS_MAP.open;
  const StatusIcon = status.icon;

  return (
    <AuthGuard>
      <DashboardLayout>
        <div className="h-full flex flex-col">
        <div className="flex-1 overflow-y-auto">
        <div className="max-w-4xl mx-auto px-6 py-6">
          <Link
            href="/tasks"
            className="inline-flex items-center gap-1.5 text-sm text-sol-text-dim hover:text-sol-cyan transition-colors mb-4"
          >
            <ArrowLeft className="w-4 h-4" />
            Tasks
          </Link>

          {/* Title row */}
          <div className="flex items-start gap-3 mb-3">
            <StatusIcon className={`w-5 h-5 mt-1.5 flex-shrink-0 ${status.color}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs text-sol-text-dim mb-1">
                <span className="font-mono">{data.short_id}</span>
                {data.source === "insight" && (
                  <span className="px-1.5 py-0.5 rounded bg-sol-violet/10 text-sol-violet border border-sol-violet/20">
                    mined
                  </span>
                )}
              </div>
              {editingTitle ? (
                <input
                  ref={titleRef}
                  value={titleDraft}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onBlur={commitTitle}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitTitle();
                    if (e.key === "Escape") setEditingTitle(false);
                  }}
                  className="w-full text-xl font-semibold text-sol-text bg-transparent border-b border-sol-cyan focus:outline-none pb-0.5"
                />
              ) : (
                <h1
                  className="text-xl font-semibold text-sol-text leading-tight cursor-text hover:text-sol-cyan/90 transition-colors"
                  onClick={startEditTitle}
                  title="Click to edit (e)"
                >
                  {data.title}
                </h1>
              )}
            </div>
          </div>

          {/* Properties sidebar-style row (Linear pattern) */}
          <div className="border border-sol-border/30 rounded-lg bg-sol-bg-alt/20 mb-6">
            <div className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-0.5 px-4 py-3 text-xs">
              <span className="text-sol-text-dim py-1">Status</span>
              <Dropdown value={data.status} options={STATUS_OPTIONS} onChange={(v) => handleUpdate({ status: v })} shortcutHint="s to cycle" />

              <span className="text-sol-text-dim py-1">Priority</span>
              <Dropdown value={data.priority} options={PRIORITY_OPTIONS} onChange={(v) => handleUpdate({ priority: v })} shortcutHint="p to cycle" />

              <span className="text-sol-text-dim py-1">Assignee</span>
              <button
                onClick={() => openCmd("assign")}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs hover:bg-sol-bg-alt transition-colors text-left"
              >
                {(data as any).assignee_info ? (
                  <>
                    <Avatar name={(data as any).assignee_info.name} image={(data as any).assignee_info.image} />
                    <span className="text-sol-text-muted">{(data as any).assignee_info.name}</span>
                  </>
                ) : (
                  <span className="text-sol-text-dim">Unassigned</span>
                )}
              </button>

              <span className="text-sol-text-dim py-1">Created</span>
              <span className="flex items-center gap-1 text-sol-text-muted py-1">
                <Clock className="w-3 h-3" />
                {formatDate(data.created_at)}
              </span>

              {data.closed_at && (
                <>
                  <span className="text-sol-text-dim py-1">Closed</span>
                  <span className="text-sol-text-muted py-1">{formatDate(data.closed_at)}</span>
                </>
              )}

              {(data as any).started_at && (
                <>
                  <span className="text-sol-text-dim py-1">Started</span>
                  <span className="text-sol-text-muted py-1">{formatDate((data as any).started_at)}</span>
                </>
              )}

              {data.confidence != null && (
                <>
                  <span className="text-sol-text-dim py-1">Confidence</span>
                  <span className="text-sol-text-muted py-1">{Math.round(data.confidence * 100)}%</span>
                </>
              )}

              {data.labels && data.labels.length > 0 && (
                <>
                  <span className="text-sol-text-dim py-1">Labels</span>
                  <div className="flex gap-1 py-1 flex-wrap">
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
                </>
              )}

              {data.blocked_by && data.blocked_by.length > 0 && (
                <>
                  <span className="text-sol-text-dim py-1">Blocked by</span>
                  <span className="text-sol-red py-1">{data.blocked_by.join(", ")}</span>
                </>
              )}

              {data.blocks && data.blocks.length > 0 && (
                <>
                  <span className="text-sol-text-dim py-1">Blocks</span>
                  <span className="text-sol-text-muted py-1">{data.blocks.join(", ")}</span>
                </>
              )}
            </div>
          </div>

          {/* Source session */}
          {(data.source === "agent" || data.source === "insight") && data.created_from_conversation && (
            <div className="flex items-center gap-2 text-xs text-sol-text-dim mb-4">
              <Zap className="w-3 h-3 text-sol-violet" />
              <span>Created from</span>
              <Link
                href={`/conversation/${data.linked_conversations?.[0]?.session_id || ""}`}
                className="text-sol-cyan hover:underline"
              >
                session
              </Link>
            </div>
          )}

          {/* Description */}
          {editingDesc ? (
            <div className="mb-6">
              <textarea
                ref={descRef}
                value={descDraft}
                onChange={(e) => setDescDraft(e.target.value)}
                onBlur={commitDesc}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { setEditingDesc(false); }
                  if (e.key === "Enter" && e.metaKey) { commitDesc(); }
                }}
                placeholder="Add a description..."
                rows={4}
                className="w-full text-sm px-4 py-3 rounded-lg bg-sol-bg border border-sol-border/50 text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-cyan resize-y min-h-[80px]"
              />
              <div className="flex justify-end gap-2 mt-1.5">
                <span className="text-[10px] text-sol-text-dim self-center mr-auto">Markdown supported</span>
                <button onClick={() => setEditingDesc(false)} className="text-xs text-sol-text-dim hover:text-sol-text px-2 py-1">Cancel</button>
                <button onClick={commitDesc} className="text-xs px-3 py-1 rounded-md bg-sol-cyan text-sol-bg hover:opacity-90">Save</button>
              </div>
            </div>
          ) : data.description ? (
            <div
              className="mb-6 cursor-text group"
              onClick={startEditDesc}
            >
              <MarkdownRenderer content={data.description} className="text-sm text-sol-text-muted leading-relaxed prose-sm prose-invert max-w-none group-hover:text-sol-text transition-colors" />
            </div>
          ) : (
            <div
              className="mb-6 cursor-text text-sm text-sol-text-dim hover:text-sol-text-muted transition-colors"
              onClick={startEditDesc}
            >
              Add a description...
            </div>
          )}

          {/* Workflow Progress */}
          {data.workflow_run_id && (
            <div className="mb-6">
              <WorkflowContextPanel workflowRunId={data.workflow_run_id as any} />
            </div>
          )}

          {/* Execution Details */}
          <ExecutionDetailsSection data={data} />

          {/* Source Insight */}
          {data.source_insight && (
            <div className="mb-6">
              <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wide mb-2">Source Insight</h2>
              <div className="border border-sol-border/30 rounded-lg p-4 bg-sol-bg-alt/20">
                <div className="flex items-center gap-2 mb-2">
                  <Zap className="w-4 h-4 text-sol-cyan" />
                  <Badge variant="outline" className="text-[10px] text-sol-cyan border-sol-cyan/30">
                    {data.source_insight.outcome_type}
                  </Badge>
                </div>
                <p className="text-sm text-sol-text-muted">{data.source_insight.summary}</p>
                {data.source_insight.themes?.length > 0 && (
                  <div className="flex gap-1 mt-2">
                    {data.source_insight.themes.map((t: string) => (
                      <span key={t} className="text-[10px] px-1.5 rounded bg-sol-bg-highlight text-sol-text-dim">{t}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Plan */}
          {(data as any).plan && (
            <div className="mb-6">
              <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wide mb-2">Plan</h2>
              <Link
                href={`/plans/${(data as any).plan._id}`}
                className="flex items-center gap-2.5 px-4 py-3 border border-sol-border/30 rounded-lg hover:bg-sol-bg-alt/50 transition-colors"
              >
                <CircleDot className="w-4 h-4 text-sol-cyan flex-shrink-0" />
                <span className="text-sm font-medium text-sol-cyan">{(data as any).plan.title}</span>
                <span className="text-[10px] font-mono text-sol-text-dim">{(data as any).plan.short_id}</span>
                <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-sol-cyan border-sol-cyan/30 ml-auto">{(data as any).plan.status}</Badge>
              </Link>
            </div>
          )}

          {/* Linked Sessions */}
          {data.linked_conversations && data.linked_conversations.length > 0 && (
            <div className="mb-6">
              <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <Radio className="w-3.5 h-3.5" />
                Sessions ({data.linked_conversations.length})
                {data.linked_conversations.some((c: any) => c.is_active) && (
                  <span className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 text-[10px]">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                    {data.linked_conversations.filter((c: any) => c.is_active).length} active
                  </span>
                )}
              </h2>
              <div className="border border-sol-border/30 rounded-lg divide-y divide-sol-border/20 overflow-hidden">
                {[...data.linked_conversations]
                  .sort((a: any, b: any) => {
                    if (a.is_active && !b.is_active) return -1;
                    if (!a.is_active && b.is_active) return 1;
                    return (b.updated_at || 0) - (a.updated_at || 0);
                  })
                  .map((conv: any) => (
                    <SessionCard key={conv._id} session={conv} />
                  ))}
              </div>
            </div>
          )}

          {/* Related Docs */}
          {data.related_docs && data.related_docs.length > 0 && (
            <div className="mb-6">
              <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wide mb-2">Related Documents</h2>
              <div className="border border-sol-border/30 rounded-lg divide-y divide-sol-border/20 overflow-hidden">
                {data.related_docs.map((doc: any) => (
                  <Link key={doc._id} href={`/docs/${doc._id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-sol-bg-alt/50 transition-colors">
                    <FileText className="w-4 h-4 text-sol-violet flex-shrink-0" />
                    <span className="text-sm text-sol-text truncate">{doc.title}</span>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0 text-sol-violet border-sol-violet/30 ml-auto">{doc.doc_type}</Badge>
                  </Link>
                ))}
              </div>
            </div>
          )}

          {/* Activity */}
          <div className="mb-6">
            <h2 className="text-sm font-semibold text-sol-text mb-3">Activity</h2>
            <div className="space-y-0">
              {[
                ...(data.history || []).map((h: any) => ({ type: "history" as const, ts: h.created_at, data: h })),
                ...(data.comments || []).map((c: any) => ({ type: "comment" as const, ts: c.created_at, data: c })),
              ]
                .sort((a, b) => a.ts - b.ts)
                .map((item) =>
                  item.type === "history" ? (
                    <HistoryItem key={item.data._id} entry={item.data} />
                  ) : (
                    <div key={item.data._id} className="py-2 flex gap-2.5">
                      <div className="w-5 h-5 rounded-full flex-shrink-0 bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center mt-0.5">
                        <MessageSquare className="w-3 h-3 text-sol-text-dim" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-0.5">
                          <span className="text-xs font-medium text-sol-text-muted">{item.data.author}</span>
                          {item.data.comment_type !== "note" && (
                            <Badge variant="outline" className="text-[10px] px-1">{item.data.comment_type}</Badge>
                          )}
                          <span className="text-[11px] text-sol-text-dim">{formatRelative(item.data.created_at)}</span>
                        </div>
                        <MarkdownRenderer content={item.data.text} className="text-sm text-sol-text-muted prose-sm prose-invert max-w-none" />
                      </div>
                    </div>
                  )
                )}
            </div>
          </div>

          {/* Comment input */}
          <div className="relative mb-2">
            <textarea
              ref={commentRef}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleAddComment();
                }
              }}
              placeholder="Leave a comment..."
              rows={2}
              className="w-full text-sm pl-4 pr-12 py-3 rounded-lg bg-sol-bg border border-sol-border/30 text-sol-text placeholder:text-sol-text-dim focus:outline-none focus:border-sol-border/60 resize-none"
            />
            <button
              onClick={handleAddComment}
              disabled={!comment.trim() || submittingComment}
              className="absolute right-2.5 bottom-2.5 w-7 h-7 flex items-center justify-center rounded-md bg-sol-cyan text-sol-bg hover:opacity-90 disabled:opacity-30 transition-opacity"
            >
              <ArrowUp className="w-4 h-4" />
            </button>
          </div>

        </div>
        </div>

        {/* Keyboard shortcuts footer */}
        <div className="flex-shrink-0 flex items-center gap-4 px-6 py-2 border-t border-sol-border/20 bg-sol-bg text-[10px] text-sol-text-dim">
          <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">{"⌫"}</kbd> back</span>
          <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">s</kbd> status</span>
          <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">p</kbd> priority</span>
          <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">l</kbd> labels</span>
          <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">e</kbd> edit title</span>
          <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">{"⌘K"}</kbd> cmd</span>
          <span className="ml-auto"><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">?</kbd> help</span>
        </div>

        {data && (
          <TaskCommandPalette
            open={cmdOpen}
            onClose={() => setCmdOpen(false)}
            targetTasks={[data as unknown as TaskItem]}
            initialMode={cmdMode}
            teamMembers={teamMembers}
            currentUser={currentUser}
          />
        )}

        {showHelp && (
          <div className="fixed inset-0 z-[300] flex items-center justify-center" onClick={() => setShowHelp(false)}>
            <div className="fixed inset-0 bg-black/50" />
            <div className="relative bg-sol-bg border border-sol-border rounded-xl shadow-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
              <h2 className="text-sm font-semibold text-sol-text mb-4">Keyboard Shortcuts</h2>
              <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-xs">
                {[
                  ["Backspace", "Go back to task list"],
                  ["Esc", "Go back to task list"],
                  ["s", "Change status"],
                  ["p", "Set priority"],
                  ["l", "Add labels"],
                  ["e", "Edit title"],
                  ["\u2318K", "Command palette"],
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
        </div>
      </DashboardLayout>
    </AuthGuard>
  );
}
