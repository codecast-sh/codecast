"use client";

import { useState, useMemo, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, TaskItem, PlanItem, DocItem } from "../../../store/inboxStore";
import { useSyncTasks } from "../../../hooks/useSyncTasks";
import { useSyncPlans } from "../../../hooks/useSyncPlans";
import { useSyncDocs } from "../../../hooks/useSyncDocs";
import { useSyncProjects } from "../../../hooks/useSyncProjects";
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
  useSyncPlans();
  useSyncDocs();

  const project = useQuery(api.projects.webGet, projectId ? { id: projectId } : "skip");

  const tasks = useInboxStore((s) => s.tasks);
  const plans = useInboxStore((s) => s.plans);
  const docs = useInboxStore((s) => s.docs);

  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const updateProject = useMutation(api.projects.webUpdate);

  // Plans in this project
  const projectPlans = useMemo(() =>
    Object.values(plans).filter((p: any) => p.project_id === projectId)
      .sort((a, b) => {
        // Active plans first, then by updated_at
        const statusOrder: Record<string, number> = { active: 0, draft: 1, paused: 2, done: 3, abandoned: 4 };
        const sd = (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5);
        return sd !== 0 ? sd : b.updated_at - a.updated_at;
      }),
    [plans, projectId]
  );

  // All tasks in this project
  const projectTasks = useMemo(() =>
    Object.values(tasks).filter((t: any) => t.project_id === projectId),
    [tasks, projectId]
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

  // Standalone tasks (in project but not under any plan)
  const standaloneTasks = useMemo(() =>
    projectTasks
      .filter((t: any) => !t.plan_id)
      .sort((a, b) => {
        const order: Record<string, number> = { in_progress: 0, in_review: 1, open: 2, backlog: 3, done: 4, dropped: 5 };
        const sd = (order[a.status] ?? 3) - (order[b.status] ?? 3);
        return sd !== 0 ? sd : b.updated_at - a.updated_at;
      }),
    [projectTasks]
  );

  // Docs in this project
  const projectDocs = useMemo(() =>
    Object.values(docs).filter((d: any) => d.project_id === projectId)
      .sort((a, b) => b.updated_at - a.updated_at),
    [docs, projectId]
  );

  const handleStartEdit = useCallback(() => {
    if (project) {
      setTitleDraft(project.title);
      setEditingTitle(true);
    }
  }, [project]);

  const handleSaveTitle = useCallback(async () => {
    const trimmed = titleDraft.trim();
    if (trimmed && trimmed !== project?.title) {
      await updateProject({ id: projectId as any, title: trimmed });
    }
    setEditingTitle(false);
  }, [titleDraft, project?.title, projectId, updateProject]);

  const handleStatusChange = useCallback(async (status: string) => {
    await updateProject({ id: projectId as any, status });
    toast.success(`Project marked as ${status}`);
  }, [projectId, updateProject]);

  if (!project) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-sm text-sol-text-dim">Loading project...</div>
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

  const hasContent = projectPlans.length > 0 || standaloneTasks.length > 0 || projectDocs.length > 0;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 py-4 border-b border-sol-border/20">
        <div className="flex items-center gap-3 mb-3">
          <button
            onClick={() => router.push("/projects")}
            className="text-sol-text-dim hover:text-sol-text transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>

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

        <div className="flex items-center gap-4 ml-7">
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
          <div className="flex items-center gap-3 text-[11px] text-sol-text-dim ml-auto">
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
      </div>

      {/* Content: unified hierarchy */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto py-3 px-2">
          {!hasContent && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <Target className="w-8 h-8 text-sol-text-dim/20 mb-2" />
              <p className="text-xs text-sol-text-dim">This project is empty</p>
              <p className="text-[11px] text-sol-text-dim/60 mt-1">Create plans, tasks, or docs and assign them to this project</p>
            </div>
          )}

          {/* Plans with nested tasks */}
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

          {/* Standalone tasks */}
          {standaloneTasks.length > 0 && (
            <>
              <SectionHeader icon={ListChecks} label="Tasks" count={standaloneTasks.length} />
              {standaloneTasks.map((task) => (
                <TaskRow key={task._id} task={task} />
              ))}
            </>
          )}

          {/* Docs */}
          {projectDocs.length > 0 && (
            <>
              <SectionHeader icon={FileText} label="Docs" count={projectDocs.length} />
              {projectDocs.map((doc) => (
                <DocRow key={doc._id} doc={doc} />
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ProjectDetailPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <ProjectDetailContent />
      </DashboardLayout>
    </AuthGuard>
  );
}
