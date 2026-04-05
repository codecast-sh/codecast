"use client";
import { useState, useCallback, useRef, useMemo } from "react";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, TaskDetail, TaskItem } from "../../../store/inboxStore";
import { useSyncTasks, useSyncTaskDetail } from "../../../hooks/useSyncTasks";
import { DetailSplitLayout } from "../../../components/DetailSplitLayout";
import { TaskListContent } from "../page";
import { useMentionQuery } from "../../../hooks/useMentionQuery";
import { useImageUpload } from "../../../hooks/useImageUpload";
// TaskCommandPalette replaced by unified CommandPalette
import { WorkflowContextPanel } from "../../../components/WorkflowContextPanel";
import { MarkdownRenderer } from "../../../components/tools/MarkdownRenderer";
import { DocEditor } from "../../../components/editor/DocEditor";
import "../../../components/editor/editor.css";
import { toast } from "sonner";
import { AuthGuard } from "../../../components/AuthGuard";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { ContextChatInput } from "../../../components/ContextChatInput";
import { SessionCardInner } from "../../../components/ActivityFeed";
import { WatchButton } from "../../../components/WatchButton";

const api = _api as any;
import { Badge } from "../../../components/ui/badge";
import { TaskStatusBadge } from "../../../components/TaskStatusBadge";
import { getLabelColor } from "../../../lib/labelColors";
import Link from "next/link";
import {
  Circle,
  CircleDot,
  CircleDotDashed,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  Minus,
  FileText,
  Clock,
  Zap,
  Bot,
  ChevronDown,
  Radio,
  FileCode,
  ListChecks,
  ShieldCheck,
  ImagePlus,
  MessageSquare,
  X,
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

function ClaudeIcon({ size = "sm" }: { size?: "sm" | "md" }) {
  const px = size === "md" ? "w-7 h-7" : "w-5 h-5";
  const svg = size === "md" ? "w-4 h-4" : "w-3 h-3";
  return (
    <span className={`${px} rounded bg-sol-orange flex items-center justify-center shrink-0`}>
      <svg className={`${svg} text-sol-bg`} viewBox="0 0 24 24" fill="currentColor">
        <path d="M17.3041 3.541h-3.6718l6.696 16.918H24L17.3041 3.541Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409H6.696Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456H6.3247Z" />
      </svg>
    </span>
  );
}

function Avatar({ name, image, size = "sm" }: { name: string; image?: string; size?: "sm" | "md" }) {
  if (name.toLowerCase() === "claude") return <ClaudeIcon size={size} />;
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


function UserBadge({ name, image, username }: { name: string; image?: string; username?: string }) {
  const content = (
    <span className={`inline-flex items-center gap-1.5 flex-shrink-0 ${username ? "hover:opacity-80 cursor-pointer" : ""}`}>
      <Avatar name={name} image={image} />
      <span className="text-xs text-sol-text font-medium">{name.split(" ")[0]}</span>
    </span>
  );
  if (username) {
    return <Link href={`/team/${username}`}>{content}</Link>;
  }
  return content;
}

function HistoryItem({ entry }: { entry: any }) {
  const statusCfg = entry.field === "status" ? STATUS_MAP[entry.new_value] : null;
  return (
    <div className="flex items-center gap-2 text-[11px] py-1 min-w-0">
      {entry.actor ? (
        <UserBadge name={entry.actor.name} image={entry.actor.image} username={entry.actor.github_username} />
      ) : (
        <span className="inline-flex items-center gap-1.5 flex-shrink-0">
          <div className="w-5 h-5 rounded-full flex-shrink-0 bg-sol-bg-highlight border border-sol-border/50 flex items-center justify-center">
            <Bot className="w-3 h-3 text-sol-text-dim" />
          </div>
          <span className="text-sol-text font-medium">System</span>
        </span>
      )}
      {entry.action === "created" ? (
        <span className="text-gray-400">created this task</span>
      ) : entry.field === "status" && statusCfg ? (
        <>
          <span className="text-gray-400">changed status to</span>
          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 opacity-50 ${statusCfg.color} border-current/30`}>
            {statusCfg.label}
          </Badge>
        </>
      ) : entry.field === "assignee" ? (
        <>
          <span className="text-gray-400">assigned to</span>
          {entry.new_value_resolved ? (
            <UserBadge name={entry.new_value_resolved.name} image={entry.new_value_resolved.image} username={entry.new_value_resolved.github_username} />
          ) : entry.new_value ? (
            <code className="text-[10px] px-1.5 py-0.5 rounded bg-sol-bg-highlight text-gray-500 font-mono">{entry.new_value.slice(0, 8)}...</code>
          ) : (
            <span className="text-gray-400 italic">nobody</span>
          )}
        </>
      ) : (
        <>
          <span className="text-gray-400">changed {entry.field}</span>
          {entry.old_value && <span className="text-gray-300 line-through">{entry.old_value}</span>}
          <span className="text-gray-300">&rarr;</span>
          <span className="text-gray-500">{entry.new_value}</span>
        </>
      )}
      <span className="ml-auto flex-shrink-0 text-gray-300">{formatRelative(entry.created_at)}</span>
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
  return (
    <AuthGuard>
      <DashboardLayout>
        <DetailSplitLayout list={<TaskListContent />}>
          <ErrorBoundary name="TaskDetail" level="panel">
            <TaskDetailContent />
          </ErrorBoundary>
        </DetailSplitLayout>
      </DashboardLayout>
    </AuthGuard>
  );
}

function TaskDetailContent() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const directData = useSyncTaskDetail(id);
  useSyncTasks();

  const allTasks = useInboxStore((s) => s.tasks);
  const data = (allTasks[id] || Object.values(allTasks).find((t: any) => t.short_id === id) || directData) as TaskDetail | undefined;
  const taskTeamId = data?.team_id as string | undefined;
  const handleMentionQuery = useMentionQuery();
  const handleImageUpload = useImageUpload();
  const updateTask = useInboxStore((s) => s.updateTask);
  const openSidePanel = useInboxStore((s) => s.openSidePanel);
  const webUpdate = useMutation(api.tasks.webUpdate);
  const webAddComment = useMutation(api.tasks.webAddComment);
  const currentUser = useQuery(api.users.getCurrentUser);
  const teamMembers = useQuery(api.teams.getTeamMembers, taskTeamId ? { team_id: taskTeamId as any } : "skip");
  const teamInfo = useQuery(api.teams.getTeam, taskTeamId ? { team_id: taskTeamId as any } : "skip");
  const [comment, setComment] = useState("");
  const [submittingComment, setSubmittingComment] = useState(false);
  const [commentImages, setCommentImages] = useState<Array<{ file: File; previewUrl: string; storageId?: string; uploading: boolean }>>([]);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const generateUploadUrl = useMutation(api.images.generateUploadUrl);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const openPalette = useInboxStore((s) => s.openPalette);
  const paletteOpen = useInboxStore((s) => s.palette.open);
  const shortcutsPanelOpen = useInboxStore(s => s.shortcutsPanelOpen);
  const [commentOpen, setCommentOpen] = useState(false);

  const handleUpdate = useCallback(async (fields: Record<string, any>) => {
    if (!data?.short_id) return;
    updateTask(data.short_id, fields);
    try {
      await webUpdate({ short_id: data.short_id, ...fields });
    } catch {}
  }, [data?.short_id, updateTask, webUpdate]);

  const uploadCommentImage = useCallback(async (file: File) => {
    const previewUrl = URL.createObjectURL(file);
    setCommentImages(prev => [...prev, { file, previewUrl, uploading: true }]);
    try {
      const uploadUrl = await generateUploadUrl({});
      const result = await fetch(uploadUrl, { method: "POST", headers: { "Content-Type": file.type }, body: file });
      if (!result.ok) throw new Error(`Upload failed: ${result.status} ${result.statusText}`);
      const { storageId } = await result.json();
      setCommentImages(prev => prev.map(img => img.previewUrl === previewUrl ? { ...img, storageId, uploading: false } : img));
    } catch (err: any) {
      console.error("[uploadCommentImage] failed:", err);
      toast.error(`Failed to upload image: ${err?.message || "unknown error"}`);
      URL.revokeObjectURL(previewUrl);
      setCommentImages(prev => prev.filter(img => img.previewUrl !== previewUrl));
    }
  }, [generateUploadUrl]);

  const clearCommentImage = useCallback((idx: number) => {
    setCommentImages(prev => {
      const img = prev[idx];
      if (img) URL.revokeObjectURL(img.previewUrl);
      return prev.filter((_, i) => i !== idx);
    });
  }, []);

  const handleCommentPaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        e.preventDefault();
        const file = items[i].getAsFile();
        if (file) uploadCommentImage(file);
      }
    }
  }, [uploadCommentImage]);

  const handleAddComment = useCallback(async () => {
    const hasText = comment.trim().length > 0;
    const hasImages = commentImages.some(i => i.storageId);
    if ((!hasText && !hasImages) || !data?.short_id || submittingComment) return;
    const anyUploading = commentImages.some(i => i.uploading);
    if (anyUploading) { toast.error("Wait for images to finish uploading"); return; }
    const text = comment.trim() || "(image)";
    const imageIds = commentImages.filter(i => i.storageId).map(i => i.storageId!);
    setComment("");
    setCommentImages([]);
    setSubmittingComment(true);
    try {
      await webAddComment({ short_id: data.short_id, text, comment_type: "note", image_storage_ids: imageIds.length > 0 ? imageIds : undefined });
      setCommentOpen(false);
    } catch {
      setComment(text);
      toast.error("Failed to add comment");
    } finally {
      setSubmittingComment(false);
    }
  }, [comment, commentImages, data?.short_id, submittingComment, webAddComment]);

  const getTaskContextBody = useCallback(() => {
    if (!data) return "";
    const parts: string[] = [];
    if (data.short_id) parts.push(`ID: ${data.short_id}`);
    if (data.status) parts.push(`Status: ${data.status}`);
    if (data.priority) parts.push(`Priority: ${data.priority}`);
    if (data.description) parts.push(`\n${data.description}`);
    if ((data as any).acceptance_criteria?.length) parts.push(`\nAcceptance Criteria:\n${(data as any).acceptance_criteria.map((c: string) => `- ${c}`).join("\n")}`);
    return parts.join("\n");
  }, [data]);

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


  const openCmd = useCallback((mode: string) => {
    if (!data) return;
    openPalette({ targets: [data as unknown as TaskItem], targetType: 'task', mode });
  }, [data, openPalette]);

  useWatchEffect(() => {
    if (paletteOpen) return;
    if (shortcutsPanelOpen) return;
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

      const stop = () => { e.preventDefault(); };

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
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [paletteOpen, shortcutsPanelOpen, data, openCmd, startEditTitle, router]);

  if (!data) {
    return <div className="flex items-center justify-center h-64 text-sol-text-dim text-sm">Loading...</div>;
  }

  const status = STATUS_MAP[data.status] || STATUS_MAP.open;
  const StatusIcon = status.icon;

  return (
        <div
          className="flex-1 h-full flex flex-col relative min-w-0"
          onDragEnter={(e) => { e.preventDefault(); dragCounterRef.current++; setIsDragging(true); }}
          onDragOver={(e) => { e.preventDefault(); }}
          onDragLeave={(e) => { e.preventDefault(); dragCounterRef.current--; if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setIsDragging(false); } }}
          onDrop={(e) => { e.preventDefault(); dragCounterRef.current = 0; setIsDragging(false); const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/")); files.forEach(f => uploadCommentImage(f)); }}
        >
        {isDragging && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-sol-bg/80 border-2 border-dashed border-sol-cyan rounded-xl pointer-events-none">
            <p className="text-sol-cyan text-sm font-medium">Drop images to attach</p>
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col min-h-full">
        <div className="flex-1 max-w-4xl mx-auto px-6 py-6 w-full">
          <div className="flex items-center justify-between mb-4">
            <Link
              href="/tasks"
              className="inline-flex items-center gap-1.5 text-sm text-sol-text-dim hover:text-sol-cyan transition-colors"
            >
              Tasks
            </Link>
            <button
              onClick={() => router.push("/tasks")}
              className="p-1 rounded-md text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-colors"
              title="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Title row */}
          <div className="flex items-start gap-3 mb-3">
            <StatusIcon className={`w-5 h-5 mt-1.5 flex-shrink-0 ${status.color}`} />
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 text-xs text-sol-text-dim mb-1">
                <span className="font-mono">{data.short_id}</span>
                {teamInfo && (
                  <span className="px-1.5 py-0.5 rounded bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/20">
                    {teamInfo.name}
                  </span>
                )}
                {!taskTeamId && (
                  <span className="px-1.5 py-0.5 rounded bg-sol-text-dim/10 text-sol-text-dim border border-sol-text-dim/20">
                    Personal
                  </span>
                )}
                {data.source === "insight" && (
                  <span className="px-1.5 py-0.5 rounded bg-sol-violet/10 text-sol-violet border border-sol-violet/20">
                    mined
                  </span>
                )}
                <WatchButton entityType="task" entityId={data._id} />
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
          <div className="border-t border-b border-sol-border/30 mb-6">
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
                        <Link key={l} href={`/tasks?label=${encodeURIComponent(l)}`} className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full border ${lc.bg} ${lc.border} ${lc.text} hover:brightness-90 transition-all cursor-pointer`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${lc.dot}`} />
                          {l}
                        </Link>
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
                {data.linked_conversations?.[0]?.title || data.linked_conversations?.[0]?.headline || "session"}
              </Link>
            </div>
          )}

          {/* Description */}
          <div className="mb-6">
            <DocEditor
              key={`desc-${data._id}`}
              content={data.description || ""}
              onUpdate={(md) => {
                if (md.trim() !== (data.description || "").trim()) {
                  handleUpdate({ description: md });
                }
              }}
              onMentionQuery={handleMentionQuery}
              onImageUpload={handleImageUpload}
              editable={true}
              placeholder="Add a description..."
            />
          </div>

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
              <div className="space-y-1.5">
                {[...data.linked_conversations]
                  .sort((a: any, b: any) => {
                    if (a.is_active && !b.is_active) return -1;
                    if (!a.is_active && b.is_active) return 1;
                    return (b.updated_at || 0) - (a.updated_at || 0);
                  })
                  .map((conv: any) => (
                    <SessionCardInner
                      key={conv._id}
                      item={{ ...conv, conversation_id: conv._id, status: conv.is_active ? "active" : conv.status }}
                      compact
                      onNavigate={(id) => openSidePanel(id)}
                    />
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
                    <div key={item.data._id} className="py-2.5">
                      <div className="flex items-center gap-2 mb-1.5">
                        <UserBadge name={item.data.author} image={item.data.author_image} />
                        {item.data.comment_type !== "note" && (
                          <Badge variant="outline" className="text-[10px] px-1">{item.data.comment_type}</Badge>
                        )}
                        <span className="text-[11px] text-gray-400">{formatRelative(item.data.created_at)}</span>
                      </div>
                      <div className="ml-[26px] border-l-2 border-sol-border/30 pl-3">
                        <MarkdownRenderer content={item.data.text} className="text-sm text-sol-text prose-sm prose-invert max-w-none" />
                      </div>
                    </div>
                  )
                )}
            </div>
          </div>

          {/* Comment input */}
          <div className="mb-2">
            {!commentOpen ? (
              <button
                type="button"
                onClick={() => {
                  setCommentOpen(true);
                  setTimeout(() => commentRef.current?.focus(), 0);
                }}
                className="flex items-center gap-2 text-xs font-medium px-3 py-1.5 rounded-lg border border-sol-border text-sol-text-muted bg-sol-bg-alt/50 hover:text-sol-text hover:bg-sol-bg-alt transition-colors"
              >
                <MessageSquare className="w-3.5 h-3.5" />
                Add comment
              </button>
            ) : (
              <div className="flex flex-col border px-3 py-2 rounded-xl bg-sol-bg-alt border-sol-border/50">
                {commentImages.length > 0 && (
                  <div className="flex items-center gap-2 pb-2 mb-2 border-b border-sol-border/50 flex-wrap">
                    {commentImages.map((img, idx) => (
                      <div key={idx} className="relative group cursor-pointer">
                        <div className="relative h-16 w-16 rounded-lg overflow-hidden bg-sol-bg shrink-0">
                          <img src={img.previewUrl} alt="Attached" className="h-full w-full object-cover" />
                          {img.uploading && (
                            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
                              <svg className="w-5 h-5 animate-spin text-white" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                              </svg>
                            </div>
                          )}
                        </div>
                        <button type="button" onClick={() => clearCommentImage(idx)} className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-sol-bg-alt border border-sol-border flex items-center justify-center text-sol-text-dim hover:text-sol-text transition-colors opacity-0 group-hover:opacity-100">
                          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <label className="shrink-0 cursor-pointer text-sol-text-dim hover:text-sol-text transition-colors py-1 flex items-center">
                    <ImagePlus className="w-4 h-4" />
                    <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { Array.from(e.target.files || []).forEach(f => uploadCommentImage(f)); e.target.value = ""; }} />
                  </label>
                  <textarea
                    ref={commentRef}
                    value={comment}
                    onChange={(e) => setComment(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleAddComment();
                      }
                      if (e.key === "Escape") {
                        if (!comment.trim() && commentImages.length === 0) setCommentOpen(false);
                      }
                    }}
                    onPaste={handleCommentPaste}
                    placeholder="Leave a comment..."
                    rows={1}
                    className="flex-1 bg-transparent text-sm placeholder:text-sol-text-dim focus:outline-none resize-none overflow-hidden leading-relaxed py-1 text-sol-text"
                  />
                  <div className="shrink-0">
                    <button
                      onClick={handleAddComment}
                      disabled={(!comment.trim() && !commentImages.some(i => i.storageId)) || submittingComment}
                      className={`w-7 h-7 rounded-full transition-colors flex items-center justify-center border ${(!comment.trim() && !commentImages.some(i => i.storageId)) || submittingComment ? "border-sol-border/30 text-sol-text-dim/25 cursor-not-allowed" : "border-sol-blue/50 bg-sol-blue/20 text-sol-blue hover:bg-sol-blue/30 hover:border-sol-blue"}`}
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

        </div>
        <ContextChatInput
          contextType="task"
          contextTitle={data.title}
          getContextBody={getTaskContextBody}
          linkedObjectId={data._id}
        />
        </div>
        </div>

        {/* Keyboard shortcuts footer */}
        <div className="flex-shrink-0 flex items-center gap-4 px-6 py-2 border-t border-sol-border/20 bg-sol-bg text-[10px] text-sol-text-dim">
          <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">j</kbd><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono ml-0.5">k</kbd> navigate</span>
          <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">{"⌫"}</kbd> back</span>
          <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">s</kbd> status</span>
          <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">p</kbd> priority</span>
          <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">l</kbd> labels</span>
          <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">e</kbd> edit title</span>
          <span><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">{"⌘K"}</kbd> cmd</span>
          <span className="ml-auto"><kbd className="px-1 py-0.5 rounded bg-sol-bg-alt border border-sol-border/40 font-mono">?</kbd> help</span>
        </div>

        {/* Unified palette is global via DashboardLayout */}

        </div>
  );
}
