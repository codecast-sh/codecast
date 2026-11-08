"use client";
// A project's page: where its work happens. One header row (the way up to
// the Projects list, its name, status, lead, Share, and the menu of its views)
// over the view picked. It opens on Session, the project's default session,
// with the rest of its sessions in the inbox beside it (the Inbox toggle
// filters it to the project). The other views sit in the menu: Tasks, the
// list /tasks uses; Timeline, everything that happened with the update
// composer on top; About, what it is for, its charter, deadline, the goals it
// serves and its repositories; Flow, how its problems run; and Expectations,
// how its product should behave. The address names a
// project by its `pj-` id; an older link by its Convex id moves to that form
// once the store names it.
import { ShareControl } from "../../../components/ShareControl";
import { policyTeamOf } from "@codecast/shared/contracts";
import { ProjectAbout } from "./ProjectAbout";
import { useMemo, useCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { api as _api } from "@codecast/convex/convex/_generated/api";
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
import { ChevronDown, Copy, History, LayoutGrid, Info, ListChecks, MessagesSquare, ScrollText, Workflow } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { ProjectSession } from "../../../components/projects/ProjectSession";
import { projectDefaultSessionOf } from "../../../lib/projectDefaultSession";
import { ProjectInboxFilter } from "../../../components/projects/ProjectInboxFilter";
import { ProjectLineTab } from "../../../components/line/ProjectLineTab";
import { ExpectationsTab } from "../../../components/expectations/ExpectationsTab";
import { ForeignWorkspaceNotice } from "../../../components/ForeignWorkspaceNotice";
import { useForeignWorkspace } from "../../../hooks/useForeignWorkspace";
import { useSyncOrgTreeFeeder } from "../../../hooks/useSyncOrgTree";
import { ProjectLeadChip } from "../../../components/charter/ProjectLeadChip";
import { ProjectInitiatives } from "../../../components/initiatives/ProjectInitiatives";
import { IntentHeader, IntentIdChip, ProjectDeadlineChip, ProjectStatusPick, useIntentTab, type IntentTab } from "../../../components/initiatives/IntentHeader";
import { useWorkspaceFeature } from "../../../lib/teamFeatures";
import { projectStatusOf } from "../../../lib/projectStatus";
import { projectTaskCounts } from "@codecast/shared/tasks";

const api = _api as any;

// The project's views. Session is the default: a project is somewhere work
// happens, and its default session is where you take part in it. Tasks is
// what is to do, Timeline is what happened, with the next update on top; Flow
// is how work flows through it. The key stays "sessions" so old links land.
const PROJECT_TABS = ["sessions", "tasks", "timeline", "about", "flow", "expectations"] as const;
type ProjectTab = (typeof PROJECT_TABS)[number];
const PROJECT_ACCENT = "var(--sol-cyan)";
const TABS: IntentTab<ProjectTab>[] = [
  // The project as a workspace (session-projects.md SP5): its default session.
  { key: "sessions", label: "Session", icon: MessagesSquare },
  { key: "tasks", label: "Tasks", icon: ListChecks },
  { key: "timeline", label: "Timeline", icon: History },
  // What it is for, its charter, its repositories.
  { key: "about", label: "About", icon: Info },
  // The project's flow (LM7): its sources, steps, versions.
  { key: "flow", label: "Flow", icon: Workflow },
  // How its product should behave (the-line-model.md LM5), each line quoted from where it was said.
  { key: "expectations", label: "Expectations", icon: ScrollText },
];
/** Tabs the board no longer has, read as the one that holds them now. */
const OLD_TABS: Record<string, ProjectTab> = { updates: "timeline", overview: "sessions", line: "flow" };


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
  const lineShown = useWorkspaceFeature("line");
  const asked: ProjectTab = OLD_TABS[search.get("tab") ?? ""] ?? picked;
  const tab: ProjectTab = asked === "flow" && !lineShown ? "tasks" : asked;
  const tabs = lineShown ? TABS : TABS.filter((t) => t.key !== "flow");

  // One project, one address (D17): an older link by Convex id moves to the
  // `pj-` form once the store names it, keeping the open task and the tab.
  useWatchEffect(() => {
    const short = project?.short_id;
    if (!short || projectRef === short) return;
    const qs = search.toString();
    router.replace(`/projects/${short}${taskRef ? `/${taskRef}` : ""}${qs ? `?${qs}` : ""}`);
  }, [project?.short_id, projectRef]);

  const updateProject = useInboxStore((s) => s.updateProject);
  // Whether the project has a main session (its Inbox count leaves it out).
  const hasMain = useInboxStore((s) => (storeProject ? !!projectDefaultSessionOf(storeProject, s.sessions, s.orgTree?.roles as any) : false));
  // Open tasks, for the Tasks row of the views menu.
  const openTasks = useInboxStore((s) => { const n = projectTaskCounts(Object.values(s.tasks ?? {}) as any[], [projectId]); return n.total - n.done; });
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

  const body = "flex-1 min-h-0 overflow-y-auto";

  return (
    <div className="h-full flex flex-col" data-project-page={project._id} data-scope-tab-active={tab}>
      <IntentHeader
        accent={PROJECT_ACCENT}
        back={{ href: "/projects", label: "Projects" }}
        glyph={<span className={cn("w-2 h-2 rotate-45 rounded-[2px] flex-shrink-0", projectDotClass(project))} data-project-glyph />}
        title={project.title}
        onRename={(title) => updateProject(projectId, { title })}
        renameLabel="Project title"
        titleData={{ "data-project-title": "" }}
        // The session view is the session: the id and the other facts wait
        // on the other views, and the row stays one line at any width.
        idChip={project.short_id && tab !== "sessions" ? <IntentIdChip id={project.short_id} /> : null}
        phone={phone}
        dense={tab === "sessions"}
        chipsBelow={tab !== "sessions"}
        chips={<>
          <ProjectStatusPick status={project.status} onPick={handleStatusChange} data-project-pick="status" face={tab === "sessions" ? <ProjectStatusIcon status={project.status} /> : undefined} />
          <ProjectLeadChip projectId={project._id} editable faceOnly={tab === "sessions"} />
          {/* The session view keeps to who runs it; the deadline and the
              goals it serves (initiatives-projects-role-page.md I1) show on
              the other views. */}
          {tab !== "sessions" && <>
            <ProjectDeadlineChip project={project} now={now} data-project-pick="target" />
            <ProjectInitiatives projectId={project._id} size="xs" label="Serves" />
          </>}
        </>}
        actions={<>
          {/* Off the session, the one-press way back to it. */}
          {tab !== "sessions" && (
            <button type="button" onClick={() => setTab("sessions")} className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[11px] text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt/60 transition-colors" data-project-back-to-session>
              <MessagesSquare className="w-3 h-3" />
              Session
            </button>
          )}
          <ProjectViewMenu tabs={tabs} active={tab} onTab={setTab} counts={{ tasks: openTasks }} shortId={project.short_id} />
          <ProjectInboxFilter projectId={project._id} hasMain={hasMain} />
          <ShareControl label="project" path={`/projects/${project.short_id || project._id}`} publicShare={{ kind: "project", id: project._id, token: project.share_token, team: policyTeamOf("projects", project) }} />
        </>}
      />

      {/* The Line and Expectations tabs read where the project lives, so they
          show from any workspace, under a note that names that workspace. */}
      {foreign && (tab === "flow" || tab === "expectations") ? (
        <div className={body}>
          <div className="max-w-[78rem] mx-auto px-4 sm:px-6 pt-5"><ForeignWorkspaceNotice foreign={foreign} what="project" readable /></div>
          {tab === "flow" ? <ProjectLineTab projectId={project._id} /> : <ExpectationsTab projectId={project._id} />}
        </div>
      ) : foreign ? (
        <div className={body}>
          <div className="max-w-[60rem] mx-auto px-4 sm:px-6 py-5"><ForeignWorkspaceNotice foreign={foreign} what="project" /></div>
        </div>
      ) : tab === "sessions" ? (
        <ProjectSession project={project} onOpenAbout={() => setTab("about")} />
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
      ) : tab === "about" ? (
        <div className={body}>
          <ProjectAbout project={project} />
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

/** The status as its icon alone, for the session view's one-line header;
 *  the word is in the tooltip and the list it opens. */
function ProjectStatusIcon({ status }: { status: string | undefined }) {
  const st = projectStatusOf(status);
  const Icon = st.icon;
  return <span className="inline-flex" title={`${st.label}. Click to change`}><Icon className={cn("w-3.5 h-3.5", st.color)} /></span>;
}

/** The project's views as one menu: the page shows one view at a time, and
 *  the trigger names the one on screen. */
function ProjectViewMenu({ tabs, active, onTab, counts, shortId }: { tabs: IntentTab<ProjectTab>[]; active: ProjectTab; onTab: (t: ProjectTab) => void; counts?: Partial<Record<ProjectTab, number>>; shortId?: string }) {
  const current = tabs.find((t) => t.key === active) ?? tabs[0];
  // On the session, the trigger is the way to everything else.
  const Icon = active === "sessions" ? LayoutGrid : current.icon;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" title="Tasks, timeline, about and the project's other views" className="inline-flex items-center gap-1 h-6 px-2 rounded-md text-[11px] text-sol-text-dim hover:text-sol-text hover:bg-sol-bg-alt/60 transition-colors" data-project-view={active}>
          {Icon && <Icon className="w-3 h-3" />}
          {/* On the session the menu says only that there are other views. */}
          {active !== "sessions" && current.label}
          <ChevronDown className="w-3 h-3 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[10rem]">
        {tabs.map((t) => {
          const TIcon = t.icon;
          return (
            <DropdownMenuItem key={t.key} onSelect={() => onTab(t.key)} className={cn("gap-2 text-xs", t.key === active && "text-sol-cyan")}>
              {TIcon && <TIcon className="w-3.5 h-3.5" />}
              {t.label}
              {!!counts?.[t.key] && <span className="ml-auto pl-3 font-mono tabular-nums text-sol-text-dim">{counts[t.key]}</span>}
            </DropdownMenuItem>
          );
        })}
        {/* The id people and agents quote, which the session view's header leaves out. */}
        {shortId && <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => { void navigator.clipboard?.writeText(shortId); toast.success(`Copied ${shortId}`); }}
            className="gap-2 text-xs font-mono text-sol-text-dim"
            title="Copy the project's id"
          >
            <Copy className="w-3.5 h-3.5" />
            {shortId}
          </DropdownMenuItem>
        </>}
      </DropdownMenuContent>
    </DropdownMenu>
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
