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
import type { DeployAfter, DeployView } from "@codecast/shared/contracts/deploys";
import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { parsePrRef } from "@codecast/shared/contracts";
import { LINE_SIGNAL_CAP, LINE_SIGNAL_WINDOW_MS } from "@codecast/shared/contracts/lineProfile";
import type { SessionDecisionItem } from "../store/inboxStore";
import { useSyncTeamLineDecisions } from "./useSyncSessionDecisions";
import { useInboxStore } from "../store/inboxStore";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import { useFeederWorkspace } from "./useWorkspaceArgs";
import { useActiveWorkspaceKey, useWorkspaceCollection } from "./useWorkspaceCollection";
import { useSyncRuns } from "./useSyncRuns";
import { useSyncTaskSignals } from "./useSyncSignals";
import { useSyncTrial, useTrialCards, useTrialProjects, useTrialRuns } from "./useSyncTrial";
import { useLineSpaceKeys } from "./useLineSpace";
import { useTeamRosterIdentity } from "./useTeamRoster";
import { autoStartWord, isCause, trialStartWord, scopeLine, type LineAdmission, type LineProject, type RollupRow } from "../lib/lineFlow";
import type { HandMerge } from "../lib/line/causeHistory";
import { buildLineModel, type DeployRow, type LineGraphSource, type LineIssue, type LineLabelRow, type LineModel, type LineModelRows, type OccurrenceRow } from "../lib/line/lineModel";
import type { MapDecision, MapRun, MapSignal } from "../lib/line/lineMap";
import { graphPickOrder, processIndex, projectGraphs, type GraphRun, type ProjectGraph } from "../lib/line/lineGraphs";
import { buildLineInbox, inboxByGraph, inboxKindByCase, inboxProcessOf, lineProjectCounts, type InboxGroup } from "../lib/line/lineInbox";
import { foldDuplicateNeeds, lineNeeds, needCount, unlandedNeed, type LineNeed } from "../lib/line/lineNeeds";
import { unlandedFix } from "../lib/line/approvedFix";
import { fixMergesSig, landingOutput, newestRuns, type FixPullRequest, type LandedTask } from "../lib/line/problemPage";
import { caseRefs, lineSelectionPushes, lineSelectionSearch, readLineSelection, resolveLineProject, type CaseRefs, type LineSelection, type LineSelectionPatch } from "../lib/line/lineWorkspaceUrl";
import { useLineFloor, useProjectWorkspace } from "../components/line/useLineFloor";
import { useLineGraph } from "../components/line/map/useLineGraph";
import { useProductName } from "./useLoopSteps";
import { problemOrigins, type ProblemSource } from "../lib/line/stepRuns";
import { activeProblemCount, isCountedActive, lessonOnlyIds } from "../lib/line/problemTable";
import { problemOverlaps, type Overlap } from "../lib/line/overlap";
import { heldFrom } from "../lib/line/sourcesView";

const api = _api as any;
const EMPTY: never[] = [];

export type { LineSelection, LineSelectionPatch, LineView } from "../lib/line/lineWorkspaceUrl";
export { LINE_VIEWS, DEFAULT_LINE_VIEW } from "../lib/line/lineWorkspaceUrl";

// ── signatures: the fields the model reads ───────────────────────────────────

const labelSig = (l: LineLabelRow) => `${l.key}|${l.verdict}|${l.note ?? ""}|${l.at}`;
const occurrenceSig = (o: OccurrenceRow) => `${o.task_id}|${o.observed.length}|${o.observed[o.observed.length - 1] ?? 0}|${o.reopened.length}|${o.capped ? 1 : 0}`;
const deploySig = (o: LineDeploy) => {
  const d = o;
  return `${d.at}|${d.sha ?? ""}|${d.surface ?? d.environment ?? ""}|${o.short_id ?? ""}|${o.status ?? ""}|${o.url ?? ""}|${o.carries?.length ?? 0}|${o.after ? `${o.after.to}:${o.after.regressions}:${o.after.reopened}:${o.after.errors.length}` : ""}|${o.commits?.length ?? 0}`;
};
const cardSig = (d: MapDecision) => `${(d as { asked_user_ids?: string[] }).asked_user_ids?.join(",") ?? ""}|${(d as { passed_to?: { id: string } | null }).passed_to?.id ?? ""}|${d.status}|${d.answer_index ?? ""}|${d.answer_text ?? ""}|${d.resolved_at ?? 0}|${d.card?.headline ?? ""}|${d.card?.change ?? ""}`;

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

