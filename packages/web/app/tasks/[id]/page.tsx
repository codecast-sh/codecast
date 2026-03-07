"use client";

import { useState, useCallback, useRef, useEffect, Fragment } from "react";
import { useParams, useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, TaskDetail, TaskItem } from "../../../store/inboxStore";
import { useSyncTaskDetail } from "../../../hooks/useSyncTasks";
import { TaskCommandPalette } from "../../../components/TaskCommandPalette";
import { MarkdownRenderer } from "../../../components/tools/MarkdownRenderer";
import { toast } from "sonner";
import { AuthGuard } from "../../../components/AuthGuard";
import { DashboardLayout } from "../../../components/DashboardLayout";

const api = _api as any;
import { Badge } from "../../../components/ui/badge";
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
  User,
  Bot,
  History,
  ChevronDown,
} from "lucide-react";

const STATUS_OPTIONS = [
  { key: "draft", icon: CircleDotDashed, label: "Draft", color: "text-sol-text-dim" },
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

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
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

export default function TaskDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  useSyncTaskDetail(id);

  const detail = useInboxStore((s) => s.taskDetails[id]) as TaskDetail | undefined;
  const listItem = useInboxStore((s) => s.tasks.find((t) => t._id === id));
  const data = detail || (listItem as TaskDetail | undefined);
  const updateTask = useInboxStore((s) => s.updateTask);
  const addTaskComment = useInboxStore((s) => s.addTaskComment);
  const webUpdate = useMutation(api.tasks.webUpdate);
  const webAddComment = useMutation(api.tasks.webAddComment);
  const [comment, setComment] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
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
    if (!comment.trim() || !data?.short_id) return;
    addTaskComment(data.short_id, comment.trim(), "note");
    setComment("");
    toast.success("Comment added");
    try {
      await webAddComment({ short_id: data.short_id, text: comment.trim(), comment_type: "note" });
    } catch {}
  }, [comment, data?.short_id, addTaskComment, webAddComment]);

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

  const openCmd = useCallback((mode: "root" | "status" | "priority" | "labels" | "assign") => {
    setCmdMode(mode);
    setCmdOpen(true);
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
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

              {data.creator && (
                <>
                  <span className="text-sol-text-dim py-1">Creator</span>
                  <div className="flex items-center gap-1.5 py-1">
                    <Avatar name={data.creator.name} image={data.creator.image} />
                    <span className="text-sol-text-muted">{data.creator.name}</span>
                    {data.source === "agent" && <span title="Agent"><Bot className="w-3 h-3 text-sol-violet" /></span>}
                    {data.source === "human" && <span title="User"><User className="w-3 h-3 text-sol-cyan" /></span>}
                  </div>
                </>
              )}

              {(data as any).assignee_info && (
                <>
                  <span className="text-sol-text-dim py-1">Assignee</span>
                  <div className="flex items-center gap-1.5 py-1">
                    <Avatar name={(data as any).assignee_info.name} image={(data as any).assignee_info.image} />
                    <span className="text-sol-text-muted">{(data as any).assignee_info.name}</span>
                  </div>
                </>
              )}

              {data.task_type && (
                <>
                  <span className="text-sol-text-dim py-1">Type</span>
                  <span className="text-sol-text-muted py-1 capitalize">{data.task_type}</span>
                </>
              )}

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
                    {data.labels.map((l: string) => (
                      <Badge key={l} variant="outline" className="text-[10px] border-sol-border/50 text-sol-text-muted">{l}</Badge>
                    ))}
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
          {data.description && (
            <div className="border border-sol-border/30 rounded-lg bg-sol-bg-alt/30 p-5 mb-6">
              <MarkdownRenderer content={data.description} className="text-sm text-sol-text leading-relaxed prose-sm prose-invert max-w-none" />
            </div>
          )}

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

          {/* Linked Sessions */}
          {data.linked_conversations && data.linked_conversations.length > 0 && (
            <div className="mb-6">
              <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wide mb-2">
                Linked Sessions ({data.linked_conversations.length})
              </h2>
              <div className="border border-sol-border/30 rounded-lg divide-y divide-sol-border/20 overflow-hidden">
                {data.linked_conversations.map((conv: any) => (
                  <Link
                    key={conv._id}
                    href={`/conversation/${conv._id}`}
                    className="flex items-center justify-between px-4 py-2.5 hover:bg-sol-bg-alt/50 transition-colors"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="text-sm font-medium text-sol-cyan">{conv.title || "Untitled Session"}</span>
                      {conv.project_path && (
                        <div className="flex items-center gap-1.5 mt-1 text-xs text-sol-text-dim">
                          <FolderGit2 className="w-3 h-3" />
                          <span className="font-mono truncate">{conv.project_path}</span>
                        </div>
                      )}
                      <div className="flex items-center gap-3 mt-1 text-xs text-sol-text-dim">
                        <span className="flex items-center gap-1"><MessageSquare className="w-3 h-3" />{conv.message_count} messages</span>
                        <span>{formatDate(conv.started_at)}</span>
                      </div>
                    </div>
                    <ExternalLink className="w-4 h-4 text-sol-text-dim flex-shrink-0" />
                  </Link>
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
          {data.history && data.history.length > 0 && (
            <div className="mb-6">
              <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <History className="w-3.5 h-3.5" /> Activity
              </h2>
              <div className="border border-sol-border/30 rounded-lg bg-sol-bg-alt/20 px-4 py-2 divide-y divide-sol-border/10">
                {data.history.map((h: any) => <HistoryItem key={h._id} entry={h} />)}
              </div>
            </div>
          )}

          {/* Comments */}
          {data.comments && data.comments.length > 0 && (
            <div className="mb-4">
              <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wide mb-2">
                Comments ({data.comments.length})
              </h2>
              <div className="space-y-2">
                {data.comments.map((c: any) => (
                  <div key={c._id} className="text-sm p-3 rounded-lg bg-sol-bg-alt border border-sol-border/20">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-sol-text">{c.author}</span>
                      <span className="text-xs text-sol-text-dim">{formatRelative(c.created_at)}</span>
                      {c.comment_type !== "note" && (
                        <Badge variant="outline" className="text-[10px] px-1">{c.comment_type}</Badge>
                      )}
                    </div>
                    <MarkdownRenderer content={c.text} className="text-sm text-sol-text-muted prose-sm prose-invert max-w-none" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Comment input */}
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
              className="px-4 py-2 text-sm rounded-lg bg-sol-cyan text-sol-bg hover:opacity-90 disabled:opacity-40 transition-opacity"
            >
              Send
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
