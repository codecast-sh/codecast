"use client";

import { useState, useMemo, useCallback } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, TaskItem, PlanItem, DocItem } from "../../../store/inboxStore";
import { useSyncTasks } from "../../../hooks/useSyncTasks";
import { useWorkspaceCollection } from "../../../hooks/useWorkspaceCollection";
import { TaskListContent } from "../../tasks/page";
import { TaskDetailContent } from "../../tasks/[id]/page";
import { DetailSplitLayout } from "../../../components/DetailSplitLayout";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { projectDotClass } from "../../../lib/projectColors";
import { buildProgressSeries } from "../../../lib/projectProgress";
import { ProgressChart } from "../../../components/ProgressChart";
import { useSyncPlans } from "../../../hooks/useSyncPlans";
import { useSyncDocs } from "../../../hooks/useSyncDocs";
import { useSyncProjects } from "../../../hooks/useSyncProjects";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { AuthGuard } from "../../../components/AuthGuard";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { toast } from "sonner";
import Link from "next/link";
import {
  ArrowLeft,
  Circle,
  CircleDot,
  CircleDotDashed,
  CheckCircle2,
  PauseCircle,
  XCircle,
  Target,
  ListChecks,
  FileText,
  AlertTriangle,
  ArrowUp,
  ArrowDown,
  Minus,
  Pin,
  Pencil,
  Check,
  X,
  ChevronRight,
  ChevronDown,
  Activity,
} from "lucide-react";

const api = _api as any;

const TASK_STATUS_CONFIG: Record<string, { icon: typeof Circle; color: string }> = {
  backlog: { icon: CircleDotDashed, color: "text-sol-text-dim" },
  open: { icon: Circle, color: "text-sol-blue" },
  in_progress: { icon: CircleDot, color: "text-sol-yellow" },
  in_review: { icon: CircleDot, color: "text-sol-violet" },
  done: { icon: CheckCircle2, color: "text-sol-green" },
  dropped: { icon: XCircle, color: "text-sol-text-dim" },
};

const PLAN_STATUS_CONFIG: Record<string, { icon: typeof Circle; color: string }> = {
  draft: { icon: Circle, color: "text-sol-text-dim" },
  active: { icon: CircleDot, color: "text-sol-cyan" },
  paused: { icon: PauseCircle, color: "text-sol-yellow" },
  done: { icon: CheckCircle2, color: "text-sol-green" },
  abandoned: { icon: XCircle, color: "text-sol-text-dim" },
};

const PRIORITY_ICONS: Record<string, { icon: typeof Minus; color: string }> = {
  urgent: { icon: AlertTriangle, color: "text-sol-red" },
  high: { icon: ArrowUp, color: "text-sol-orange" },
  medium: { icon: Minus, color: "text-sol-text-muted" },
  low: { icon: ArrowDown, color: "text-sol-text-dim" },
  none: { icon: Minus, color: "text-sol-text-dim" },
};

const DOC_TYPE_DOTS: Record<string, string> = {
  note: "bg-gray-400",
  plan: "bg-sol-blue",
  design: "bg-sol-violet",
  spec: "bg-sol-cyan",
  investigation: "bg-sol-yellow",
  handoff: "bg-sol-orange",
};

