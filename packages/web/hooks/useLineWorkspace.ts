"use client";
// The line app's hooks (docs/architecture/line-workspace.md LW1, LW2):
// one model for every view, the shared selection in the URL, and what a
// station was handed, read on demand. Every row comes from the store; the
// feeders here only feed it, and the readers wake on signatures of the fields
// the model reads, never on whole collections.
//
//   useLineWorkspace(projectId, graphKey)  the model (lib/line/lineModel.ts); projectId null is every project
//   useLineSelection()                     { selection, select } in the URL
//   useStationInput(sessionId, runId)      a station's brief, fed when opened
//   store action labelDecision(runId, nodeId, verdict, note)
import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { parsePrRef } from "@codecast/shared/contracts";
import type { SessionDecisionItem } from "../store/inboxStore";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import { useFeederWorkspace } from "./useWorkspaceArgs";
import { useActiveWorkspaceKey, useWorkspaceCollection } from "./useWorkspaceCollection";
import { useSyncRuns } from "./useSyncRuns";
import { useSyncTaskSignals } from "./useSyncSignals";
import { useSyncTrial, useTrialCards, useTrialProjects } from "./useSyncTrial";
import { useTeamRosterIdentity } from "./useTeamRoster";
import { autoStartWord, isCause, scopeLine, type LineAdmission, type LineProject, type RollupRow } from "../lib/lineFlow";
import { buildLineModel, type DeployRow, type LineGraphSource, type LineLabelRow, type LineModel, type LineModelRows, type OccurrenceRow } from "../lib/line/lineModel";
import type { MapDecision, MapRun, MapSignal } from "../lib/line/lineMap";
import { graphPickOrder, processIndex, projectGraphs, type GraphRun, type ProjectGraph } from "../lib/line/lineGraphs";
import { buildLineInbox, inboxByGraph, inboxCount, inboxKindByCase, inboxProcessOf, lineProjectCounts, type InboxGroup } from "../lib/line/lineInbox";
import { lineSelectionPushes, lineSelectionSearch, readLineSelection, resolveLineProject, type LineSelection, type LineSelectionPatch } from "../lib/line/lineWorkspaceUrl";
import { useLineFloor, useProjectWorkspace } from "../components/line/useLineFloor";
import { useLineGraph } from "../components/line/map/useLineGraph";
import { useLoopSteps, useProductName } from "./useLoopSteps";
import type { LoopSteps } from "../lib/line/loopSteps";
import { problemOrigins, type ProblemSource } from "../lib/line/stepRuns";
import { activeProblemCount, isCountedActive, lessonOnlyIds } from "../lib/line/problemTable";
import { problemOverlaps, type Overlap } from "../lib/line/overlap";

const api = _api as any;
const EMPTY: never[] = [];

export type { LineSelection, LineSelectionPatch, LineView } from "../lib/line/lineWorkspaceUrl";
export { LINE_VIEWS, DEFAULT_LINE_VIEW } from "../lib/line/lineWorkspaceUrl";

// ── signatures: the fields the model reads ───────────────────────────────────

const labelSig = (l: LineLabelRow) => `${l.key}|${l.verdict}|${l.note ?? ""}|${l.at}`;
const occurrenceSig = (o: OccurrenceRow) => `${o.task_id}|${o.observed.length}|${o.observed[o.observed.length - 1] ?? 0}|${o.reopened.length}|${o.capped ? 1 : 0}`;
const deploySig = (d: DeployRow) => `${d.at}|${d.sha ?? ""}|${d.surface ?? d.environment ?? ""}`;
const cardSig = (d: MapDecision) => `${d.status}|${d.answer_index ?? ""}|${d.answer_text ?? ""}|${d.resolved_at ?? 0}|${d.card?.headline ?? ""}|${d.card?.change ?? ""}`;

// ── feeders ──────────────────────────────────────────────────────────────────

