"use client";

import { useState, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, ProjectItem } from "../../store/inboxStore";
import { useSyncProjects } from "../../hooks/useSyncProjects";
import { AuthGuard } from "../../components/AuthGuard";
import { DashboardLayout } from "../../components/DashboardLayout";
import { toast } from "sonner";
import {
  Plus,
  FolderKanban,
  Circle,
  CircleDot,
  PauseCircle,
  CheckCircle2,
  FileText,
  ListChecks,
  Target,
} from "lucide-react";

const api = _api as any;

type ProjectStatus = "active" | "planning" | "paused" | "done";

const STATUS_CONFIG: Record<ProjectStatus, { icon: typeof Circle; label: string; color: string; accent: string }> = {
  active: { icon: CircleDot, label: "Active", color: "text-sol-cyan", accent: "border-sol-cyan" },
  planning: { icon: Circle, label: "Planning", color: "text-sol-violet", accent: "border-sol-violet" },
  paused: { icon: PauseCircle, label: "Paused", color: "text-sol-yellow", accent: "border-sol-yellow" },
  done: { icon: CheckCircle2, label: "Done", color: "text-sol-green", accent: "border-sol-green" },
};

const STATUS_ORDER: ProjectStatus[] = ["active", "planning", "paused", "done"];

const PROJECT_COLORS = [
  { value: "cyan", label: "Cyan", tw: "bg-sol-cyan" },
  { value: "blue", label: "Blue", tw: "bg-sol-blue" },
  { value: "violet", label: "Violet", tw: "bg-sol-violet" },
  { value: "green", label: "Green", tw: "bg-sol-green" },
  { value: "yellow", label: "Yellow", tw: "bg-sol-yellow" },
  { value: "orange", label: "Orange", tw: "bg-sol-orange" },
  { value: "red", label: "Red", tw: "bg-sol-red" },
  { value: "magenta", label: "Magenta", tw: "bg-sol-magenta" },
];

function getColorClass(color?: string): string {
  const found = PROJECT_COLORS.find((c) => c.value === color);
  return found ? found.tw : "bg-sol-cyan";
}

function ProjectProgress({ project }: { project: ProjectItem }) {
  const { task_counts } = project;
  if (task_counts.total === 0) return null;

  const donePct = (task_counts.done / task_counts.total) * 100;
  const ipPct = (task_counts.in_progress / task_counts.total) * 100;

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 bg-sol-border/20 rounded-full overflow-hidden">
        <div className="h-full flex">
          <div className="bg-sol-green/80 transition-all duration-500" style={{ width: `${donePct}%` }} />
          <div className="bg-sol-yellow/60 transition-all duration-500" style={{ width: `${ipPct}%` }} />
        </div>
      </div>
      <span className="text-[10px] text-sol-text-dim tabular-nums whitespace-nowrap">
        {task_counts.done}/{task_counts.total}
      </span>
    </div>
  );
}

function ProjectCard({ project, onClick }: { project: ProjectItem; onClick: () => void }) {
  const status = STATUS_CONFIG[project.status as ProjectStatus] || STATUS_CONFIG.active;
  const StatusIcon = status.icon;
  const totalItems = project.task_counts.total + project.plan_count + project.doc_count;

  return (
    <button
      onClick={onClick}
      className="group w-full text-left bg-sol-bg rounded-lg border border-sol-border/30 hover:border-sol-border/60 transition-all duration-200 overflow-hidden"
    >
      {/* Color accent bar */}
      <div className={`h-0.5 ${getColorClass(project.color)} opacity-60 group-hover:opacity-100 transition-opacity`} />

      <div className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <StatusIcon className={`w-4 h-4 flex-shrink-0 ${status.color}`} />
            <h3 className="text-sm font-medium text-sol-text truncate">{project.title}</h3>
          </div>
          {project.target_date && (
            <span className="text-[10px] text-sol-text-dim tabular-nums whitespace-nowrap">
              {new Date(project.target_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </span>
          )}
        </div>

        {/* Description */}
        {project.description && (
          <p className="text-xs text-sol-text-muted line-clamp-2 leading-relaxed">{project.description}</p>
        )}

        {/* Stats row */}
        {totalItems > 0 && (
          <div className="flex items-center gap-3 text-[11px] text-sol-text-dim">
            {project.plan_count > 0 && (
              <span className="flex items-center gap-1">
                <Target className="w-3 h-3" />
                {project.plan_count} {project.plan_count === 1 ? "plan" : "plans"}
              </span>
            )}
            {project.task_counts.total > 0 && (
              <span className="flex items-center gap-1">
                <ListChecks className="w-3 h-3" />
                {project.task_counts.total} {project.task_counts.total === 1 ? "task" : "tasks"}
              </span>
            )}
            {project.doc_count > 0 && (
              <span className="flex items-center gap-1">
                <FileText className="w-3 h-3" />
                {project.doc_count} {project.doc_count === 1 ? "doc" : "docs"}
              </span>
            )}
          </div>
        )}

        {/* Progress bar */}
        <ProjectProgress project={project} />

        {/* Labels */}
        {project.labels && project.labels.length > 0 && (
          <div className="flex items-center gap-1 flex-wrap">
            {project.labels.map((label) => (
              <span
                key={label}
                className="text-[10px] px-1.5 py-0.5 rounded-full bg-sol-bg-alt border border-sol-border/20 text-sol-text-dim"
              >
                {label}
              </span>
            ))}
          </div>
        )}
      </div>
    </button>
  );
}

function CreateProjectInline({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("cyan");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const createProject = useMutation(api.projects.webCreate);

  const handleSubmit = useCallback(async () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setIsSubmitting(true);
    try {
      await createProject({ title: trimmed, description: description.trim() || undefined, color });
      setTitle("");
      setDescription("");
      toast.success("Project created");
      onCreated();
    } catch (e: any) {
      toast.error(e.message || "Failed to create project");
    } finally {
      setIsSubmitting(false);
    }
  }, [title, description, color, createProject, onCreated]);

  return (
    <div className="bg-sol-bg rounded-lg border border-sol-border/40 p-4 space-y-3">
      <input
        type="text"
        placeholder="Project name"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
        autoFocus
        className="w-full bg-transparent text-sm text-sol-text placeholder:text-sol-text-dim/50 outline-none"
      />
      <input
        type="text"
        placeholder="Description (optional)"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSubmit(); } }}
        className="w-full bg-transparent text-xs text-sol-text-muted placeholder:text-sol-text-dim/40 outline-none"
      />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {PROJECT_COLORS.map((c) => (
            <button
              key={c.value}
              onClick={() => setColor(c.value)}
              className={`w-4 h-4 rounded-full ${c.tw} transition-all ${
                color === c.value ? "ring-2 ring-offset-1 ring-offset-sol-bg ring-sol-text/40 scale-110" : "opacity-50 hover:opacity-80"
              }`}
              title={c.label}
            />
          ))}
        </div>
        <button
          onClick={handleSubmit}
          disabled={!title.trim() || isSubmitting}
          className="text-xs px-3 py-1 rounded bg-sol-cyan/15 text-sol-cyan hover:bg-sol-cyan/25 disabled:opacity-40 transition-colors"
        >
          Create
        </button>
      </div>
    </div>
  );
}

