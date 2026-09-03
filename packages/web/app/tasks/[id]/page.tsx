"use client";
import { useState, useCallback, useMemo, useRef, type ReactNode } from "react";
import { copyToClipboard, canonicalUrl, formatDateFull } from "../../../lib/utils";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { useParams, useRouter } from "next/navigation";
import { useInboxStore, TaskDetail, TaskItem, resolveAssigneeInfo } from "../../../store/inboxStore";
import { resolveTaskLinkedConversations, resolveTaskRelatedDocs, taskLinkedConversationIds } from "../../../lib/liveEntities";
import { useWorkspaceCollection } from "../../../hooks/useWorkspaceCollection";
import { useSyncTasks, useSyncTaskDetail } from "../../../hooks/useSyncTasks";
import { useSyncTaskGitEvents, useGitEvents, gitEventsOldestFirst } from "../../../hooks/useSyncGitEvents";
import { ExternalEventRow } from "../../../components/feed/ExternalEventRow";
import { gitEventToExternalEvent, type GitEventRow } from "../../../lib/externalEvents";
import { useOpenLinkedSession } from "../../../hooks/useOpenLinkedSession";
import { DetailSplitLayout } from "../../../components/DetailSplitLayout";
import { AppLoader } from "../../../components/AppLoader";
import { TaskListContent } from "../page";
import { useMentionQuery, useActiveMentionScope } from "../../../hooks/useMentionQuery";
import { useImageUpload } from "../../../hooks/useImageUpload";
// TaskCommandPalette replaced by unified CommandPalette
import { WorkflowContextPanel } from "../../../components/WorkflowContextPanel";
import { DocEditor } from "../../../components/editor/DocEditor";
import "../../../components/editor/editor.css";
import { toast } from "sonner";
import { AuthGuard } from "../../../components/AuthGuard";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { ContextChatInput } from "../../../components/ContextChatInput";
import { FeedCard } from "../../../components/ActivityFeed";
import { AgentIcon } from "../../../components/ConversationList";
import { Avatar, TaskCommentComposer, TaskCommentItem, TimeAgo, UserBadge } from "../../../components/tasks/TaskCommentStream";
import { WatchButton } from "../../../components/WatchButton";
import { Badge } from "../../../components/ui/badge";
import { TaskStatusBadge } from "../../../components/TaskStatusBadge";
import { getLabelColor } from "../../../lib/labelColors";
import Link from "next/link";
import { projectDotClass } from "../../../lib/projectColors";
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
  MessageSquare,
  X,
  ExternalLink,
  MoreHorizontal,
  Plus,
  CornerDownRight,
  Forward,
} from "lucide-react";
import { openForwardToChat } from "../../../lib/forwardToChat";
import { useTeamFeature } from "../../../lib/teamFeatures";
import { MAX_TASK_DEPTH, directChildren, isActiveTask, subtaskProgressOf, taskDepth } from "@codecast/shared/tasks";
import { closeTaskWithGuard, createTaskAndAdopt, setTaskParent } from "../../../lib/taskActions";
import { statusByKey, statusEntityOptions, statusVisual, statusWriteFields, taskStatusKey, taskStatusOf, useTeamTaskStatusList } from "../../../lib/taskStatuses";

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

// The doc fields the related-docs list renders; a body edit must not wake it.
function docOriginSig(d: any): string {
  return `${d.conversation_id}:${d.archived_at ?? ""}:${d.display_title ?? d.title}:${d.doc_type}`;
}

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  const color = pct >= 80 ? "bg-sol-green" : pct >= 50 ? "bg-sol-yellow" : "bg-sol-orange";
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="w-20 h-1.5 rounded-full bg-sol-bg-highlight overflow-hidden">
        <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sol-text-muted text-xs tabular-nums">{pct}%</span>
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