/** An open card's one home is the decision collection (the viewer's queue and the team's open line decisions); the
 *  line's copies are settled history, and a copy cached while it was open says nothing about it now. */
function mergeCards(home: ReadonlyArray<MapDecision>, line: ReadonlyArray<MapDecision>): MapDecision[] {
  const byId = new Map<string, MapDecision>();
  for (const d of line) if (d.status !== "pending") byId.set(d._id, d);
  // The line's copy keeps what the queue row lacks (who it was asked of).
  for (const d of home) { const l = byId.get(d._id); byId.set(d._id, l ? { ...l, ...d } : d); }
  return [...byId.values()];
}

/** The rows in view, as the floor holds them: every project's, or one project's. */
export type LineScopedRows = ReturnType<typeof useLineFloor>["lineRows"];

/** A deploy as the line reads it (convex deploys projectDeployViews): the history's row and the object. */
export type LineDeploy = Omit<DeployRow, "project_id"> & DeployView & { workspace: string; deploy_id?: string; after: DeployAfter | null };

/** Whether a deploy is on a project's line: the project's own, or one that ships the workspace's code (no project). */
const deployIn = (d: Pick<LineDeploy, "project_id">, project: string | null) => !project || !d.project_id || d.project_id === project;

export type LineWorkspace = {
  model: LineModel | null;
  /** The deploys in view (deploys.md), one per deploy, newest first. */
  deploys: LineDeploy[];
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
  /** A trial project's word for its ready problems while its dispatcher holds them ("Trial held"), by project id. */
  trialHeld?: ReadonlyMap<string, string>;
  /** Runs a trial started (its own rows, and every run on a trial project's problem): an answer at their gates ships nothing. */
  trialRuns: ReadonlySet<string>;
  /** The rows in view: signals (findings, with source, judge, severity, detail and evidence), cause tasks, runs and the viewer's cards. */
  rows: LineScopedRows;
  /** Every finding the floor holds, whatever the project filter: a line's own judges stay on its Find table under a picked project (sourcesView homeJudges). */
  everySignals: LineScopedRows["signals"];
  /** Projects whose history (occurrences, deploys, cards) the shell feeds: those with problems in any process (Problems lists every one), other than the filtered one (fed here), with the repositories their merges name. */
  historyFeeds: Array<{ projectId: string; repositories: string }>;
  /** The product's name as a reader says it ("Union"), for "runs in Union" and "Fixes in Union". */
  product: string | null;
  /** What waits on the viewer in the process drawn and the project filter (lineInbox), computed once for the header and the Inbox. */
  inbox: InboxGroup[];
  /** The same over every process: what Problems reads a problem's failure or silence from, whatever process it is in. */
  allInbox: InboxGroup[];
  /** Every problem under the project filter, in every process, each with the process it is read in: Problems' list. */
  problems: Array<LineIssue & { process: string }>;
  /** What waits on the viewer in every process, under the project filter (lineNeeds): For you's rows, and what a problem's band, a run's person step and a step's waiting rows look their need up in. */
  needs: LineNeed[];
  /** "For you": the needs the viewer can answer now (needCount), summed over every process. The one count, on the nav entry. */
  forYou: number;
  /** Problems not closed in every process, under the filter (problemTable activeProblemCount): Problems' whole, and the filter's. */
  open: number;
  /** The for-you rows by process (processIndex), under the project filter: the picker's counts. The drawn one equals `forYou`. */
  forYouByGraph: Map<string, number>;
  /** Which process each problem, finding or project belongs to (lineGraphs processIndex), over the rows in view. */
  process: ReturnType<typeof processIndex>;
  /** Per project, over every project and every process: rows waiting on the viewer, and problems not done. */
  byProject: Map<string, { forYou: number; open: number }>;
  /** Every process any project's problems run, in picker order, whatever the project filter: the picker's fixed set. */
  processes: ProjectGraph[];
  /** Where each problem came from (stepRuns problemSources), by task id: its source, judge and reporter. One reading every row's source chip shows. */
  sources: Map<string, ProblemSource>;
  /** People's names by user id: who answered a card, who labeled a decision. */
  names: ReadonlyMap<string, string>;
  /** Every decision a run asked on these problems, the viewer's queue's copy over the line's: who an open one was asked of. */
  decisions: ReadonlyArray<MapDecision>;
  /** The findings and runs feeds have both answered this load: before that, every count here is the cache's and may still move. */
  ready: boolean;
  /** When the floor holds every finding from (sourcesView heldFrom): null when it holds the feed's whole window. Every
   *  finder count reads its window from this (findWindow), so the Find table and a finder's page count one set. */
  heldFrom: number | null;
  /** Each active problem's duplicate set (near-identical titles, filed under the oldest) and the rule its findings cite. */
  overlaps: ReadonlyMap<string, Overlap>;
  /** Every problem's ref and row id, over every project: the address carries a problem's ref, the views read its row id. */
  refs: CaseRefs;
};