function fmtAge(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)}d`;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function TaskRow({ task }: { task: TaskItem }) {
  const cfg = TASK_STATUS_CONFIG[task.status] || TASK_STATUS_CONFIG.open;
  const StatusIcon = cfg.icon;
  const pri = PRIORITY_ICONS[task.priority] || PRIORITY_ICONS.none;
  const PriIcon = pri.icon;

  return (
    <Link
      href={`/tasks/${task.short_id || task._id}`}
      className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-sol-bg-alt/50 transition-colors group"
    >
      <StatusIcon className={`w-3.5 h-3.5 flex-shrink-0 ${cfg.color}`} />
      <span className="flex-1 text-sm text-sol-text truncate group-hover:text-sol-text">{task.title}</span>
      {task.priority && task.priority !== "none" && (
        <PriIcon className={`w-3 h-3 flex-shrink-0 ${pri.color}`} />
      )}
      {task.labels && task.labels.length > 0 && (
        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-sol-bg-alt border border-sol-border/20 text-sol-text-dim flex-shrink-0">
          {task.labels[0]}
        </span>
      )}
      <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{fmtAge(task.updated_at)}</span>
    </Link>
  );
}

function PlanSection({ plan, tasks }: { plan: PlanItem; tasks: TaskItem[] }) {
  const [expanded, setExpanded] = useState(true);
  const cfg = PLAN_STATUS_CONFIG[plan.status] || PLAN_STATUS_CONFIG.draft;
  const StatusIcon = cfg.icon;
  const progress = plan.progress;

  return (
    <div className="mb-1">
      {/* Plan header */}
      <div className="flex items-center gap-2 group">
        <button
          onClick={() => setExpanded(!expanded)}
          className="p-0.5 rounded hover:bg-sol-bg-alt/50 text-sol-text-dim"
        >
          {expanded
            ? <ChevronDown className="w-3.5 h-3.5" />
            : <ChevronRight className="w-3.5 h-3.5" />
          }
        </button>
        <StatusIcon className={`w-3.5 h-3.5 flex-shrink-0 ${cfg.color}`} />
        <Link
          href={`/plans?plan=${plan.short_id || plan._id}`}
          className="flex-1 text-sm font-medium text-sol-text truncate hover:text-sol-cyan transition-colors"
        >
          {plan.title}
        </Link>
        {progress && progress.total > 0 && (
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <div className="w-16 h-1 bg-sol-border/20 rounded-full overflow-hidden">
              <div className="h-full flex">
                <div className="bg-sol-green/80" style={{ width: `${(progress.done / progress.total) * 100}%` }} />
                <div className="bg-sol-yellow/60" style={{ width: `${(progress.in_progress / progress.total) * 100}%` }} />
              </div>
            </div>
            <span className="text-[10px] text-sol-text-dim tabular-nums">{progress.done}/{progress.total}</span>
          </div>
        )}
        <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{fmtAge(plan.updated_at)}</span>
      </div>

      {/* Nested tasks */}
      {expanded && tasks.length > 0 && (
        <div className="ml-5 mt-0.5 border-l border-sol-border/15 pl-2">
          {tasks.map((task) => (
            <TaskRow key={task._id} task={task} />
          ))}
        </div>
      )}
      {expanded && tasks.length === 0 && (
        <div className="ml-10 py-1.5 text-[11px] text-sol-text-dim/60 italic">No tasks yet</div>
      )}
    </div>
  );
}

function DocRow({ doc }: { doc: DocItem }) {
  const dotColor = DOC_TYPE_DOTS[doc.doc_type] || DOC_TYPE_DOTS.note;

  return (
    <Link
      href={`/docs/${doc._id}`}
      className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-sol-bg-alt/50 transition-colors group"
    >
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />
      {doc.pinned && <Pin className="w-3 h-3 text-sol-yellow flex-shrink-0" />}
      <span className="flex-1 text-sm text-sol-text truncate group-hover:text-sol-text">
        {doc.title || "Untitled"}
      </span>
      <span className="text-[10px] text-sol-text-dim flex-shrink-0 capitalize">{doc.doc_type}</span>
      <span className="text-[10px] text-sol-text-dim tabular-nums flex-shrink-0">{fmtAge(doc.updated_at)}</span>
    </Link>
  );
}

function SectionHeader({ icon: Icon, label, count }: { icon: typeof Target; label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 px-1 pt-5 pb-2 first:pt-0">
      <Icon className="w-3.5 h-3.5 text-sol-text-dim" />
      <span className="text-[11px] font-medium text-sol-text-dim uppercase tracking-wider">{label}</span>
      {count > 0 && <span className="text-[10px] text-sol-text-dim/60 tabular-nums">{count}</span>}
    </div>
  );
}

function ProjectDetailContent() {
  const router = useRouter();
  const params = useParams();
  const projectId = params.id as string;

  useSyncProjects();
  useSyncTasks();

  // Which face of the project you're on. Tasks is the default: a project is
  // somewhere to work, and the overview is the summary you step back to.
  const searchParams = useSearchParams();
  const tab = searchParams.get("tab") === "overview" ? "overview" : "tasks";
  const setTab = useCallback((next: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "tasks") params.delete("tab"); else params.set("tab", next);
    const qs = params.toString();
    router.replace(qs ? `/projects/${projectId}?${qs}` : `/projects/${projectId}`);
  }, [searchParams, router, projectId]);
  useSyncPlans();
  useSyncDocs();

  // Local-first: the store already holds every project the rail lists, so a
  // project you click renders NOW and the server row enriches it when it lands.
  // Gating the whole surface on the query meant a spinner on every open — and,
  // offline, a spinner forever beside a sidebar happily naming the same project.
  const { data: serverProject } = useQueryNoThrow(api.projects.webGet, projectId ? { id: projectId } : "skip");
  const storeProjects = useInboxStore((s) => s.projects);
  const project = serverProject ?? (projectId ? (storeProjects as any)[projectId] : undefined);

  // Workspace-scoped enumeration (the one sanctioned reader): the store caches
  // rows from every workspace viewed, so these lists must be keyed to the
  // active one before the project filter narrows them.
  const wsTasks = useWorkspaceCollection<TaskItem>("tasks");
  const wsPlans = useWorkspaceCollection<PlanItem>("plans");
  const wsDocs = useWorkspaceCollection<DocItem>("docs");

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const updateProject = useInboxStore((s) => s.updateProject);

  // Plans in this project
  const projectPlans = useMemo(() =>
    wsPlans.filter((p: any) => p.project_id === projectId)
      .sort((a, b) => {
        // Active plans first, then by updated_at
        const statusOrder: Record<string, number> = { active: 0, draft: 1, paused: 2, done: 3, abandoned: 4 };
        const sd = (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5);
        return sd !== 0 ? sd : b.updated_at - a.updated_at;
      }),
    [wsPlans, projectId]
  );

  // All tasks in this project
  const projectTasks = useMemo(() =>
    wsTasks.filter((t: any) => t.project_id === projectId),
    [wsTasks, projectId]
  );

  // Tasks grouped by plan_id for nesting under plans
  const tasksByPlan = useMemo(() => {
    const map: Record<string, TaskItem[]> = {};
    for (const t of projectTasks) {
      const pid = (t as any).plan_id;
      if (pid) {
        if (!map[pid]) map[pid] = [];
        map[pid].push(t);
      }
    }
    // Sort within each plan group
    for (const tasks of Object.values(map)) {
      tasks.sort((a, b) => {
        const order: Record<string, number> = { in_progress: 0, in_review: 1, open: 2, backlog: 3, done: 4, dropped: 5 };
        return (order[a.status] ?? 3) - (order[b.status] ?? 3);
      });
    }
    return map;
  }, [projectTasks]);

  // Completion over time, from the timestamps tasks already carry. Uses the
  // project's WHOLE task set, not the board's filtered view: this is the shape
  // of the project, not of whatever you are currently looking at.
  const progressSeries = useMemo(
    () => buildProgressSeries(projectTasks as any[], Date.now()),
    [projectTasks]
  );

  // Docs in this project
  const projectDocs = useMemo(() =>
    wsDocs.filter((d: any) => d.project_id === projectId)
      .sort((a, b) => b.updated_at - a.updated_at),
    [wsDocs, projectId]
  );

  const handleStartEdit = useCallback(() => {
    if (project) {
      setTitleDraft(project.title);
      setEditingTitle(true);
    }
  }, [project]);

  const handleSaveTitle = useCallback(() => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== project?.title) {
      updateProject(projectId, { title: trimmed });
    }
    setEditingTitle(false);
  }, [titleDraft, project?.title, projectId, updateProject]);

  const handleStatusChange = useCallback((status: string) => {
    updateProject(projectId, { status });
    toast.success(`Project marked as ${status}`);
  }, [projectId, updateProject]);

  if (!project) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-sm text-sol-text-dim">Loading project…</div>
      </div>
    );
  }

  const statusCfg: Record<string, { icon: typeof Circle; color: string; label: string }> = {
    active: { icon: CircleDot, color: "text-sol-cyan", label: "Active" },
    planning: { icon: Circle, color: "text-sol-violet", label: "Planning" },
    paused: { icon: PauseCircle, color: "text-sol-yellow", label: "Paused" },
    done: { icon: CheckCircle2, color: "text-sol-green", label: "Done" },
  };
  const status = statusCfg[project.status] || statusCfg.active;
  const StatusIcon = status.icon;

  const hasContent = projectPlans.length > 0 || projectTasks.length > 0 || projectDocs.length > 0;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-sol-border/20">
        <div className="flex items-center gap-3 mb-3 min-w-0">
          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${projectDotClass(project)}`} />
          {editingTitle ? (
            <div className="flex items-center gap-2 flex-1">
              <input
                type="text"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveTitle();
                  if (e.key === "Escape") setEditingTitle(false);
                }}
                autoFocus
                className="flex-1 bg-transparent text-base font-medium text-sol-text outline-none border-b border-sol-cyan/40"
              />
              <button onClick={handleSaveTitle} className="text-sol-green hover:text-sol-green/80"><Check className="w-4 h-4" /></button>
              <button onClick={() => setEditingTitle(false)} className="text-sol-text-dim hover:text-sol-text"><X className="w-4 h-4" /></button>
            </div>
          ) : (
            <h1
              className="text-base font-medium text-sol-text cursor-pointer hover:text-sol-text/80 transition-colors group flex items-center gap-2"
              onClick={handleStartEdit}
            >
              {project.title}
              <Pencil className="w-3 h-3 text-sol-text-dim opacity-0 group-hover:opacity-100 transition-opacity" />
            </h1>
          )}
        </div>

        <div className="flex items-center gap-4 ml-5">
          {/* Status dropdown */}
          <div className="relative group/status">
            <button className={`flex items-center gap-1.5 text-xs ${status.color}`}>
              <StatusIcon className="w-3.5 h-3.5" />
              {status.label}
            </button>
            <div className="absolute left-0 top-full mt-1 bg-sol-bg border border-sol-border/40 rounded-md shadow-lg py-1 hidden group-hover/status:block z-10 min-w-[120px]">
              {Object.entries(statusCfg).map(([key, cfg]) => {
                const Icon = cfg.icon;
                return (
                  <button
                    key={key}
                    onClick={() => handleStatusChange(key)}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-sol-bg-alt transition-colors ${
                      project.status === key ? "text-sol-text" : "text-sol-text-muted"
                    }`}
                  >
                    <Icon className={`w-3 h-3 ${cfg.color}`} />
                    {cfg.label}
                  </button>
                );
              })}
            </div>
          </div>

          {project.description && (
            <span className="text-xs text-sol-text-dim">{project.description}</span>
          )}

          {project.target_date && (
            <span className="text-xs text-sol-text-dim tabular-nums">
              Due {new Date(project.target_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </span>
          )}

          {/* Summary counts */}
          <div className="flex items-center gap-3 text-[11px] text-sol-text-dim ml-auto cq-hide-compact">
            {projectPlans.length > 0 && (
              <span className="flex items-center gap-1">
                <Target className="w-3 h-3" /> {projectPlans.length}
              </span>
            )}
            <span className="flex items-center gap-1">
              <ListChecks className="w-3 h-3" /> {projectTasks.length}
            </span>
            {projectDocs.length > 0 && (
              <span className="flex items-center gap-1">
                <FileText className="w-3 h-3" /> {projectDocs.length}
              </span>
            )}
          </div>
        </div>

        {/* Tasks is the working surface; Overview is the summary of everything
            filed here — plans, their tasks, and docs. */}
        <div className="flex items-center gap-1 ml-5 mt-3 -mb-1">
          {/* The Tasks tab carries no count of its own: the list below reports
              what it is actually showing (the board hides agent-internal tasks
              by default), and the project's raw totals sit in the header row.
              Two numbers that disagree are worse than one. */}
          {([
            { key: "tasks", label: "Tasks", icon: ListChecks, count: 0 },
            { key: "overview", label: "Overview", icon: Target, count: projectPlans.length + projectDocs.length },
          ] as const).map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs transition-colors ${
                  active
                    ? "bg-sol-bg-alt text-sol-text border border-sol-border/40"
                    : "text-sol-text-dim hover:text-sol-text border border-transparent"
                }`}
              >
                <Icon className="w-3.5 h-3.5 flex-shrink-0" />
                <span>{t.label}</span>
                {t.count > 0 && <span className="text-[10px] tabular-nums text-sol-text-dim">{t.count}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* The project's tasks, through the same list surface /tasks uses —
          same filters, grouping, board, palette and saved views. */}
      {tab === "tasks" ? (
        <div className="flex-1 min-h-0">
          <TaskListContent projectId={projectId} />
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto">
        {/* Overview answers "what is this and how is it going" — it deliberately
            does NOT list tasks. It used to, and that list was a worse copy of
            the Tasks tab beside it: no filters, no grouping, no board, no
            keyboard. One list, one place. What lives here is what the task list
            cannot say: the shape of progress over time, and the plans and docs
            around the work. */}
        <div className="max-w-3xl mx-auto py-4 px-2 space-y-1">
          <SectionHeader icon={Activity} label="Progress" count={0} />
          <div className="px-1 pb-2">
            <ProgressChart series={progressSeries} />
          </div>

          {projectPlans.length > 0 && (
            <>
              <SectionHeader icon={Target} label="Plans" count={projectPlans.length} />
              {projectPlans.map((plan) => (
                <PlanSection
                  key={plan._id}
                  plan={plan}
                  tasks={tasksByPlan[plan._id] || []}
                />
              ))}
            </>
          )}

          {projectDocs.length > 0 && (
            <>
              <SectionHeader icon={FileText} label="Docs" count={projectDocs.length} />
              {projectDocs.map((doc) => (
                <DocRow key={doc._id} doc={doc} />
              ))}
            </>
          )}

          {!hasContent && (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <Target className="w-8 h-8 text-sol-text-dim/20 mb-2" />
              <p className="text-xs text-sol-text-dim">Nothing filed here yet</p>
              <p className="text-[11px] text-sol-text-dim/60 mt-1">Assign tasks, plans or docs to this project and they show up here</p>
            </div>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

export default function ProjectDetailPage() {
  // Selection stays in the URL and inside the project: /projects/<id> is the
  // project, /projects/<id>/<taskId> is a task within it. Both render this same
  // component (see TabContent), so opening a task reconciles in place — the
  // project's list never unmounts and you never leave the project.
  const params = useParams();
  const projectId = params?.id as string | undefined;
  const taskId = params?.taskId as string | undefined;
  return (
    <AuthGuard>
      <DashboardLayout>
        <DetailSplitLayout
          list={<ProjectDetailContent />}
          closeHref={`/projects/${projectId}`}
        >
          {taskId ? (
            <ErrorBoundary name="ProjectTaskDetail" level="panel">
              <TaskDetailContent taskId={taskId} variant="page" />
            </ErrorBoundary>
          ) : null}
        </DetailSplitLayout>
      </DashboardLayout>
    </AuthGuard>
  );
}
