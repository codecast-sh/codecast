"use client";
import { RepositoryLinks } from "../../../components/repo/RepositoryLinks";
import { ShareControl } from "../../../components/ShareControl";
import { useState, useMemo, useCallback } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation } from "convex/react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore, TaskItem, PlanItem, DocItem } from "../../../store/inboxStore";
import { isConvexId } from "../../../lib/entityLinks";
import { useSyncTasks } from "../../../hooks/useSyncTasks";
import { useWorkspaceCollection } from "../../../hooks/useWorkspaceCollection";
import { TaskListContent } from "../../tasks/page";
import { TaskDetailContent } from "../../tasks/[id]/page";
import { DetailSplitLayout } from "../../../components/DetailSplitLayout";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { projectDotClass } from "../../../lib/projectColors";
import { PROJECT_STATUS, PROJECT_STATUS_ORDER, projectStatusOf } from "../../../lib/projectStatus";
import { projectTaskCounts } from "@codecast/shared/tasks";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useIsPhone } from "../../../hooks/useIsPhone";
import { useTasksBackfilled } from "../../../hooks/useInitiatives";
import { cn } from "../../../lib/utils";
import { docTypeStyle } from "../../../lib/docTypeStyle";
import { buildBurndown, buildProgressSeries } from "../../../lib/projectProgress";
import { ProgressChart } from "../../../components/ProgressChart";
import { BurndownChart } from "../../../components/BurndownChart";
import { ProjectUpdates } from "../../../components/ProjectUpdates";
import { ProjectTimeline } from "../../../components/ProjectTimeline";
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
  Pin,
  ChevronRight,
  ChevronDown,
  Activity,
  CalendarClock,
  History,
  Megaphone,
  FolderOpen,
  Workflow,
} from "lucide-react";
import { ProjectLineTab } from "../../../components/line/ProjectLineTab";
import { ForeignWorkspaceNotice } from "../../../components/ForeignWorkspaceNotice";
import { useForeignWorkspace } from "../../../hooks/useForeignWorkspace";
import { taskPriority } from "../../../lib/taskPriority";
import { DocDates } from "../../../components/DocDates";
import { useSyncOrgTreeFeeder } from "../../../hooks/useSyncOrgTree";
import { ProjectLeadChip } from "../../../components/charter/ProjectLeadChip";
import { useProjectLead } from "../../../hooks/useProjectLead";
import { ProjectInitiatives } from "../../../components/initiatives/ProjectInitiatives";
import { ProgressBar, TargetDate } from "../../../components/initiatives/InitiativeAtoms";
import { IntentHeader, IntentIdChip, IntentPickChip, IntentTabs, IntentTargetChip, useIntentTab, type IntentTab } from "../../../components/initiatives/IntentHeader";
import { CharterBlock } from "../../../components/charter/CharterBlock";
import { charterOf, type CharterPatch } from "../../../components/charter/charterMeta";
import { InlineEdit } from "../../../components/org/OrgScopePanel";

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