/** Feeder: a workspace's line labels; the active one unless `workspace` names another. */
export function useSyncLineLabels(workspace?: string | null) {
  const { args } = useFeederWorkspace(workspace);
  const teamId = args === "skip" ? "skip" : args.team_id ?? "";
  const queryArgs = useMemo(() => (teamId === "skip" ? "skip" : teamId ? { team_id: teamId } : {}), [teamId]);
  return useSyncCollection("lineLabels", api.lineWorkspace.labels, queryArgs as any);
}

/** Feeder: one project's history: its causes' occurrences, its recorded deploys
 *  (on its repositories and those its merges name), and every line card on its causes.
 *  The line over every project mounts one per project (LineHistoryFeeds). */
export function useSyncLineHistory(projectId: string | null, repositories: string) {
  const projectArgs = useMemo(() => (projectId ? { project_id: projectId } : "skip"), [projectId]);
  const deployArgs = useMemo(() => (projectId ? { project_id: projectId, ...(repositories ? { repositories: repositories.split(",") } : {}) } : "skip"), [projectId, repositories]);
  useSyncCollection("lineOccurrences", api.lineWorkspace.occurrences, projectArgs as any);
  const deploys = useSyncCollection("lineDeploys", api.lineWorkspace.deploys, deployArgs as any);
  useSyncCollection("lineCards", api.lineWorkspace.cards, projectArgs as any);
  return { deploysReady: deploys.ready };
}

// ── the model ────────────────────────────────────────────────────────────────

/** The repositories a project's merges name, sorted, as one stable key. */
const repositoriesOf = (runs: ReadonlyArray<{ merge?: { pr_url?: string } | null }>) =>
  [...new Set(runs.map((r) => parsePrRef(r.merge?.pr_url)?.repository).filter((r): r is string => !!r))].sort().join(",");

/** Cards from the viewer's own queue win over the line's copy: the queue is a card's live home. */
function mergeCards(home: ReadonlyArray<MapDecision>, line: ReadonlyArray<MapDecision>): MapDecision[] {
  const byId = new Map<string, MapDecision>();
  for (const d of line) byId.set(d._id, d);
  for (const d of home) byId.set(d._id, d);
  return [...byId.values()];
}

/** The rows in view, as the floor holds them: every project's, or one project's. */
export type LineScopedRows = ReturnType<typeof useLineFloor>["lineRows"];

export type LineWorkspace = {
  model: LineModel | null;
  /** The project the line is filtered to; null when it shows every project. */
  project: LineProject | null;
  /** The project a write from the line goes to (a chat, a try, a request to an agent): the filtered
   *  one, else the project holding most of the drawn process's runs. */
  home: LineProject | null;
  /** Every project in the workspace, for the filter. */
  projects: LineProject[];
  /** The graph the model draws, after an unknown or missing key falls back to the busiest. */
  graphKey: string | null;
  /** The drawn graph's own row could not be read: its steps come from what its runs recorded. */
  unread: boolean;
  now: number;
  /** The filtered project's row in the floor's roll-up. Null over every project, or when it has nothing on its line. */
  rollup: RollupRow | null;
  /** Every project's roll-up row in view: the one filtered, or all of them. */
  rollups: RollupRow[];
  /** Every project's roll-up row, whatever the filter: what the project filter lists. */
  allRollups: RollupRow[];
  /** Each project's start switch and slots, by project id (useLineAdmissions). */
  admissions: ReadonlyMap<string, LineAdmission>;
  /** Trial projects (convex lineTrial.ts): their runs start on their own, under the trial's dispatch, not a role's switch. */
  trialProjects: ReadonlySet<string>;
  /** The rows in view: signals (findings, with source, judge, severity, detail and evidence), cause tasks, runs and the viewer's cards. */
  rows: LineScopedRows;
  /** Projects whose history (occurrences, deploys, cards) the shell feeds: those with problems in the process drawn, other than the filtered one (fed here), with the repositories their merges name. */
  historyFeeds: Array<{ projectId: string; repositories: string }>;
  /** The loop's front half (loopSteps, learning-loop.md LL1) of the filtered project; null over every project. */
  loop: LoopSteps | null;
  /** The product's name as a reader says it ("Union"), for "runs in Union" and "Fixes in Union". */
  product: string | null;
  /** What waits on the viewer in the process drawn and the project filter (lineInbox), computed once for the header and the Inbox. */
  inbox: InboxGroup[];
  forYou: number;
  /** Problems not closed in the process drawn, under the filter (problemTable activeProblemCount): the nav's, the filter's and Chat's one count. */
  open: number;
  /** The for-you rows by process (processIndex), under the project filter: the picker's counts. The drawn one equals `forYou`. */
  forYouByGraph: Map<string, number>;
  /** Which process each problem, finding or project belongs to (lineGraphs processIndex), over the rows in view. */
  process: ReturnType<typeof processIndex>;
  /** Per project, over every project, in the process drawn: rows waiting on the viewer, and problems not done. */
  byProject: Map<string, { forYou: number; open: number }>;
  /** Every process any project's problems run, in picker order, whatever the project filter: the picker's fixed set. */
  processes: ProjectGraph[];
  /** Where each problem came from (stepRuns problemSources), by task id: its source, judge and reporter. One reading every row's source chip shows. */
  sources: Map<string, ProblemSource>;
  /** People's names by user id: who answered a card, who labeled a decision. */
  names: ReadonlyMap<string, string>;
  /** The findings and runs feeds have both answered this load: before that, every count here is the cache's and may still move. */
  ready: boolean;
  /** Each active problem's duplicate set (near-identical titles, filed under the oldest) and the rule its findings cite. */
  overlaps: ReadonlyMap<string, Overlap>;
};