// Header ⋯ menu for secondary actions that don't earn a slot in the narrow
// header row (watch state lives here). Clicking an item closes the menu.
function OverflowMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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
        onClick={() => setOpen(!open)}
        className={`p-1 rounded-md transition-colors hover:bg-sol-bg-alt ${open ? "text-sol-text bg-sol-bg-alt" : "text-sol-text-dim hover:text-sol-text"}`}
        title="More actions"
      >
        <MoreHorizontal className="w-4 h-4" />
      </button>
      {open && (
        <div
          className="absolute top-full right-0 mt-1 w-44 bg-sol-bg border border-sol-border rounded-lg shadow-xl z-50 py-1 overflow-hidden"
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      )}
    </div>
  );
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
      <TimeAgo ts={entry.created_at} className="ml-auto flex-shrink-0 text-gray-300" />
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
        <Zap className="w-3.5 h-3.5" />
        Execution
        {data.execution_status && (
          <TaskStatusBadge status={data.execution_status} type="execution" className="normal-case tracking-normal" />
        )}
      </h2>
      <div className="border border-sol-border/30 rounded-lg bg-sol-bg-alt/20 p-4 space-y-4 border-l-2 border-l-sol-cyan/30">
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
            <div className="space-y-0.5 pl-1 border-l-2 border-sol-border/20">
              {data.files_changed.map((f: string) => {
                const parts = f.split("/");
                const fileName = parts.pop();
                const dirPath = parts.join("/");
                return (
                  <div key={f} className="flex items-center gap-1.5 text-xs font-mono py-0.5 pl-2 hover:bg-sol-bg-alt/20 rounded-r transition-colors group">
                    <FileText className="w-3 h-3 text-sol-text-dim/50 flex-shrink-0" />
                    {dirPath && <span className="text-sol-text-dim/50 truncate">{dirPath}/</span>}
                    <span className="text-sol-text-muted">{fileName}</span>
                  </div>
                );
              })}
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
        <DetailSplitLayout list={<TaskListContent />} closeHref="/tasks">
          <ErrorBoundary name="TaskDetail" level="panel">
            <TaskDetailContent />
          </ErrorBoundary>
        </DetailSplitLayout>
      </DashboardLayout>
    </AuthGuard>
  );
}

// Linear's sub-issue section, store-driven: progress header, live rows, and a
// quick-add whose focus survives Enter so decomposing into five subtasks is
// five titles and five Enters. Always rendered — an empty parent shows the
// input, otherwise the feature can never bootstrap from the UI.
function SubtasksSection({ task, requestClose, onNavigate }: {
  task: TaskDetail;
  requestClose: (shortId: string, status: "done" | "dropped") => void;
  onNavigate: (id: string) => void;
}) {
  const allTasks = useInboxStore((s) => s.tasks);
  const updateTask = useInboxStore((s) => s.updateTask);
  // Subtasks share the parent's workspace, so one vocabulary covers the list.
  const taskStatuses = useTeamTaskStatusList((task as any)?.team_id);
  const [title, setTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const children = useMemo(
    () =>
      directChildren(Object.values(allTasks) as TaskItem[], task._id)
        .filter((t: any) => isActiveTask(t))
        .sort((a: any, b: any) => (a.created_at || 0) - (b.created_at || 0)),
    [allTasks, task._id],
  );
  const progress = useMemo(() => subtaskProgressOf(children as any[]), [children]);
  const pct = progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  // A subtask can't be added below the depth cap — the server would refuse and
  // strand a ghost. Compute this task's depth from the store and hide the input.
  const atMaxDepth = useMemo(() => {
    const byId = new Map((Object.values(allTasks) as TaskItem[]).map((t) => [String(t._id), t]));
    const parentOf = (id: string) => { const p = byId.get(String(id))?.parent_id; return p ? String(p) : undefined; };
    return taskDepth(String(task._id), parentOf) >= MAX_TASK_DEPTH;
  }, [allTasks, task._id]);

  const submit = () => {
    const t = title.trim();
    if (!t) return;
    setTitle("");
    // The stub renders instantly; the altKey supersede swaps in the real row on
    // the ack, and a refusal cleans the stub up (createTaskAndAdopt).
    void createTaskAndAdopt({ title: t, parent: task.short_id });
    inputRef.current?.focus();
  };

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-2">
        <div className="text-xs font-medium text-sol-text-dim">Subtasks</div>
        {progress.total > 0 && (
          <>
            <span className="text-[11px] font-mono text-sol-text-muted">{progress.done}/{progress.total}</span>
            <div className="flex-1 max-w-[8rem] h-1 rounded-full bg-sol-border/30 overflow-hidden">
              <div className="h-full bg-sol-green transition-all" style={{ width: `${pct}%` }} />
            </div>
          </>
        )}
      </div>
      <div className="space-y-0.5">
        {children.map((t: any) => {
          const cfg = statusVisual(taskStatusOf(t, taskStatuses), taskStatuses);
          const RowIcon = cfg.icon;
          const closed = t.status === "done" || t.status === "dropped";
          // A stub whose server row hasn't synced yet has no real id/short_id —
          // navigating to it or toggling its status would hit a dead page or a
          // no-op lookup, so render it inert until the altKey supersede swaps
          // in the real row.
          const pending = String(t._id).startsWith("temp_");
          return (
            <div key={t._id} className="group flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-sol-bg-alt/50 transition-colors">
              <button
                onClick={() => { if (pending) return; closed ? updateTask(t.short_id, { status: "open" }) : requestClose(t.short_id, "done"); }}
                className="flex-shrink-0 hover:scale-125 transition-transform disabled:opacity-50"
                disabled={pending}
                title={pending ? "Saving…" : closed ? "Reopen" : "Mark done"}
              >
                <RowIcon className={`w-3.5 h-3.5 ${cfg.color}`} />
              </button>
              <span className="text-[11px] font-mono text-sol-text-dim flex-shrink-0">{pending ? "…" : t.short_id}</span>
              {pending ? (
                <span className="flex-1 min-w-0 text-left text-xs truncate text-sol-text-dim">{t.title}</span>
              ) : (
                <button
                  onClick={() => onNavigate(t._id)}
                  className={`flex-1 min-w-0 text-left text-xs truncate transition-colors ${closed ? "text-sol-text-dim line-through" : "text-sol-text hover:text-sol-cyan"}`}
                >
                  {t.title}
                </button>
              )}
              {t.source !== "human" && t.source !== "meeting" && (
                <Bot className="w-3 h-3 text-sol-text-dim/60 flex-shrink-0" />
              )}
              {t.assignee_info?.name && (
                <span className="text-[10px] text-sol-text-dim flex-shrink-0">{t.assignee_info.name}</span>
              )}
            </div>
          );
        })}
      </div>
      {atMaxDepth ? (
        <div className="px-1.5 py-1 mt-0.5 text-[11px] text-sol-text-dim">
          Deepest level — add further steps under a higher-level task.
        </div>
      ) : (
      <div className="flex items-center gap-2 px-1.5 py-1 mt-0.5">
        <Plus className="w-3.5 h-3.5 text-sol-text-dim flex-shrink-0" />
        <input
          ref={inputRef}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") { setTitle(""); (e.target as HTMLInputElement).blur(); }
            e.stopPropagation();
          }}
          placeholder="Add subtask…"
          className="flex-1 bg-transparent text-xs text-sol-text placeholder:text-sol-text-dim outline-none py-0.5"
        />
      </div>
      )}
    </div>
  );
}