/** Timestamp → the yyyy-mm-dd a date input wants, in local time. */
function toDateInput(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

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
  const pri = taskPriority(task.priority, "none");
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
  const dotColor = docTypeStyle(doc.doc_type).dot;

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
      <DocDates doc={doc} className="text-[10px] text-sol-text-dim flex-shrink-0" />
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

// Which face of the project you're on. Tasks is the default: a project is
// somewhere to work; the others are the ways you step back from it: overview
// for shape, updates for narration, timeline for the record.
const PROJECT_TABS = ["tasks", "overview", "updates", "timeline", "line"] as const;
type ProjectTab = (typeof PROJECT_TABS)[number];
const PROJECT_ACCENT = "var(--sol-cyan)";
const PROJECT_STATUS_OPTIONS = PROJECT_STATUS_ORDER.map((key) => {
  const Icon = PROJECT_STATUS[key].icon;
  return { key, label: PROJECT_STATUS[key].label, face: <Icon className={cn("w-3.5 h-3.5", PROJECT_STATUS[key].color)} /> };
});

function ProjectDetailContent() {
  const params = useParams();
  // The address names the project by its id, or by its `pj-` short id: a
  // project's card on a role's page and on a goal's page links that way.
  const projectRef = params.id as string;

  useSyncProjects();
  useSyncTasks();

  const { tab, setTab } = useIntentTab(PROJECT_TABS, `/projects/${projectRef}`);
  const phone = useIsPhone();
  const now = useCoarseNow(60_000);
  const counted = useTasksBackfilled();
  useSyncPlans();
  useSyncDocs();

  // Local-first: the page paints the STORE row, which holds every project the
  // rail lists and which updateProject patches in the same tick, so a project
  // you click renders now and a rename, a status pick or a new deadline shows
  // at once. The per view query only fills what the store has not cached yet:
  // its snapshot moves when the dispatch lands and the query re-runs, so the
  // store's word wins field by field.
  const storeProject = useInboxStore((s) => (projectRef ? (s.projects as any)[projectRef] ?? Object.values(s.projects as Record<string, any>).find((p) => p.short_id === projectRef) : undefined));
  const projectId: string = storeProject?._id ?? projectRef;
  const { data: serverProject } = useQueryNoThrow(api.projects.webGet, isConvexId(projectId) ? { id: projectId } : "skip");
  const project = useMemo(
    () => (serverProject || storeProject ? { ...(serverProject ?? {}), ...(storeProject ?? {}) } : undefined),
    [serverProject, storeProject],
  );

  // Workspace-scoped enumeration (the one sanctioned reader): the store caches
  // rows from every workspace viewed, so these lists must be keyed to the
  // active one before the project filter narrows them.
  const wsTasks = useWorkspaceCollection<TaskItem>("tasks");
  const wsPlans = useWorkspaceCollection<PlanItem>("plans");
  const wsDocs = useWorkspaceCollection<DocItem>("docs");

  const updateProject = useInboxStore((s) => s.updateProject);
  // A project opened from another workspace: its tasks, plans, docs and line
  // feed from the active workspace, so the page says where it lives instead
  // of drawing empty lists that are not true.
  const foreign = useForeignWorkspace(project);

  // The org tree feeds the store per view, the way the org page mounts it;
  // the page reads only the roles (useProjectLead), never the tree, so a
  // message under any node does not re-render it. Who leads the project, and
  // the way to name or hire a lead, is the header's ProjectLeadChip
  // (org-roles-run-work.md R4); `roles` is null while the tree on screen is
  // another workspace's, so the charter offers nothing the server would refuse.
  useSyncOrgTreeFeeder();
  const { roles: charterRoles } = useProjectLead(projectId);

  // The charter (org-staffing.md S7), from the same merged row.
  const charter = useMemo(() => charterOf(project ?? {}, "project"), [project]);
  const handleCharterChange = useCallback((patch: CharterPatch) => updateProject(projectId, patch), [projectId, updateProject]);

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

  // Remaining work projected forward — will this project hit its date?
  const burndown = useMemo(
    () => buildBurndown(progressSeries, project?.target_date, Date.now()),
    [progressSeries, project?.target_date]
  );

  // Docs in this project
  const projectDocs = useMemo(() =>
    wsDocs.filter((d: any) => d.project_id === projectId)
      .sort((a, b) => b.updated_at - a.updated_at),
    [wsDocs, projectId]
  );

  // How far along, by the rule the board and a goal's bar both count with
  // (@codecast/shared/tasks projectTaskCounts).
  const progress = useMemo(() => projectTaskCounts(wsTasks as any[], [projectId]), [wsTasks, projectId]);

  const handleStatusChange = useCallback((status: string) => {
    updateProject(projectId, { status });
    toast.success(`Project marked as ${status}`);
  }, [projectId, updateProject]);

  // A project's deadline is the end of its day in LOCAL time, so a project
  // "due Sep 26" is on time all of Sep 26, not just until midnight UTC.
  const handleDeadlineCommit = useCallback((day: string) => {
    const [y, m, d] = day.split("-").map(Number);
    const ts = new Date(y, m - 1, d, 23, 59, 59).getTime();
    if (ts !== project?.target_date) updateProject(projectId, { target_date: ts });
  }, [projectId, updateProject, project?.target_date]);
  // null rides through the dispatch to webUpdate, which drops the field.
  const handleDeadlineClear = useCallback(() => updateProject(projectId, { target_date: null }), [projectId, updateProject]);

  if (!project) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-sm text-sol-text-dim">Loading project…</div>
      </div>
    );
  }

  const status = projectStatusOf(project.status);
  const StatusIcon = status.icon;

  const hasContent = projectPlans.length > 0 || projectTasks.length > 0 || projectDocs.length > 0;
  // The Tasks tab carries no count of its own: the list below reports what it
  // is actually showing, and the header's bar counts the same rows by the
  // board's rule. Two numbers that disagree are worse than one.
  const tabs: IntentTab<ProjectTab>[] = [
    { key: "tasks", label: "Tasks", icon: ListChecks },
    { key: "overview", label: "Overview", icon: Target, count: projectPlans.length + projectDocs.length },
    { key: "updates", label: "Updates", icon: Megaphone },
    { key: "timeline", label: "Timeline", icon: History },
    // The project's line (LM7): its flow, sources, stations, versions.
    { key: "line", label: "Line", icon: Workflow },
  ];

  return (
    <div className="h-full flex flex-col" data-project-page={project._id} data-scope-tab-active={tab}>
      {/* The header a goal's page wears (components/initiatives/IntentHeader):
          the same title, the same line of chips, the same tab strip. */}
      <IntentHeader
        stripeClassName={projectDotClass(project)}
        accent={PROJECT_ACCENT}
        back={{ href: "/projects", label: "Back to projects" }}
        glyph={<span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${projectDotClass(project)}`} />}
        title={project.title}
        onRename={(title) => updateProject(projectId, { title })}
        renameLabel="Project title"
        titleData={{ "data-project-title": "" }}
        idChip={project.short_id ? <IntentIdChip id={project.short_id} accent={PROJECT_ACCENT} /> : null}
        share={<ShareControl label="project" path={`/projects/${project._id}`} publicShare={{ kind: "project", id: project._id, token: project.share_token }} />}
        phone={phone}
        // Line two, in a goal's order: status, who leads it, when it is due,
        // how far along, what is filed here, and the goals it is part of.
        chips={<>
          <IntentPickChip data-project-pick="status" options={PROJECT_STATUS_OPTIONS} value={project.status} width="w-44" onPick={(key) => { if (key && key !== project.status) handleStatusChange(key); }}>
            <StatusIcon className={cn("w-3.5 h-3.5", status.color)} />
            <span style={{ color: "var(--sol-text-secondary)" }}>{status.label}</span>
          </IntentPickChip>
          <ProjectLeadChip projectId={project._id} editable />

          {/* Deadline: the header's one target day control; the burndown projects against it. */}
          <IntentTargetChip
            data-project-pick="target"
            day={project.target_date ? toDateInput(project.target_date) : undefined}
            label="Project deadline"
            emptyLabel="No deadline"
            accent={PROJECT_ACCENT}
            onCommit={handleDeadlineCommit}
            onClear={handleDeadlineClear}
          >
            {project.target_date ? <TargetDate ts={project.target_date} now={now} done={project.status === "done"} local /> : null}
          </IntentTargetChip>

          {!foreign && <ProgressBar progress={progress} partial={!counted} className="w-[150px]" />}

          {/* What else is filed here: plans and docs. The bar already says the tasks. */}
          {projectPlans.length + projectDocs.length > 0 && (
            <span className="inline-flex items-center gap-3 text-[11.5px] tabular-nums" style={{ color: "var(--sol-text-dim)" }} data-project-counts>
              {projectPlans.length > 0 && (
                <span className="inline-flex items-center gap-1" title="Plans" data-project-count="plans"><Target className="w-3 h-3" /> {projectPlans.length}</span>
              )}
              {projectDocs.length > 0 && (
                <span className="inline-flex items-center gap-1" title="Docs" data-project-count="docs"><FileText className="w-3 h-3" /> {projectDocs.length}</span>
              )}
            </span>
          )}

          {/* The goals this project carries (initiatives-projects-role-page.md
              I1), each with its first number. Nothing renders when it is in none. */}
          <ProjectInitiatives projectId={project._id} size="xs" label="Part of" metrics="chip" />
        </>}
        extra={<>
          {project.description && (
            <p className="mt-2 max-w-[80ch] text-[12.5px] leading-relaxed" style={{ color: "var(--sol-text-muted)" }}>{project.description}</p>
          )}

          {/* The project's folder (org-staffing.md S35): where its work lives.
              It names the team of a new session there and groups evidence for
              the review; it holds no session, so editing it moves nothing. */}
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-sol-text-dim" title="The folder this project's work lives in. It holds no session: a lead takes a session only for the task or plan it is bound to, or when someone files it there.">
            <FolderOpen className="w-3 h-3 shrink-0" />
            <span className="shrink-0">Folder</span>
            <InlineEdit
              value={project.project_path ?? ""}
              placeholder="none"
              canEdit
              ariaLabel="Project folder"
              className="font-mono text-[11px] text-sol-text-dim w-auto min-w-[8rem] max-w-full truncate"
              onSave={(v) => { const next = v.trim(); if (next !== (project.project_path ?? "")) updateProject(projectId, { project_path: next || null }); }}
            />
          </div>

          <RepositoryLinks projectId={project._id} />

          {/* The charter sits above the tabs: the direction every tab serves. */}
          <CharterBlock
            kind="project"
            title={project.title}
            charter={charter}
            canEdit
            onChange={handleCharterChange}
            roles={charterRoles}
            hideOwner
            className="mt-3"
          />
        </>}
        // Tasks is the working surface; Overview is the summary of everything
        // filed here: plans, their tasks, and docs.
        tabs={<IntentTabs tabs={tabs} active={tab} onTab={setTab} accent={PROJECT_ACCENT} bare />}
      />

      {/* The project's tasks, through the same list surface /tasks uses —
          same filters, grouping, board, palette and saved views. */}
      {foreign ? (
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-[60rem] mx-auto px-4 sm:px-6 py-5"><ForeignWorkspaceNotice foreign={foreign} what="project" /></div>
        </div>
      ) : tab === "tasks" ? (
        <div className="flex-1 min-h-0">
          <TaskListContent projectId={projectId} />
        </div>
      ) : tab === "updates" ? (
        <div className="flex-1 overflow-y-auto">
          <ProjectUpdates projectId={projectId} />
        </div>
      ) : tab === "timeline" ? (
        <div className="flex-1 overflow-y-auto">
          <ProjectTimeline projectId={projectId} />
        </div>
      ) : tab === "line" ? (
        <div className="flex-1 overflow-y-auto">
          <ProjectLineTab projectId={project._id} />
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

          <SectionHeader icon={CalendarClock} label="Burndown" count={0} />
          <div className="px-1 pb-2">
            <BurndownChart burndown={burndown} />
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