/**
 * The line as every view reads it (lineModel buildLineModel), over every
 * project (`projectId` null) or filtered to one. The rows come from the line
 * floor (signals, causes, runs, cards); the drawn graph from the project's
 * stations or the row its newest run ran; the history from the occurrence,
 * deploy and card reads. `graphKey` picks the process (null: the busiest);
 * `caseId` feeds every run and every finding of the case being read, which
 * the floor's newest-runs window and two-week findings may not hold. Over every project the history feeders
 * are mounted by the shell, one per project (`historyFeeds`).
 */
export function useLineWorkspace(projectId: string | null, graphKey: string | null, caseId?: string | null): LineWorkspace {
  const projectRow = useInboxStore((s) => (projectId ? ((s.projects as Record<string, LineProject>)?.[projectId] ?? null) : null));
  const workspace = useProjectWorkspace(projectRow as { workspace?: string | null; team_id?: string | null } | null);
  const { now, lineRows, projects, rollup: rollupRows, admissions, ready } = useLineFloor(projectId, workspace);
  const rollup = useMemo(() => (projectId ? rollupRows.find((r) => r.key === projectId) ?? null : null), [rollupRows, projectId]);
  const rollups = useMemo(() => (projectId ? (rollup ? [rollup] : []) : rollupRows), [projectId, rollup, rollupRows]);
  const project = projectId ? projectRow ?? projects.find((p) => p._id === projectId) ?? null : null;
  useSyncRuns(caseId ? { task_id: caseId, limit: 50 } : {}, !!caseId, workspace);
  useSyncTaskSignals(caseId);

  // The process is what runs on problems: a run of any other workflow on a task is not the line's.
  const scoped = useMemo(() => {
    const rows = projectId ? scopeLine(lineRows, projectId) : lineRows;
    const causes = new Set(rows.tasks.filter(isCause).map((t) => t._id));
    return { ...rows, runs: rows.runs.filter((r) => !!r.task_id && causes.has(r.task_id)) };
  }, [lineRows, projectId]);
  const runs = scoped.runs as unknown as MapRun[];
  const signals = scoped.signals as MapSignal[];
  // The processes over every project, so the picker never changes with the filter.
  const processes = useMemo(() => {
    const causes = new Set(lineRows.tasks.filter(isCause).map((t) => t._id));
    return graphPickOrder(projectGraphs((lineRows.runs as unknown as GraphRun[]).filter((r) => !!r.task_id && causes.has(r.task_id))));
  }, [lineRows]);

  // The graph: the project's own stations for codecast's line, else the row its newest run ran.
  const lg = useLineGraph(projectId, runs as unknown as GraphRun[], signals, graphKey);
  const row = lg.row;
  const graph: LineGraphSource | null = useMemo(() => {
    if (lg.ownLine) return lg.source ? { nodes: lg.source.nodes, edges: lg.source.edges } : null;
    return row?.nodes?.length ? { nodes: row.nodes, edges: row.edges ?? [], source: row.source ?? null, name: row.name ?? null } : null;
  }, [lg.ownLine, lg.source, row]);

  // Labels, history and cards.
  useSyncLineLabels(workspace);
  const labels = useWorkspaceCollection<LineLabelRow & { workspace: string }>("lineLabels", labelSig, workspace);
  const taskProject = useMemo(() => new Map(scoped.tasks.map((t) => [t._id, (t as { project_id?: string | null }).project_id ?? null])), [scoped]);
  const everyTaskProject = useMemo(() => new Map(lineRows.tasks.map((t) => [t._id, (t as { project_id?: string | null }).project_id ?? null])), [lineRows.tasks]);
  // Each project's repositories, so its deploys read where its merges went.
  const repositories = useMemo(() => {
    const by = new Map<string, Array<{ merge?: { pr_url?: string } | null }>>();
    for (const r of lineRows.runs as unknown as Array<{ task_id?: string; merge?: { pr_url?: string } | null }>) {
      const p = r.task_id ? everyTaskProject.get(r.task_id) : null;
      if (p) by.set(p, [...(by.get(p) ?? []), r]);
    }
    return new Map([...by].map(([p, rs]) => [p, repositoriesOf(rs)]));
  }, [lineRows.runs, everyTaskProject]);
  const { deploysReady: ownDeploysReady } = useSyncLineHistory(projectId, projectId ? repositories.get(projectId) ?? "" : "");
  const deploysReady = projectId ? ownDeploysReady : true;
  // History is read for every project (the project filter's counts read every project's problems), held in the store
  // whatever the filter; a row is narrowed to the filter at read time.
  const anyProject = useCallback((r: { project_id?: string }) => !!r.project_id, []);
  const allOccurrences = useCollectionRows<OccurrenceRow & { project_id?: string }>("lineOccurrences", { where: anyProject, sig: occurrenceSig });
  const allDeploys = useCollectionRows<DeployRow & { project_id?: string }>("lineDeploys", { where: anyProject, sig: deploySig });
  const allLineCards = useCollectionRows<MapDecision & { project_id?: string }>("lineCards", { where: anyProject, sig: cardSig });
  const ownCardWhere = useMemo(() => (d: SessionDecisionItem) => !!d.task_id && everyTaskProject.has(d.task_id) && !!d.workflow_run_id, [everyTaskProject]);
  const ownCards = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where: ownCardWhere, sig: cardSig as unknown as (d: SessionDecisionItem) => string });
  const allDecisions = useMemo(() => mergeCards(ownCards as unknown as MapDecision[], allLineCards), [ownCards, allLineCards]);

  const roster = useTeamRosterIdentity();
  const names = useMemo(() => new Map(roster.map((m) => [m._id, m.name ?? m.email ?? ""])), [roster]);
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const trialRows = useTrialProjects();
  const trialProjects = useMemo(() => new Set(trialRows.map((p) => p._id)), [trialRows]);
  // A problem whose project starts nothing on its own says so in a word, read from its own project's switch (LL5);
  // a trial project's runs start on their own.
  const holdOf = useCallback((p: string | null) => (p && !trialProjects.has(p) ? autoStartWord(admissions.get(p)) : null), [admissions, trialProjects]);
  const watchDays = (project as { line_profile?: { watch_days?: number } | null } | null)?.line_profile?.watch_days ?? null;

  // The heaviest derivation on the page (it runs the flow over every row): once here, read by the shell and the Inbox.
  // Built over every project and narrowed to the filter, so the project filter's "for you" and the header's agree.
  const everyRow = useMemo(() => {
    if (!projectId) return scoped;
    const causes = new Set(lineRows.tasks.filter(isCause).map((t) => t._id));
    return { ...lineRows, runs: lineRows.runs.filter((r) => !!r.task_id && causes.has(r.task_id)) };
  }, [projectId, scoped, lineRows]);
  // Trial cards: a trial run's gates ask no one, so they wait here as the Inbox's own group (fed as /trial feeds them).
  useSyncTrial();
  const trialCards = useTrialCards();
  const allInbox = useMemo(() => buildLineInbox({ ...everyRow, projects, rollups: rollupRows, admissions, trialCards, trialProjects, now }), [everyRow, projects, rollupRows, admissions, trialCards, trialProjects, now]);
  const projectInbox = useMemo(() => (projectId ? allInbox.map((g) => ({ ...g, rows: g.rows.filter((r) => r.projectId === projectId) })).filter((g) => g.rows.length > 0) : allInbox), [allInbox, projectId]);
  const forYouByCase = useMemo(() => inboxKindByCase(projectInbox), [projectInbox]);

  // One model over every project's rows: the project filter's counts read it, so a project's numbers are the same
  // picked or not. Filtered, the views read the same builder over the project's own rows.
  const modelOf = useCallback((rows: { runs: unknown[]; tasks: LineModelRows["tasks"]; signals: unknown[] }, project: string | null, forYou: Map<string, string>, deploysRead: boolean) => {
    const mine = (r: { project_id?: string }) => !project || r.project_id === project;
    const deploys = allDeploys.filter(mine);
    return buildLineModel({
      runs: rows.runs as MapRun[],
      tasks: rows.tasks,
      signals: rows.signals as MapSignal[],
      decisions: project ? allDecisions.filter((d) => !d.task_id || everyTaskProject.get(d.task_id) === project) : allDecisions,
      labels,
      graph,
      viewerId,
      names,
      now,
      occurrences: allOccurrences.filter(mine),
      // Unread deploys stay undefined, so the model claims nothing about them.
      deploys: deploysRead || deploys.length ? deploys : undefined,
      watchDays,
      holdOf,
      forYou,
    }, lg.graphKey);
  }, [allDeploys, allDecisions, everyTaskProject, allOccurrences, labels, graph, viewerId, names, now, watchDays, holdOf, lg.graphKey]);
  const allForYouByCase = useMemo(() => inboxKindByCase(allInbox), [allInbox]);
  const allModel = useMemo(() => modelOf(everyRow, null, allForYouByCase, true), [modelOf, everyRow, allForYouByCase]);
  const model = useMemo(() => (projectId ? modelOf(scoped, projectId, forYouByCase, deploysReady) : allModel), [projectId, modelOf, scoped, forYouByCase, deploysReady, allModel]);

  // Where each problem came from: one reading every list and the run detail show. The findings in the store first;
  // a problem whose findings are older than the window reads its kept quotes; none, and the cell stays empty.
  const bots = useMemo(() => new Set(roster.filter((m) => m.is_bot).map((m) => m._id)), [roster]);
  const sources = useMemo(() => problemOrigins({
    signals: lineRows.signals as Array<{ source: string; judge?: string; task_id: string; user_id?: string }>,
    issues: allModel.issues, tasks: lineRows.tasks as Array<{ _id: string; source?: string; user_id?: string }>, isCause: (t) => isCause(t as never), names, bots,
    occurrences: allOccurrences as ReadonlyArray<{ task_id: string; sources?: ReadonlyArray<string> }>,
  }), [lineRows.signals, lineRows.tasks, names, bots, allModel.issues, allOccurrences]);

  // The problems only a lesson filed, off that same reading: one set for the nav, the project filter and the Problems tabs.
  const lessons = useMemo(() => lessonOnlyIds(sources), [sources]);

  // Over every project, a write goes to the project holding most of the drawn process's runs.
  const homeId = useMemo(() => {
    if (projectId) return projectId;
    const count = new Map<string, number>();
    for (const r of model.runs) {
      const p = r.caseId ? taskProject.get(r.caseId) : null;
      if (p) count.set(p, (count.get(p) ?? 0) + 1);
    }
    return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }, [projectId, model.runs, taskProject]);
  const home = project ?? (homeId ? projects.find((p) => p._id === homeId) ?? null : null);

  const product = useProductName((project ?? home) as any);
  const loop = useLoopSteps({ projectId, project: project as any, signals: signals as any, problems: (scoped.tasks ?? EMPTY) as any, labels: labels as any, viewerId, names, now });

  // Which process each row belongs to, read over every project so a row never changes process with the filter.
  const processOf = useMemo(() => inboxProcessOf(everyRow.runs as unknown as GraphRun[], everyRow.tasks as Array<{ _id: string; project_id?: string | null }>), [everyRow]);
  // The picker's counts: each row under exactly one process, so they sum to the project's whole.
  const forYouByGraph = useMemo(() => inboxByGraph(projectInbox, processOf), [projectInbox, processOf]);
  // The Inbox, the header's "for you" and the nav count read the process drawn, like every other view.
  const inbox = useMemo(() => projectInbox.map((g) => ({ ...g, rows: g.rows.filter((r) => processOf.row(r) === model.graphKey) })).filter((g) => g.rows.length > 0), [projectInbox, processOf, model.graphKey]);
  // The project filter's counts, in the process drawn: what waits on the viewer there and its problems not yet done.
  const byProject = useMemo(() => lineProjectCounts(allInbox, processOf, allModel.graphKey, allModel.issues, (id) => everyTaskProject.get(id), lessons), [allInbox, processOf, allModel, everyTaskProject, lessons]);
  // History is fed for the projects with problems in the process drawn, whatever the filter: one feeder set, so the
  // counts above read the same rows picked or not, and a project with nothing here costs no subscriptions.
  const historyFeeds = useMemo(() => {
    const drawn = new Set<string>();
    for (const t of everyRow.tasks) {
      const p = (t as { project_id?: string | null }).project_id;
      if (p && p !== projectId && isCause(t) && processOf.task(t as { _id: string; project_id?: string | null }) === lg.graphKey) drawn.add(p);
    }
    return [...drawn].sort().map((p) => ({ projectId: p, repositories: repositories.get(p) ?? "" }));
  }, [everyRow.tasks, processOf, lg.graphKey, projectId, repositories]);
  const open = useMemo(() => activeProblemCount(model.issues, lessons), [model.issues, lessons]);
  // Problems that are one problem under two ids (overlap): filed under the oldest, over the active ones in view.
  const overlaps = useMemo(() => {
    const rows = new Map((scoped.tasks as Array<{ _id: string; created_at?: number; _creationTime?: number; cause?: { fingerprints?: string[] } | null }>).map((t) => [t._id, t]));
    return problemOverlaps(model.issues.filter((i) => isCountedActive(i, lessons)).map((i) => {
      const t = rows.get(i.id);
      return { id: i.id, ref: i.ref, title: i.title, at: t?.created_at ?? t?._creationTime ?? 0, fingerprints: t?.cause?.fingerprints ?? null };
    }));
  }, [model.issues, lessons, scoped.tasks]);
  const process = useMemo(() => {
    const projectOf = new Map((scoped.tasks as Array<{ _id: string; project_id?: string | null }>).map((t) => [t._id, t.project_id ?? null]));
    return processIndex(scoped.runs as unknown as GraphRun[], (id) => projectOf.get(id));
  }, [scoped]);
  // One object while nothing in it moved: the views are memoized on it, so a
  // feeder's push that changes no field here re-renders none of them.
  return useMemo(() => ({ model, project, home, projects, graphKey: model?.graphKey ?? null, unread: lg.unread, now, rollup, rollups, allRollups: rollupRows, admissions, trialProjects, rows: scoped, historyFeeds, loop, product, inbox, forYou: inboxCount(inbox), open, forYouByGraph, processes, byProject, process, sources, names, overlaps, ready }),
    [ready, model, project, home, projects, lg.unread, now, rollup, rollups, rollupRows, admissions, trialProjects, scoped, historyFeeds, loop, product, inbox, open, forYouByGraph, processes, byProject, process, sources, names, overlaps]);
}

