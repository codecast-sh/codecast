"use client";
// A project's work board (cohesive build spec §5.3, D10, D17): where a
// project's daily work happens. One header row (the way up to the Projects
// list on the Org screen, its name, status, lead, the goals it serves, About
// and Share) over four tabs: Tasks, the list /tasks uses; Timeline,
// everything that happened with the update composer on top; Line, the
// project's flow; and Expectations, how its product should behave. What the
// project is for, where it stands and its charter are its sheet
// (/org/pj-…), which About opens. The address names a
// project by its `pj-` id; an older link by its Convex id moves to that form
// once the store names it.
import { ShareControl } from "../../../components/ShareControl";
import { useMemo, useCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { objectHref } from "@codecast/shared/entities";
import { useInboxStore } from "../../../store/inboxStore";
import { isConvexId } from "../../../lib/entityLinks";
import { useSyncTasks } from "../../../hooks/useSyncTasks";
import { TaskListContent } from "../../tasks/page";
import { TaskDetailContent } from "../../tasks/[id]/page";
import { DetailSplitLayout } from "../../../components/DetailSplitLayout";
import { ErrorBoundary } from "../../../components/ErrorBoundary";
import { projectDotClass } from "../../../lib/projectColors";
import { useCoarseNow } from "../../../hooks/useCoarseNow";
import { useIsPhone } from "../../../hooks/useIsPhone";
import { useWatchEffect } from "../../../hooks/useWatchEffect";
import { cn } from "../../../lib/utils";
import { ProjectTimeline } from "../../../components/ProjectTimeline";
import { useSyncProjects } from "../../../hooks/useSyncProjects";
import { useQueryNoThrow } from "../../../hooks/useQueryNoThrow";
import { AuthGuard } from "../../../components/AuthGuard";
import { DashboardLayout } from "../../../components/DashboardLayout";
import { toast } from "sonner";
import Link from "next/link";
import { History, ListChecks, ScrollText, Workflow } from "lucide-react";
import { ProjectLineTab } from "../../../components/line/ProjectLineTab";
import { ExpectationsTab } from "../../../components/expectations/ExpectationsTab";
import { ForeignWorkspaceNotice } from "../../../components/ForeignWorkspaceNotice";
import { useForeignWorkspace } from "../../../hooks/useForeignWorkspace";
import { useSyncOrgTreeFeeder } from "../../../hooks/useSyncOrgTree";
import { ProjectLeadChip } from "../../../components/charter/ProjectLeadChip";
import { ProjectInitiatives } from "../../../components/initiatives/ProjectInitiatives";
import { IntentHeader, IntentIdChip, IntentTabs, ProjectDeadlineChip, ProjectStatusPick, useIntentTab, type IntentTab } from "../../../components/initiatives/IntentHeader";

const api = _api as any;

// The board's three faces. Tasks is the default: a project is somewhere to
// work. Timeline is what happened, with the next update on top; Line is how
// work flows through it.
const PROJECT_TABS = ["tasks", "timeline", "line", "expectations"] as const;
type ProjectTab = (typeof PROJECT_TABS)[number];
const PROJECT_ACCENT = "var(--sol-cyan)";
const TABS: IntentTab<ProjectTab>[] = [
  { key: "tasks", label: "Tasks", icon: ListChecks },
  { key: "timeline", label: "Timeline", icon: History },
  // The project's line (LM7): its flow, sources, stations, versions.
  { key: "line", label: "Line", icon: Workflow },
  // How its product should behave (the-line-model.md LM5), each line quoted from where it was said.
  { key: "expectations", label: "Expectations", icon: ScrollText },
];
/** Tabs the board no longer has, read as the one that holds them now. */
const OLD_TABS: Record<string, ProjectTab> = { updates: "timeline", overview: "tasks" };

const actionCls = "inline-flex h-[26px] items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 text-[12px] no-underline transition-colors hover:bg-sol-bg-highlight/60";

function ProjectDetailContent() {
  const params = useParams();
  // The address names the project by its `pj-` short id, or by its id in an older link.
  const projectRef = params.id as string;
  const taskRef = params?.taskId as string | undefined;
  const router = useRouter();
  const search = useSearchParams();

  useSyncProjects();
  useSyncTasks();

  const phone = useIsPhone();
  const now = useCoarseNow(60_000);

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
  const address = project?.short_id || projectRef;
  const { tab: picked, setTab } = useIntentTab(PROJECT_TABS, `/projects/${address}`);
  const tab: ProjectTab = OLD_TABS[search.get("tab") ?? ""] ?? picked;

  // One project, one address (D17): an older link by Convex id moves to the
  // `pj-` form once the store names it, keeping the open task and the tab.
  useWatchEffect(() => {
    const short = project?.short_id;
    if (!short || projectRef === short) return;
    const qs = search.toString();
    router.replace(`/projects/${short}${taskRef ? `/${taskRef}` : ""}${qs ? `?${qs}` : ""}`);
  }, [project?.short_id, projectRef]);

  const updateProject = useInboxStore((s) => s.updateProject);
  // A project opened from another workspace: its tasks, plans, docs and line
  // feed from the active workspace, so the page says where it lives instead
  // of drawing empty lists that are not true.
  const foreign = useForeignWorkspace(project);

  // The org tree feeds the store per view, the way the org page mounts it:
  // the lead chip reads its roles from there.
  useSyncOrgTreeFeeder();

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

  const sheet = objectHref("project", project.short_id || project._id);
  const body = "flex-1 min-h-0 overflow-y-auto";

  return (
    <div className="h-full flex flex-col" data-project-page={project._id} data-scope-tab-active={tab}>
      <IntentHeader
        accent={PROJECT_ACCENT}
        back={{ href: "/org/projects", label: "Projects" }}
        glyph={<span className={cn("w-2 h-2 rotate-45 rounded-[2px] flex-shrink-0", projectDotClass(project))} data-project-glyph />}
        title={project.title}
        onRename={(title) => updateProject(projectId, { title })}
        renameLabel="Project title"
        titleData={{ "data-project-title": "" }}
        idChip={project.short_id ? <IntentIdChip id={project.short_id} /> : null}
        phone={phone}
        chips={<>
          <ProjectStatusPick status={project.status} onPick={handleStatusChange} data-project-pick="status" />
          <ProjectLeadChip projectId={project._id} editable />
          <ProjectDeadlineChip project={project} now={now} data-project-pick="target" />
          {/* The goals it serves (initiatives-projects-role-page.md I1). Nothing renders when it serves none. */}
          <ProjectInitiatives projectId={project._id} size="xs" label="Serves" />
        </>}
        actions={<>
          <Link href={sheet} className={actionCls} style={{ borderColor: "color-mix(in srgb, var(--sol-border) 45%, transparent)", color: "var(--sol-text-secondary)" }} data-project-about>About</Link>
          <ShareControl label="project" path={`/projects/${project.short_id || project._id}`} publicShare={{ kind: "project", id: project._id, token: project.share_token }} />
        </>}
        tabs={<IntentTabs tabs={TABS} active={tab} onTab={setTab} accent={PROJECT_ACCENT} bare />}
      />

      {/* The Line and Expectations tabs read where the project lives, so they
          show from any workspace, under a note that names that workspace. */}
      {foreign && (tab === "line" || tab === "expectations") ? (
        <div className={body}>
          <div className="max-w-[78rem] mx-auto px-4 sm:px-6 pt-5"><ForeignWorkspaceNotice foreign={foreign} what="project" readable /></div>
          {tab === "line" ? <ProjectLineTab projectId={project._id} /> : <ExpectationsTab projectId={project._id} />}
        </div>
      ) : foreign ? (
        <div className={body}>
          <div className="max-w-[60rem] mx-auto px-4 sm:px-6 py-5"><ForeignWorkspaceNotice foreign={foreign} what="project" /></div>
        </div>
      ) : tab === "tasks" ? (
        // The project's tasks, through the same list surface /tasks uses:
        // same filters, grouping, board, palette and saved views.
        <div className="flex-1 min-h-0">
          <TaskListContent projectId={projectId} />
        </div>
      ) : tab === "timeline" ? (
        <div className={body}>
          <ProjectTimeline projectId={projectId} />
        </div>
      ) : tab === "expectations" ? (
        <div className={body}>
          <ExpectationsTab projectId={project._id} />
        </div>
      ) : (
        <div className={body}>
          <ProjectLineTab projectId={project._id} />
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