function ProjectListContent() {
  const router = useRouter();
  useSyncProjects();

  const projects = useInboxStore((s) => s.projects);
  const [showCreate, setShowCreate] = useState(false);
  const [showDone, setShowDone] = useState(false);

  const allProjects = useMemo(() => {
    const list = Object.values(projects);
    list.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    return list;
  }, [projects]);

  const grouped = useMemo(() => {
    const result: Record<string, ProjectItem[]> = {};
    for (const status of STATUS_ORDER) {
      const items = allProjects.filter((p) => p.status === status);
      if (items.length > 0 || (status === "active" && allProjects.length > 0)) {
        if (status === "done" && !showDone) continue;
        result[status] = items;
      }
    }
    return result;
  }, [allProjects, showDone]);

  const doneCount = allProjects.filter((p) => p.status === "done").length;

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-sol-border/20">
        <div className="flex items-center gap-2.5">
          <FolderKanban className="w-5 h-5 text-sol-text-muted" />
          <h1 className="text-base font-medium text-sol-text">Projects</h1>
          <span className="text-xs text-sol-text-dim tabular-nums">{allProjects.length}</span>
        </div>
        <button
          onClick={() => setShowCreate((v) => !v)}
          className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md bg-sol-bg-alt hover:bg-sol-bg-highlight text-sol-text-muted hover:text-sol-text transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          New project
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Create inline form */}
          {showCreate && (
            <CreateProjectInline onCreated={() => setShowCreate(false)} />
          )}

          {/* Empty state */}
          {allProjects.length === 0 && !showCreate && (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <FolderKanban className="w-10 h-10 text-sol-text-dim/30 mb-3" />
              <p className="text-sm text-sol-text-muted mb-1">No projects yet</p>
              <p className="text-xs text-sol-text-dim mb-4">Projects organize your plans, tasks, and docs into focused workstreams.</p>
              <button
                onClick={() => setShowCreate(true)}
                className="text-xs px-3 py-1.5 rounded-md bg-sol-cyan/10 text-sol-cyan hover:bg-sol-cyan/20 transition-colors"
              >
                Create your first project
              </button>
            </div>
          )}

          {/* Status groups */}
          {STATUS_ORDER.map((status) => {
            const items = grouped[status];
            if (!items) return null;
            const cfg = STATUS_CONFIG[status];
            const StatusIcon = cfg.icon;

            return (
              <div key={status}>
                <div className="flex items-center gap-2 mb-3">
                  <StatusIcon className={`w-3.5 h-3.5 ${cfg.color}`} />
                  <span className="text-xs font-medium text-sol-text-muted uppercase tracking-wider">{cfg.label}</span>
                  <span className="text-[10px] text-sol-text-dim tabular-nums">{items.length}</span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {items.map((project) => (
                    <ProjectCard
                      key={project._id}
                      project={project}
                      onClick={() => router.push(`/projects/${project._id}`)}
                    />
                  ))}
                </div>
              </div>
            );
          })}

          {/* Show done toggle */}
          {doneCount > 0 && !showDone && (
            <button
              onClick={() => setShowDone(true)}
              className="text-xs text-sol-text-dim hover:text-sol-text-muted transition-colors"
            >
              Show {doneCount} completed {doneCount === 1 ? "project" : "projects"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ProjectsPage() {
  return (
    <AuthGuard>
      <DashboardLayout>
        <ProjectListContent />
      </DashboardLayout>
    </AuthGuard>
  );
}