/**
 * The project a `/line/<project>` address names (lineWorkspaceUrl resolveLineProject): its short id, row id or
 * name's slug, read from the store, a slug shared across workspaces settling on the active one's. Undefined while
 * the store has no such row yet, which is cold, not wrong; the caller decides how long to wait.
 */
export function useLineProjectId(param: string | null | undefined): string | undefined {
  const active = useActiveWorkspaceKey();
  return useInboxStore((s) => {
    const projects = s.projects as Record<string, LineProject & { workspace?: string | null }> | undefined;
    if (!param || !projects) return undefined;
    if (projects[param]) return param;
    return resolveLineProject(param, Object.values(projects), (p) => !!active && p.workspace === active);
  });
}

export { lineFilterParam, projectSlug } from "../lib/line/lineWorkspaceUrl";

// ── the shared selection ─────────────────────────────────────────────────────

/** How a selection change lands in the browser's history. `replace` corrects the current entry: a fix-up the app
 *  makes on its own (a ref settling on its row id, a run's own process), or a keyboard cursor moving. */
export type LineSelectOptions = { replace?: boolean };
export type LineSelect = (patch: LineSelectionPatch, runCase?: string | null, opts?: LineSelectOptions) => void;

/** The workspace's selection, read from and written to the URL (lineWorkspaceUrl). `select({ run, case })` moves
 *  both; a run alone takes its case when `runCase` names it. A move to another place (lineSelectionPushes: a view,
 *  problem, run, step, card, decision, source, process or project) is a history entry, so Back and Forward walk
 *  them; anything else, or a move marked `replace`, rewrites the current entry. */