export function TaskDetailContent({ taskId, variant = "page", onClose, onOpen }: { taskId?: string; variant?: "page" | "inline"; onClose?: () => void; onOpen?: () => void } = {}) {
  const params = useParams();
  const router = useRouter();
  const openLinkedSession = useOpenLinkedSession();
  const chatOn = useTeamFeature("chat");
  const id = taskId ?? (params?.id as string);
  const isInline = variant === "inline";

  const directData = useSyncTaskDetail(id);
  useSyncTasks();

  const allTasks = useInboxStore((s) => s.tasks);
  const data = (allTasks[id] || Object.values(allTasks).find((t: any) => t.short_id === id) || directData) as TaskDetail | undefined;
  const taskTeamId = data?.team_id as string | undefined;
  // The task's team status vocabulary (per-team custom statuses).
  const taskStatuses = useTeamTaskStatusList(taskTeamId);
  const statusOptions = useMemo(() => statusEntityOptions(taskStatuses), [taskStatuses]);
  // The id may be a conversation's (legacy phantom-task cache rows, malformed
  // /tasks/<conversationId> links). When the server says "not a task" and the
  // id is a session we know, land in the conversation instead of a dead-end.
  const sessionForBadId = useInboxStore((s) => (directData === null ? s.sessions[id] : undefined));
  useWatchEffect(() => {
    if (!isInline && directData === null && sessionForBadId) {
      router.replace(`/conversation/${id}`);
    }
  }, [isInline, directData, sessionForBadId, id, router]);
  const handleMentionQuery = useMentionQuery(useActiveMentionScope());
  const handleImageUpload = useImageUpload();
  const updateTask = useInboxStore((s) => s.updateTask);
  // Viewer, roster and team all live in the store (fed app-wide), so the chips
  // paint on the first frame. The roster is the ACTIVE team's; an assignee
  // outside it falls back to the row's assignee_info (resolveAssigneeInfo).
  // A task is only readable by its team's members, so the viewer's own team
  // list always contains the task's team.
  const currentUser = useInboxStore((s) => s.currentUser);
  const teamMembers = useInboxStore((s) => s.teamMembers.length > 0 ? s.teamMembers : null);
  const storeTeams = useInboxStore((s) => s.teams);
  const teamInfo = useMemo(
    () => (taskTeamId ? storeTeams.find((t: any) => String(t._id) === taskTeamId) ?? null : null),
    [storeTeams, taskTeamId],
  );
  // The project this task is filed under — omitted when the surface around it is
  // already that project, so the chip never repeats the breadcrumb above it.
  const allProjects = useInboxStore((s) => s.projects);
  const taskProject = useMemo(() => {
    const pid = (data as any)?.project_id;
    if (!pid || params?.id === pid) return null;
    return (allProjects as any)[pid] ?? null;
  }, [allProjects, data, params?.id]);
  // Derived so an optimistic re-assignment shows instantly (see resolveAssigneeInfo).
  const assigneeInfo = resolveAssigneeInfo((data as any)?.assignee, (data as any)?.assignee_info, teamMembers as any[], currentUser);
  // Linked sessions and related docs paint from the store on the first frame:
  // the detail snapshot when cached, else the sessions/origin badges/docs the
  // client already holds (resolveTaskLinkedConversations). Sessions churn on
  // every heartbeat, so subscribe to a signature of the rendered fields, not
  // the rows.
  const linkedIds = useMemo(() => taskLinkedConversationIds(data), [data?.created_from_conversation, (data as any)?.conversation_ids]);
  const linkedSig = useInboxStore((s) => linkedIds.map((cid) => {
    const r = s.sessions[cid];
    if (r) return `${cid}:${r.title}:${r.is_idle}:${r.updated_at}:${r.message_count}`;
    return s.taskOriginBadges[cid] ? `${cid}:badge` : "";
  }).join("|"));
  // eslint-disable-next-line react-hooks/exhaustive-deps -- linkedSig stands in for the churny sessions ref
  const linkedConversations = useMemo(() => {
    const s = useInboxStore.getState();
    return resolveTaskLinkedConversations(data, s.sessions, s.taskOriginBadges);
  }, [data?.linked_conversations, linkedIds, linkedSig]);
  // Git events for this task are their own synced collection: mount the task
  // feeder and read the store, never the query. The route id may be the short
  // id, so match on both it and the convex id.
  const taskConvexId = (data as any)?._id as string | undefined;
  useSyncTaskGitEvents(taskConvexId);
  const gitWhere = useMemo(
    () => (row: GitEventRow) =>
      (!!taskConvexId && (row.task_id === taskConvexId || !!row.task_ids?.includes(taskConvexId))) ||
      row.task_id === id ||
      !!row.task_ids?.includes(id),
    [taskConvexId, id],
  );
  const gitEvents = useGitEvents(gitWhere, gitEventsOldestFirst);
  const wsDocs = useWorkspaceCollection("docs", docOriginSig);
  const relatedDocs = useMemo(() => {
    const docs: Record<string, any> = {};
    for (const d of wsDocs) docs[d._id] = d;
    return resolveTaskRelatedDocs(data, docs);
  }, [data?.related_docs, data?.created_from_conversation, wsDocs]);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleRef = useRef<HTMLInputElement>(null);
  const openPalette = useInboxStore((s) => s.openPalette);
  const paletteOpen = useInboxStore((s) => s.palette.open);
  const shortcutsPanelOpen = useInboxStore(s => s.shortcutsPanelOpen);

  const handleUpdate = useCallback((fields: Record<string, any>) => {
    if (!data?.short_id) return;
    updateTask(data.short_id, fields);
  }, [data?.short_id, updateTask]);

  // Close-guard flow: any human move to done/dropped goes through the single
  // gateway; a parent with open subtasks opens the shared dialog (rendered once
  // in DashboardLayout) instead of writing anything.
  const requestClose = useCallback((shortId: string, status: "done" | "dropped") => {
    closeTaskWithGuard(shortId, status);
  }, []);
  const handleStatusChange = useCallback((v: string) => {
    if (!data?.short_id) return;
    // v is a team status id (dropdown options come from statusEntityOptions).
    const picked = statusByKey(taskStatuses, v);
    if (!picked) return;
    const fields = statusWriteFields(picked);
    if (fields.status === "done" || fields.status === "dropped") {
      closeTaskWithGuard(data.short_id, fields.status, undefined, fields.status_id);
    } else {
      handleUpdate(fields);
    }
  }, [data?.short_id, taskStatuses, handleUpdate]);

  // Parent breadcrumb + set-parent state. The parent row resolves live from
  // the store so a re-parent elsewhere updates the chip instantly.
  const parentRow = useMemo(() => {
    const pid = (data as any)?.parent_id;
    if (!pid) return null;
    return (allTasks[String(pid)] as TaskItem | undefined) ?? null;
  }, [allTasks, (data as any)?.parent_id]);

  // The comment composer owns its draft and uploads (components/tasks/TaskCommentStream);
  // the page's drop zone hands dropped files to it through this ref.
  const commentDropRef = useRef<((files: File[]) => void) | null>(null);

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
    // directData === null: webGetTaskDetail resolved but the id is not a task
    // (e.g. a /tasks/<conversationId> link). undefined: query still in flight.
    if (directData === null) {
      // Full page redirects to the conversation (effect above); render the
      // loader during the swap. Inline keeps the list visible and offers a link.
      if (sessionForBadId && !isInline) {
        return <AppLoader className="min-h-[16rem] h-full" />;
      }
      return (
        <div className={`flex flex-col items-center justify-center h-full gap-3 text-center px-6 ${isInline ? "w-[480px] flex-shrink-0 border-l border-sol-border/30 bg-sol-bg" : ""}`}>
          <div className="text-sol-text-muted text-sm">This task doesn&apos;t exist.</div>
          <div className="text-sol-text-dim text-xs font-mono break-all">{id}</div>
          {sessionForBadId && (
            <Link href={`/conversation/${id}`} className="text-xs text-sol-cyan hover:underline">
              It&apos;s a session — open it →
            </Link>
          )}
          {isInline && onClose ? (
            <button onClick={onClose} className="text-xs text-sol-cyan hover:underline">← Close</button>
          ) : (
            <Link href="/tasks" className="text-xs text-sol-cyan hover:underline">← Back to tasks</Link>
          )}
        </div>
      );
    }
    return <AppLoader className={isInline ? "w-[480px] flex-shrink-0 border-l border-sol-border/30 min-h-[16rem] h-full" : "min-h-[16rem] h-full"} />;
  }

  const status = statusVisual(taskStatusOf(data as any, taskStatuses), taskStatuses);
  const StatusIcon = status.icon;

  return (
        <div
          className={isInline ? "w-[480px] flex-shrink-0 h-full flex flex-col relative min-w-0 border-l border-sol-border/30 bg-sol-bg" : "flex-1 h-full flex flex-col relative min-w-0"}
          onDragEnter={(e) => { e.preventDefault(); dragCounterRef.current++; setIsDragging(true); }}
          onDragOver={(e) => { e.preventDefault(); }}
          onDragLeave={(e) => { e.preventDefault(); dragCounterRef.current--; if (dragCounterRef.current <= 0) { dragCounterRef.current = 0; setIsDragging(false); } }}
          onDrop={(e) => { e.preventDefault(); dragCounterRef.current = 0; setIsDragging(false); const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith("image/")); commentDropRef.current?.(files); }}
        >
        {isDragging && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-sol-bg/80 border-2 border-dashed border-sol-cyan rounded-xl pointer-events-none">
            <p className="text-sol-cyan text-sm font-medium">Drop images to attach</p>
          </div>
        )}
        <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col min-h-full">
        <div className={isInline ? "flex-1 px-4 py-4 w-full" : "flex-1 max-w-4xl mx-auto px-6 py-6 w-full"}>
          {/* Card header: id + badges + watch, with actions */}
          <div className="flex items-center justify-between mb-3 gap-2">
            <div className="flex items-center gap-2 min-w-0 overflow-hidden text-xs text-sol-text-dim">
              <button
                onClick={() => { copyToClipboard(data.short_id); toast.success("Task ID copied"); }}
                className="font-mono px-1.5 py-0.5 rounded bg-sol-bg-alt border border-sol-border/30 hover:border-sol-cyan/40 hover:text-sol-cyan transition-colors cursor-copy whitespace-nowrap flex-shrink-0"
                title="Click to copy ID"
              >
                {data.short_id}
              </button>
              {teamInfo && (
                <span className="px-1.5 py-0.5 rounded bg-sol-cyan/10 text-sol-cyan border border-sol-cyan/20 text-[10px] truncate min-w-0">{teamInfo.name}</span>
              )}
              {/* Where this task lives. A link, because the project is a place
                  you can work from — and suppressed when you are already inside
                  that project, where the breadcrumb overhead has just said so. */}
              {taskProject && (
                <Link
                  href={`/projects/${taskProject._id}`}
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-sol-bg-alt border border-sol-border/30 text-[10px] text-sol-text-dim hover:text-sol-text hover:border-sol-border transition-colors truncate min-w-0"
                  title={`Open project: ${taskProject.title}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${projectDotClass(taskProject)}`} />
                  <span className="truncate">{taskProject.title}</span>
                </Link>
              )}
              {!taskTeamId && (
                <span className="px-1.5 py-0.5 rounded bg-sol-text-dim/10 text-sol-text-dim border border-sol-text-dim/20 text-[10px] whitespace-nowrap flex-shrink-0">Personal</span>
              )}
              {data.source === "insight" && (
                <span className="px-1.5 py-0.5 rounded bg-sol-violet/10 text-sol-violet border border-sol-violet/20 text-[10px] whitespace-nowrap flex-shrink-0">mined</span>
              )}
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {isInline && onOpen && (
                <button onClick={onOpen} className="text-xs px-2 py-1 rounded-md text-sol-text-dim hover:text-sol-cyan hover:bg-sol-bg-alt transition-colors" title="Open full page">Open</button>
              )}
              <button
                onClick={() => { copyToClipboard(canonicalUrl()).then(() => toast.success("Link copied")).catch(() => toast.error("Failed to copy")); }}
                className="p-1 rounded-md text-sol-text-dim hover:text-sol-cyan hover:bg-sol-bg-alt transition-colors"
                title="Copy link"
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
              </button>
              {chatOn && (
                <button
                  onClick={() => openForwardToChat({ url: canonicalUrl(), label: "task" })}
                  className="p-1 rounded-md text-sol-text-dim hover:text-sol-cyan hover:bg-sol-bg-alt transition-colors"
                  title="Send to chat"
                >
                  <Forward className="w-3.5 h-3.5" />
                </button>
              )}
              <OverflowMenu>
                <WatchButton entityType="task" entityId={data._id} variant="menuItem" />
              </OverflowMenu>
              <button
                onClick={() => { if (isInline && onClose) onClose(); else router.push("/tasks"); }}
                className="p-1 rounded-md text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt transition-colors"
                title="Close (Esc)"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Parent breadcrumb — a subtask never renders context-free */}
          {(data as any).parent_id && (
            <button
              onClick={() => parentRow && router.push(`/tasks/${parentRow._id}`)}
              className="flex items-center gap-1.5 mb-2 text-xs text-sol-text-dim hover:text-sol-cyan transition-colors group"
              title={parentRow ? `Open ${parentRow.short_id}` : "Parent task"}
            >
              <CornerDownRight className="w-3 h-3 flex-shrink-0" />
              <span>Subtask of</span>
              <span className="font-mono">{parentRow?.short_id ?? "…"}</span>
              {parentRow && <span className="text-sol-text-muted group-hover:text-sol-cyan truncate max-w-[24rem]">{parentRow.title}</span>}
            </button>
          )}

          {/* Title */}
          <div className="flex items-start gap-2.5 mb-3">
            <StatusIcon className={`w-5 h-5 mt-0.5 flex-shrink-0 ${status.color}`} />
            <div className="flex-1 min-w-0">
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
                  className="w-full text-lg font-semibold text-sol-text bg-transparent border-b border-sol-cyan focus:outline-none pb-0.5"
                />
              ) : (
                <h1
                  className="text-lg font-semibold text-sol-text leading-snug cursor-text hover:text-sol-cyan/90 transition-colors"
                  onClick={startEditTitle}
                  title="Click to edit (e)"
                >
                  {data.title}
                </h1>
              )}
            </div>
          </div>

          {/* Primary properties — inline, editable (the card look) */}
          <div className="flex items-center gap-1 flex-wrap mb-4 -ml-1">
            <Dropdown value={taskStatusKey(data as any, taskStatuses)} options={statusOptions} onChange={handleStatusChange} shortcutHint="s to cycle" />
            <Dropdown value={data.priority} options={PRIORITY_OPTIONS} onChange={(v) => handleUpdate({ priority: v })} shortcutHint="p to cycle" />
            <button
              onClick={() => openCmd("assign")}
              className="flex items-center gap-1.5 px-2 py-1 rounded-md text-xs hover:bg-sol-bg-alt transition-colors text-left"
            >
              {assigneeInfo ? (
                <>
                  <Avatar name={assigneeInfo.name} image={assigneeInfo.image} />
                  <span className="text-sol-text-muted">{assigneeInfo.name}</span>
                </>
              ) : (
                <span className="text-sol-text-dim">Unassigned</span>
              )}
            </button>
          </div>

          {/* Secondary properties */}
          <div className="mb-6 rounded-lg border border-sol-border/15 overflow-hidden">
            {/* Created */}
            <div className="grid grid-cols-[7rem_1fr] items-center px-4 py-1.5 hover:bg-sol-bg-alt/30 transition-colors">
              <span className="text-xs text-sol-text-dim">Created</span>
              <span className="flex items-center gap-1.5 text-xs text-sol-text-muted" title={formatDateFull(data.created_at)}>
                <Clock className="w-3 h-3 text-sol-text-dim" />
                {formatDate(data.created_at)}
              </span>
            </div>

            {data.closed_at && (
              <div className="grid grid-cols-[7rem_1fr] items-center px-4 py-1.5 hover:bg-sol-bg-alt/30 transition-colors">
                <span className="text-xs text-sol-text-dim">Closed</span>
                <span className="text-xs text-sol-text-muted" title={formatDateFull(data.closed_at)}>{formatDate(data.closed_at)}</span>
              </div>
            )}

            {(data as any).started_at && (
              <div className="grid grid-cols-[7rem_1fr] items-center px-4 py-1.5 hover:bg-sol-bg-alt/30 transition-colors">
                <span className="text-xs text-sol-text-dim">Started</span>
                <span className="text-xs text-sol-text-muted" title={formatDateFull((data as any).started_at)}>{formatDate((data as any).started_at)}</span>
              </div>
            )}

            {/* Confidence — visual bar */}
            {data.confidence != null && (
              <div className="grid grid-cols-[7rem_1fr] items-center px-4 py-1.5 hover:bg-sol-bg-alt/30 transition-colors">
                <span className="text-xs text-sol-text-dim">Confidence</span>
                <ConfidenceBar value={data.confidence} />
              </div>
            )}

            {/* Labels */}
            {data.labels && data.labels.length > 0 && (
              <div className="grid grid-cols-[7rem_1fr] items-center px-4 py-1.5 hover:bg-sol-bg-alt/30 transition-colors">
                <span className="text-xs text-sol-text-dim">Labels</span>
                <div className="flex gap-1.5 flex-wrap">
                  {data.labels.map((l: string) => {
                    const lc = getLabelColor(l);
                    return (
                      <Link key={l} href={`/tasks?label=${encodeURIComponent(l)}`} className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full border ${lc.bg} ${lc.border} ${lc.text} hover:brightness-110 transition-all cursor-pointer`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${lc.dot}`} />
                        {l}
                      </Link>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Blocked by */}
            {data.blocked_by && data.blocked_by.length > 0 && (
              <div className="grid grid-cols-[7rem_1fr] items-center px-4 py-1.5 hover:bg-sol-bg-alt/30 transition-colors">
                <span className="text-xs text-sol-text-dim">Blocked by</span>
                <div className="flex gap-1.5 flex-wrap">
                  {data.blocked_by.map((b: string) => (
                    <Link key={b} href={`/tasks/${b}`} className="text-xs font-mono text-sol-red hover:underline">{b}</Link>
                  ))}
                </div>
              </div>
            )}

            {/* Blocks */}
            {data.blocks && data.blocks.length > 0 && (
              <div className="grid grid-cols-[7rem_1fr] items-center px-4 py-1.5 hover:bg-sol-bg-alt/30 transition-colors">
                <span className="text-xs text-sol-text-dim">Blocks</span>
                <div className="flex gap-1.5 flex-wrap">
                  {data.blocks.map((b: string) => (
                    <Link key={b} href={`/tasks/${b}`} className="text-xs font-mono text-sol-text-muted hover:underline">{b}</Link>
                  ))}
                </div>
              </div>
            )}

            {/* Parent — set, change, or detach */}
            <div className="grid grid-cols-[7rem_1fr] items-center px-4 py-1.5 hover:bg-sol-bg-alt/30 transition-colors">
              <span className="text-xs text-sol-text-dim">Parent</span>
              {(data as any).parent_id ? (
                <div className="flex items-center gap-1.5">
                  <button onClick={() => parentRow && router.push(`/tasks/${parentRow._id}`)} className="text-xs font-mono text-sol-cyan hover:underline">
                    {parentRow?.short_id ?? "…"}
                  </button>
                  {parentRow && <span className="text-xs text-sol-text-muted truncate max-w-[16rem]">{parentRow.title}</span>}
                  <button
                    onClick={() => { if (data.short_id) { const r = setTaskParent(data.short_id, ""); if (!r.ok) toast.error(r.reason); } }}
                    className="p-0.5 rounded text-sol-text-dim hover:text-sol-red transition-colors"
                    title="Remove parent"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <button onClick={() => openCmd("parent")} className="text-xs text-sol-text-dim hover:text-sol-text text-left transition-colors">
                  Set parent…
                </button>
              )}
            </div>
          </div>

          {/* Subtasks — Linear's sub-issue section, always present */}
          <SubtasksSection task={data} requestClose={requestClose} onNavigate={(tid) => router.push(`/tasks/${tid}`)} />

          {/* Source session */}
          {(data.source === "agent" || data.source === "insight") && data.created_from_conversation && (
            <Link
              href={`/conversation/${linkedConversations[0]?.session_id || ""}`}
              className="flex items-center gap-2.5 text-xs text-sol-text-dim mb-5 px-3 py-2 rounded-lg border border-sol-border/20 bg-sol-bg-alt/20 hover:bg-sol-bg-alt/40 hover:border-sol-violet/30 transition-colors group"
            >
              <Zap className="w-3.5 h-3.5 text-sol-violet flex-shrink-0" />
              <span>Created from</span>
              <span className="text-sol-cyan group-hover:underline truncate">
                {linkedConversations[0]?.title || linkedConversations[0]?.headline || "session"}
              </span>
              <ExternalLink className="w-3 h-3 text-sol-text-dim opacity-0 group-hover:opacity-100 transition-opacity ml-auto flex-shrink-0" />
            </Link>
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
              className="doc-editor-compact"
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
              <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5" />
                Source Insight
              </h2>
              <div className="border border-sol-border/30 rounded-lg p-4 bg-sol-bg-alt/20 border-l-2 border-l-sol-violet/30">
                <div className="flex items-center gap-2 mb-2">
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

          {/* Related Docs */}
          {relatedDocs.length > 0 && (
            <div className="mb-6">
              <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wide mb-2">Related Documents</h2>
              <div className="border border-sol-border/30 rounded-lg divide-y divide-sol-border/20 overflow-hidden">
                {relatedDocs.map((doc: any) => (
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
            <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wide mb-3 flex items-center gap-1.5">
              <MessageSquare className="w-3.5 h-3.5" />
              Activity
            </h2>
            <div className="relative">
              {/* Vertical timeline line */}
              <div className="absolute left-[9px] top-2 bottom-2 w-px bg-sol-border/20" />
              <div className="space-y-0">
                {[
                  ...(data.history || []).map((h: any) => ({ type: "history" as const, ts: h.created_at, data: h })),
                  ...(data.comments || []).map((c: any) => ({ type: "comment" as const, ts: c.created_at, data: c })),
                  ...gitEvents.map((e) => ({ type: "git" as const, ts: e.created_at ?? 0, data: e })),
                ]
                  .sort((a, b) => a.ts - b.ts)
                  .map((item) =>
                    item.type === "history" ? (
                      <HistoryItem key={item.data._id} entry={item.data} />
                    ) : item.type === "git" ? (
                      <ExternalEventRow
                        key={item.data._id}
                        event={gitEventToExternalEvent(item.data)}
                        density="compact"
                        omitRefs={["task_id", "task_short_id"]}
                        className="-ml-[4px]"
                      />
                    ) : (
                      <TaskCommentItem key={item.data._id} comment={item.data} openLinkedSession={openLinkedSession} />
                    )
                  )}
              </div>
            </div>
          </div>

          {/* Comment input */}
          <TaskCommentComposer shortId={data.short_id} dropFilesRef={commentDropRef} />

        </div>
        {!isInline && linkedConversations.length > 0 && (
          <div className="max-w-4xl mx-auto px-6 pb-4 w-full">
            <h2 className="text-xs font-medium text-sol-text-dim uppercase tracking-wide mb-2 flex items-center gap-1.5">
              <Radio className="w-3.5 h-3.5" />
              Sessions ({linkedConversations.length})
              {linkedConversations.some((c: any) => c.is_active) && (
                <span className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 text-[10px]">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  {linkedConversations.filter((c: any) => c.is_active).length} active
                </span>
              )}
            </h2>
            <div className="space-y-1.5">
              {[...linkedConversations]
                .sort((a: any, b: any) => {
                  if (a.is_active && !b.is_active) return -1;
                  if (!a.is_active && b.is_active) return 1;
                  return (b.updated_at || 0) - (a.updated_at || 0);
                })
                .map((conv: any) => (
                  <FeedCard
                    key={conv._id}
                    conv={conv as any}
                    showActor={false}
                    onNavigate={() => openLinkedSession(conv)}
                  />
                ))}
            </div>
          </div>
        )}
        {!isInline && (
          <ContextChatInput
            contextType="task"
            contextTitle={data.title}
            getContextBody={getTaskContextBody}
            linkedObjectId={data._id}
            projectPath={data.project_path}
          />
        )}
        </div>
        </div>

        {/* Unified palette is global via DashboardLayout */}

        </div>
  );
}