/**
 * The line as every view reads it (lineModel buildLineModel), over every
 * project (`projectId` null) or filtered to one. The rows come from the line
 * floor (signals, causes, runs, cards); the drawn graph from the project's
 * stations or the row its newest run ran; the history from the occurrence,
 * deploy and card reads. `graphKey` picks the process (null: the busiest);
 * `caseId` (a row id or a ref) feeds every run and every finding of the case being read, which
 * the floor's newest-runs window and two-week findings may not hold. Over every project the history feeders
 * are mounted by the shell, one per project (`historyFeeds`).
 */
/** `pinned`: the app is one project's own (its Line tab), so what waits on the viewer is that project's too. Otherwise a
 *  project picked in the filter narrows Problems and Line only: For you and its count always cover every project. */
export function useLineWorkspace(projectId: string | null, graphKey: string | null, caseId?: string | null, { pinned = false, everySpace = false }: { pinned?: boolean; everySpace?: boolean } = {}): LineWorkspace {
  // The line's own page lists trials from every workspace it holds (For you); a fence or link reads the active one.
  const allSpaces = useLineSpaceKeys();
  const spaceKeys = everySpace ? allSpaces : undefined;
  // The team's open line decisions, every one the viewer can read, into the one decision collection (For you lists them).
  const activeSpace = useActiveWorkspaceKey();
  const teamDecisions = useSyncTeamLineDecisions(useMemo(() => (spaceKeys ?? [activeSpace]).filter((k): k is string => !!k), [spaceKeys, activeSpace]));
  const projectRow = useInboxStore((s) => (projectId ? ((s.projects as Record<string, LineProject>)?.[projectId] ?? null) : null));
  const workspace = useProjectWorkspace(projectRow as { workspace?: string | null; team_id?: string | null } | null);
  const { now, lineRows, projects, rollup: rollupRows, admissions, ready } = useLineFloor(projectId, workspace);
  const held = useMemo(() => heldFrom(lineRows.signals as Array<{ created_at: number }>, now, LINE_SIGNAL_WINDOW_MS, LINE_SIGNAL_CAP), [lineRows.signals, now]);
  const rollup = useMemo(() => (projectId ? rollupRows.find((r) => r.key === projectId) ?? null : null), [rollupRows, projectId]);
  const rollups = useMemo(() => (projectId ? (rollup ? [rollup] : []) : rollupRows), [projectId, rollup, rollupRows]);
  const project = projectId ? projectRow ?? projects.find((p) => p._id === projectId) ?? null : null;
  const refs = useMemo(() => caseRefs(lineRows.tasks as Array<{ _id: string; short_id?: string | null }>), [lineRows.tasks]);
  const caseRow = caseId ? refs.id(caseId) : null;
  useSyncRuns(caseRow ? { task_id: caseRow, limit: 50 } : {}, !!caseRow, workspace);
  useSyncTaskSignals(caseRow);

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
  // A deploy object (deploys.md) has a status and its own id; rows an earlier feed shape left in the cache have neither.
  const workspaceDeploys = useWorkspaceCollection<LineDeploy>("lineDeploys", deploySig, workspace);
  const allDeploys = useMemo(() => workspaceDeploys.filter((d) => !!d.status && !d._id.includes(":")), [workspaceDeploys]);
  // The deploys in view, newest first: a project's own, and those that ship the whole workspace's code.
  const deploys = useMemo(() => allDeploys.filter((d) => deployIn(d, projectId)).sort((a, b) => b.at - a.at), [allDeploys, projectId]);
  const allLineCards = useCollectionRows<MapDecision & { project_id?: string }>("lineCards", { where: anyProject, sig: cardSig });
  const ownCardWhere = useMemo(() => (d: SessionDecisionItem) => !!d.task_id && everyTaskProject.has(d.task_id) && !!d.workflow_run_id, [everyTaskProject]);
  const ownCards = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where: ownCardWhere, sig: cardSig as unknown as (d: SessionDecisionItem) => string });
  const allDecisions = useMemo(() => mergeCards(ownCards as unknown as MapDecision[], allLineCards), [ownCards, allLineCards]);

  const roster = useTeamRosterIdentity();
  // A problem may be assigned to a role as well as a person (its line then starts it): both are named.
  const roleNames = useInboxStore((s) => (s.orgTree?.roles ?? []).map((r) => `${r._id}\u0000${r.name ?? r.handle ?? ""}`).join("\n"));
  const names = useMemo(() => new Map([
    ...roleNames.split("\n").filter(Boolean).map((x) => x.split("\u0000") as [string, string]),
    ...roster.map((m) => [m._id, m.name ?? m.email ?? ""] as [string, string]),
  ]), [roster, roleNames]);
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const trialRows = useTrialProjects(spaceKeys);
  const trialProjects = useMemo(() => new Set(trialRows.map((p) => p._id)), [trialRows]);
  // The runs a trial started (its own rows, and every run on a trial project's problem): an answer at their gates ships nothing.
  const trialRunRows = useTrialRuns({ all: true, workspaces: spaceKeys });
  const trialRuns = useMemo(() => {
    const out = new Set(trialRunRows.map((r) => r.run_id).filter((x): x is string => !!x));
    for (const r of lineRows.runs as unknown as Array<{ _id: string; task_id?: string }>) {
      const p = r.task_id ? everyTaskProject.get(r.task_id) : null;
      if (p && trialProjects.has(p)) out.add(r._id);
    }
    return out;
  }, [trialRunRows, lineRows.runs, everyTaskProject, trialProjects]);
  // A problem whose project starts nothing on its own says so in a word, read from its own project's switch (LL5);
  // a trial project's from its dispatcher (held, or none).
  const trialHeld = useMemo(() => new Map(trialRows.flatMap((p) => { const w = trialStartWord(p.dispatch); return w ? [[p._id, w] as const] : []; })), [trialRows]);
  const holdOf = useCallback((p: string | null) => (!p ? null : trialProjects.has(p) ? trialHeld.get(p) ?? null : autoStartWord(admissions.get(p))), [admissions, trialProjects, trialHeld]);
  const watchDays = (project as { line_profile?: { watch_days?: number } | null } | null)?.line_profile?.watch_days ?? null;

  // The heaviest derivation on the page (it runs the flow over every row): once here, read by the shell and the Inbox.
  // Built over every project and narrowed to the filter, so the project filter's "for you" and the header's agree.
  const everyRow = useMemo(() => {
    if (!projectId) return scoped;
    const causes = new Set(lineRows.tasks.filter(isCause).map((t) => t._id));
    return { ...lineRows, runs: lineRows.runs.filter((r) => !!r.task_id && causes.has(r.task_id)) };
  }, [projectId, scoped, lineRows]);
  // Trial cards: a trial run's gates ask no one, so they wait here as the Inbox's own group (fed as /trial feeds them).
  // For you lists every workspace's, so they are read from each workspace the line holds (LineWorkspace feeds them).
  useSyncTrial();
  const allTrialCards = useTrialCards({ workspaces: spaceKeys });
  // A run's decision about a task that is not a line problem (a task filed by hand, a judge fix) names that task, read from the store.
  const otherIds = useMemo(() => {
    const causes = new Set(everyRow.tasks.filter(isCause).map((t) => t._id));
    return [...new Set((everyRow.decisions as Array<{ task_id?: string | null }>).map((d) => d.task_id).filter((id): id is string => !!id && !causes.has(id)))].sort();
  }, [everyRow]);
  const otherSig = useInboxStore((s) => otherIds.map((id) => {
    const t = (s.tasks as Record<string, { title?: string; short_id?: string; project_id?: string } | undefined> | undefined)?.[id];
    return t?.title ? [id, t.short_id ?? "", t.project_id ?? "", t.title].join("\u0001") : "";
  }).filter(Boolean).join("\u0002"));
  const otherTasks = useMemo(() => new Map(otherSig ? otherSig.split("\u0002").map((x) => {
    const [id, ref, project, title] = x.split("\u0001");
    return [id, { title, short_id: ref || null, project_id: project || null }] as const;
  }) : []), [otherSig]);
  // The decisions a line asks are the team's: every open one on a problem the viewer can read, whoever it was asked of
  // or assigned to (the line's cards, with the viewer's own queue rows winning), and every waiting trial card. Who
  // holds one is the row's assignee (lib/line/decisionFacts), never a reason to hide it.
  const allInbox = useMemo(() => buildLineInbox({ ...everyRow, decisions: allDecisions as unknown as typeof everyRow.decisions, decisionsComplete: teamDecisions.ready, projects, rollups: rollupRows, admissions, trialCards: allTrialCards, trialProjects, viewer: viewerId, otherTasks, now }), [everyRow, allDecisions, teamDecisions.ready, projects, rollupRows, admissions, allTrialCards, trialProjects, viewerId, otherTasks, now]);
  const projectInbox = useMemo(() => (projectId ? allInbox.map((g) => ({ ...g, rows: g.rows.filter((r) => r.projectId === projectId) })).filter((g) => g.rows.length > 0) : allInbox), [allInbox, projectId]);
  const forYouByCase = useMemo(() => inboxKindByCase(projectInbox), [projectInbox]);

  // One model over every project's rows: the project filter's counts read it, so a project's numbers are the same
  // picked or not. Filtered, the views read the same builder over the project's own rows.
  // `key` is the process to build (the drawn one by default); another process has no stations row of its own here, so
  // its steps are read from what its runs recorded.
  // A fix merged by hand through its pull request or committed to main (problemPage fixMerges): each problem's history reads it as its merge.
  const refOfTask = useMemo(() => new Map((everyRow.tasks as Array<{ _id: string; short_id?: string }>).map((t) => [t._id, t.short_id ?? null])), [everyRow.tasks]);
  const handMergesSig = useInboxStore((st) => fixMergesSig((st as unknown as { pullRequests?: Record<string, FixPullRequest> }).pullRequests, (id) => refOfTask.get(id), everyRow.tasks as LandedTask[]));
  const handMerges = useMemo(() => new Map<string, HandMerge>(JSON.parse(handMergesSig)), [handMergesSig]);
  const modelOf = useCallback((rows: { runs: unknown[]; tasks: LineModelRows["tasks"]; signals: unknown[] }, project: string | null, forYou: Map<string, string>, deploysRead: boolean, key: string = lg.graphKey) => {
    const mine = (r: { project_id?: string }) => !project || r.project_id === project;
    // Only a deploy that went live carried anything.
    const deploys = allDeploys.filter((d) => deployIn(d, project) && d.status === "live");
    return buildLineModel({
      runs: rows.runs as MapRun[],
      tasks: rows.tasks,
      signals: rows.signals as MapSignal[],
      decisions: project ? allDecisions.filter((d) => !d.task_id || everyTaskProject.get(d.task_id) === project) : allDecisions,
      labels,
      graph: key === lg.graphKey ? graph : null,
      viewerId,
      names,
      now,
      occurrences: allOccurrences.filter(mine),
      // Unread deploys stay undefined, so the model claims nothing about them.
      deploys: deploysRead || deploys.length ? deploys : undefined,
      watchDays,
      handMerges,
      holdOf,
      forYou,
      trialRuns,
    }, key);
  }, [allDeploys, allDecisions, everyTaskProject, allOccurrences, labels, graph, viewerId, names, now, watchDays, handMerges, holdOf, trialRuns, lg.graphKey]);
  const allForYouByCase = useMemo(() => inboxKindByCase(allInbox), [allInbox]);
  const allModel = useMemo(() => modelOf(everyRow, null, allForYouByCase, true), [modelOf, everyRow, allForYouByCase]);
  const model = useMemo(() => (projectId ? modelOf(scoped, projectId, forYouByCase, deploysReady) : allModel), [projectId, modelOf, scoped, forYouByCase, deploysReady, allModel]);
  // Every problem, in every process and every project (LJ8.2): Problems lists these under the project filter, as For
  // you lists every process's needs, so "Waiting on you" there and For you count the same things. Each problem is read
  // in the process its newest run ran (processIndex), the drawn one from the model above; the picker narrows the list,
  // never the scope. Built over every project so the project filter's counts never move with the filter.
  const everyProblem = useMemo(() => {
    const projectOf = (id: string) => everyTaskProject.get(id) ?? null;
    const idx = processIndex(everyRow.runs as unknown as GraphRun[], projectOf);
    const keys = new Set<string>();
    for (const t of everyRow.tasks) if (isCause(t)) keys.add(idx.task(t._id, projectOf(t._id)));
    const out: Array<LineIssue & { process: string }> = [];
    for (const key of [...keys].sort()) {
      const issues = key === allModel.graphKey ? allModel.issues : modelOf(everyRow, null, allForYouByCase, true, key).issues;
      for (const i of issues) if (idx.task(i.id, projectOf(i.id)) === key) out.push({ ...i, process: key });
    }
    return out.sort((a, b) => b.history.lastActivity - a.history.lastActivity);
  }, [everyRow, everyTaskProject, allModel, modelOf, allForYouByCase]);
  const problems = useMemo(() => (projectId ? everyProblem.filter((i) => everyTaskProject.get(i.id) === projectId) : everyProblem), [everyProblem, projectId, everyTaskProject]);

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

  // Which process each row belongs to, read over every project so a row never changes process with the filter.
  const processOf = useMemo(() => inboxProcessOf(everyRow.runs as unknown as GraphRun[], everyRow.tasks as Array<{ _id: string; project_id?: string | null }>), [everyRow]);
  // The picker's counts: each row under exactly one process, so they sum to the project's whole.
  const forYouByGraph = useMemo(() => inboxByGraph(projectInbox, processOf), [projectInbox, processOf]);
  // The Inbox, the header's "for you" and the nav count read the process drawn, like every other view.
  const inbox = useMemo(() => projectInbox.map((g) => ({ ...g, rows: g.rows.filter((r) => processOf.row(r) === model.graphKey) })).filter((g) => g.rows.length > 0), [projectInbox, processOf, model.graphKey]);
  // Problems that are one problem under two ids (overlap): filed under the oldest, over every active problem in every
  // process and project, so a twin folds the same way whatever the filter or the picker shows.
  const overlaps = useMemo(() => {
    const rows = new Map((everyRow.tasks as Array<{ _id: string; created_at?: number; _creationTime?: number; cause?: { fingerprints?: string[] } | null }>).map((t) => [t._id, t]));
    return problemOverlaps(everyProblem.filter((i) => isCountedActive(i, lessons)).map((i) => {
      const t = rows.get(i.id);
      return { id: i.id, ref: i.ref, title: i.title, at: t?.created_at ?? t?._creationTime ?? 0, fingerprints: t?.cause?.fingerprints ?? null };
    }));
  }, [everyProblem, lessons, everyRow.tasks]);
  // What waits on the viewer, over every process and every project: For you has no picker and no project filter (a
  // need names its own process and project), so picking a project on Problems or Line never hides an ask. Only a
  // project's own Line tab (`pinned`) narrows it.
  // A twin's question folds into its older problem's (foldDuplicateNeeds): asked once, counted once.
  const needInbox = pinned ? projectInbox : allInbox;
  // A fix the viewer approved that never landed waits on them too (approvedFix): read off each problem's own history,
  // as its band reads it, so For you and the problem's page say the same thing.
  // Every approved fix nothing landed, whoever approved it: the same rule and the same set as Problems' chip of that name.
  const unlanded = useMemo(() => {
    const isTrial = (runId: string) => trialRuns.has(runId);
    const newest = newestRuns(everyRow.runs as MapRun[]);
    const out: LineNeed[] = [];
    for (const i of pinned ? problems : everyProblem) {
      const fix = unlandedFix(i, { isTrial, shipOutput: landingOutput(newest.get(i.id)?.node_statuses as Parameters<typeof landingOutput>[0]) });
      if (!fix) continue;
      const projectId = everyTaskProject.get(i.id) ?? null;
      out.push(unlandedNeed({ id: i.id, ref: i.ref ?? null, title: i.title, name: (i as { name?: string | null }).name ?? null, projectId, process: i.process }, fix));
    }
    return out;
  }, [pinned, problems, everyProblem, trialRuns, everyRow.runs, everyTaskProject]);
  const needs = useMemo(() => {
    // A problem is listed once: one that already asks something keeps that need.
    const asked = lineNeeds(needInbox, processOf);
    const held = new Set(asked.map((n) => n.caseId));
    return foldDuplicateNeeds([...asked, ...unlanded.filter((n) => !held.has(n.caseId))], (id) => {
      const o = overlaps.get(id);
      return o && o.primary !== id ? { caseId: o.primary, ref: o.primaryRef } : null;
    });
  }, [needInbox, processOf, overlaps, unlanded]);
  const forYou = useMemo(() => needCount(needs), [needs]);
  // The project filter's counts, in the process drawn: what waits on the viewer there and its problems not yet done.
  // Over every process, like Problems' list: a project's numbers are its own, whatever the picker draws.
  const byProject = useMemo(() => lineProjectCounts(allInbox, processOf, null, everyProblem, (id) => everyTaskProject.get(id), lessons), [allInbox, processOf, everyProblem, everyTaskProject, lessons]);
  // History is fed for the projects with problems, in any process (Problems lists every one), whatever the filter: one
  // feeder set, so the counts above read the same rows picked or not, and a project with no problems costs nothing.
  const historyFeeds = useMemo(() => {
    const drawn = new Set<string>();
    for (const t of everyRow.tasks) {
      const p = (t as { project_id?: string | null }).project_id;
      if (p && p !== projectId && isCause(t)) drawn.add(p);
    }
    return [...drawn].sort().map((p) => ({ projectId: p, repositories: repositories.get(p) ?? "" }));
  }, [everyRow.tasks, projectId, repositories]);
  const open = useMemo(() => activeProblemCount(problems, lessons), [problems, lessons]);
  const process = useMemo(() => {
    const projectOf = new Map((scoped.tasks as Array<{ _id: string; project_id?: string | null }>).map((t) => [t._id, t.project_id ?? null]));
    return processIndex(scoped.runs as unknown as GraphRun[], (id) => projectOf.get(id));
  }, [scoped]);
  // One object while nothing in it moved: the views are memoized on it, so a
  // feeder's push that changes no field here re-renders none of them.
  return useMemo(() => ({ model, project, home, projects, graphKey: model?.graphKey ?? null, unread: lg.unread, now, rollup, rollups, allRollups: rollupRows, admissions, trialProjects, trialHeld, trialRuns, rows: scoped, everySignals: lineRows.signals, historyFeeds, product, inbox, allInbox: projectInbox, problems, needs, forYou, open, forYouByGraph, processes, byProject, process, sources, names, decisions: allDecisions, overlaps, ready, heldFrom: held, refs, deploys }),
    [ready, model, project, home, projects, lg.unread, now, rollup, rollups, rollupRows, admissions, trialProjects, trialHeld, trialRuns, scoped, lineRows.signals, historyFeeds, product, inbox, projectInbox, problems, needs, forYou, open, forYouByGraph, processes, byProject, process, sources, names, allDecisions, overlaps, held, refs, deploys]);
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
 *  makes on its own (a ref settling on its row id, a run's own process), or a keyboard cursor moving. `push` makes
 *  a change that only alters how a place reads an entry anyway: a person's click opening something Back should close. */
export type LineSelectOptions = { replace?: boolean; push?: boolean };
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
    if (!opts?.replace && (opts?.push || lineSelectionPushes(search, new URLSearchParams(next)))) router.push(to, { scroll: false });
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