export function useLineSelection(): { selection: LineSelection; select: LineSelect; href: (patch: LineSelectionPatch, runCase?: string | null) => string } {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const selection = useMemo(() => readLineSelection(search), [search]);
  const href = useCallback((patch: LineSelectionPatch, runCase?: string | null) => `${pathname ?? "/line"}${lineSelectionSearch(search, patch, runCase)}`, [pathname, search]);
  const select = useCallback<LineSelect>((patch, runCase, opts) => {
    const next = lineSelectionSearch(search, patch, runCase);
    const now = search?.toString() ?? "";
    if (next === (now ? `?${now}` : "")) return;
    const to = `${pathname ?? "/line"}${next}`;
    if (!opts?.replace && lineSelectionPushes(search, new URLSearchParams(next))) router.push(to, { scroll: false });
    else router.replace(to, { scroll: false });
  }, [router, pathname, search]);
  return { selection, select, href };
}

// ── what a station received ──────────────────────────────────────────────────

/** A station's brief as lineWorkspace.stationInput returns it. */
export type StationInput = { _id: string; conversation_id: string; text: string; truncated: boolean; at: number | null; found: boolean };

/**
 * What a station was handed: its session's first message, fed when a
 * decision is opened. `runId` lets a teammate who reads the run read its
 * station's brief. Undefined while cold, null once the server said the
 * viewer cannot read it.
 */
export function useStationInput(sessionId: string | null | undefined, runId?: string | null): StationInput | null | undefined {
  const args = useMemo(() => (sessionId ? { conversation_id: sessionId, ...(runId ? { run_id: runId } : {}) } : "skip"), [sessionId, runId]);
  const { ready } = useSyncCollection("stationInputs", api.lineWorkspace.stationInput, args as any, { select: (row: StationInput | null) => (row ? [row] : []) });
  const row = useInboxStore((s) => (sessionId ? ((s as unknown as { stationInputs?: Record<string, StationInput> }).stationInputs?.[sessionId] ?? null) : null));
  if (!sessionId) return null;
  if (row) return row;
  return ready ? null : undefined;
}
