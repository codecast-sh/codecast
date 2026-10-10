"use client";
// The line workspace's hooks (docs/architecture/line-workspace.md LW1, LW2):
// one model for every view, the shared selection in the URL, and what a
// station was handed, read on demand. Every row comes from the store; the
// feeders here only feed it, and the readers wake on signatures of the fields
// the model reads, never on whole collections.
//
//   useLineWorkspace(projectId, graphKey)  the model (lib/line/lineModel.ts)
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
import { useWorkspaceCollection } from "./useWorkspaceCollection";
import { useSyncRuns } from "./useSyncRuns";
import { useRunGraph } from "./useSyncWorkflows";
import { useTeamRosterIdentity } from "./useTeamRoster";
import { scopeLine, type LineProject, type RollupRow } from "../lib/lineFlow";
import { buildLineModel, type DeployRow, type LineGraphSource, type LineLabelRow, type LineModel, type LineModelRows, type OccurrenceRow } from "../lib/line/lineModel";
import type { MapDecision, MapRun, MapSignal } from "../lib/line/lineMap";
import type { GraphRun } from "../lib/line/lineGraphs";
import { lineSelectionSearch, readLineSelection, type LineSelection, type LineSelectionPatch } from "../lib/line/lineWorkspaceUrl";
import { useLineFloor, useProjectWorkspace } from "../components/line/useLineFloor";
import { useLineGraph } from "../components/line/map/useLineGraph";

const api = _api as any;

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

/** Feeder: a project's history: its causes' occurrences, its recorded deploys
 *  (on its repositories and those its merges name), and every line card on its causes. */
function useSyncLineHistory(projectId: string | null, repositories: string) {
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

export type LineWorkspace = {
  model: LineModel | null;
  project: LineProject | null;
  /** The graph the model draws, after an unknown or missing key falls back to the project's busiest. */
  graphKey: string | null;
  /** The drawn graph's own row could not be read: its steps come from what its runs recorded. */
  unread: boolean;
  now: number;
  /** The project's row in the floor's roll-up: what waits on the viewer, what is stuck. Null when it has nothing on its line. */
  rollup: RollupRow | null;
};

/**
 * One project's line as every view reads it (lineModel buildLineModel). The
 * project's rows come from the line floor (signals, causes, runs, cards); the
 * drawn graph from the project's stations or the row its newest run ran; the
 * history from the project's occurrence, deploy and card reads. `graphKey`
 * picks the graph (null: the busiest); `caseId` feeds every run of the case
 * being read, which the floor's newest-runs window may not hold.
 */
export function useLineWorkspace(projectId: string | null, graphKey: string | null, caseId?: string | null): LineWorkspace {
  const projectRow = useInboxStore((s) => (projectId ? ((s.projects as Record<string, LineProject>)?.[projectId] ?? null) : null));
  const workspace = useProjectWorkspace(projectRow as { workspace?: string | null; team_id?: string | null } | null);
  const { now, lineRows, projects, rollup: rollupRows } = useLineFloor(projectId, workspace);
  const rollup = useMemo(() => rollupRows.find((r) => r.key === projectId) ?? null, [rollupRows, projectId]);
  const project = projectRow ?? projects.find((p) => p._id === projectId) ?? null;
  useSyncRuns(caseId ? { task_id: caseId, limit: 50 } : {}, !!caseId, workspace);

  const scoped = useMemo(() => (projectId ? scopeLine(lineRows, projectId) : null), [lineRows, projectId]);
  const runs = (scoped?.runs ?? []) as unknown as MapRun[];
  const signals = (scoped?.signals ?? []) as MapSignal[];

  // The graph: the project's own stations for codecast's line, else the row its newest run ran.
  const lg = useLineGraph(projectId, runs as unknown as GraphRun[], signals, graphKey);
  const row = useRunGraph(lg.ownLine ? null : lg.picked?.runId, lg.ownLine ? null : lg.picked?.workflowId);
  const graph: LineGraphSource | null = useMemo(() => {
    if (lg.ownLine) return lg.source ? { nodes: lg.source.nodes, edges: lg.source.edges } : null;
    return row?.nodes?.length ? { nodes: row.nodes, edges: row.edges ?? [], source: row.source ?? null, name: row.name ?? null } : null;
  }, [lg.ownLine, lg.source, row]);

  // Labels, history and cards.
  useSyncLineLabels(workspace);
  const labels = useWorkspaceCollection<LineLabelRow & { workspace: string }>("lineLabels", labelSig, workspace);
  const repositories = useMemo(() => repositoriesOf(runs as Array<{ merge?: { pr_url?: string } | null }>), [runs]);
  const { deploysReady } = useSyncLineHistory(projectId, repositories);
  const inProject = useMemo(() => (r: { project_id?: string }) => !!projectId && r.project_id === projectId, [projectId]);
  const occurrences = useCollectionRows<OccurrenceRow>("lineOccurrences", { where: inProject, sig: occurrenceSig });
  const deployRows = useCollectionRows<DeployRow>("lineDeploys", { where: inProject, sig: deploySig });
  const lineCards = useCollectionRows<MapDecision & { project_id?: string }>("lineCards", { where: inProject, sig: cardSig });
  const taskIds = useMemo(() => new Set((scoped?.tasks ?? []).map((t) => t._id)), [scoped]);
  const ownCardWhere = useMemo(() => (d: SessionDecisionItem) => !!d.task_id && taskIds.has(d.task_id) && !!d.workflow_run_id, [taskIds]);
  const ownCards = useCollectionRows<SessionDecisionItem>("sessionDecisions", { where: ownCardWhere, sig: cardSig as unknown as (d: SessionDecisionItem) => string });
  const decisions = useMemo(() => mergeCards(ownCards as unknown as MapDecision[], lineCards), [ownCards, lineCards]);

  const roster = useTeamRosterIdentity();
  const names = useMemo(() => new Map(roster.map((m) => [m._id, m.name ?? m.email ?? ""])), [roster]);
  const viewerId = useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));
  const watchDays = (project as { line_profile?: { watch_days?: number } | null } | null)?.line_profile?.watch_days ?? null;

  const model = useMemo(() => {
    if (!projectId || !scoped) return null;
    const rows: LineModelRows = {
      runs,
      tasks: scoped.tasks,
      signals,
      decisions,
      labels,
      graph,
      viewerId,
      names,
      now,
      occurrences,
      // Unread deploys stay undefined, so the model claims nothing about them.
      deploys: deploysReady || deployRows.length ? deployRows : undefined,
      watchDays,
    };
    return buildLineModel(rows, lg.graphKey);
  }, [projectId, scoped, runs, signals, decisions, labels, graph, viewerId, names, now, occurrences, deployRows, deploysReady, watchDays, lg.graphKey]);

  return { model, project, graphKey: model?.graphKey ?? null, unread: lg.unread, now, rollup };
}

/**
 * The project a `/line/<project>` address names: its short id or row id, read
 * from the store. Undefined while the store has no such row yet, which is
 * cold, not wrong; the caller decides how long to wait.
 */
export function useLineProjectId(param: string | null | undefined): string | undefined {
  return useInboxStore((s) => {
    if (!param) return undefined;
    const projects = s.projects as Record<string, LineProject> | undefined;
    if (!projects) return undefined;
    if (projects[param]) return param;
    for (const id in projects) if (projects[id]?.short_id === param) return id;
    return undefined;
  });
}

// ── the shared selection ─────────────────────────────────────────────────────

/** The workspace's selection, read from and written to the URL in place
 *  (lineWorkspaceUrl). `select({ run, case })` moves both; a run alone takes
 *  its case when `runCase` names it. */
export function useLineSelection(): { selection: LineSelection; select: (patch: LineSelectionPatch, runCase?: string | null) => void; href: (patch: LineSelectionPatch, runCase?: string | null) => string } {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const selection = useMemo(() => readLineSelection(search), [search]);
  const href = useCallback((patch: LineSelectionPatch, runCase?: string | null) => `${pathname ?? "/line"}${lineSelectionSearch(search, patch, runCase)}`, [pathname, search]);
  const select = useCallback((patch: LineSelectionPatch, runCase?: string | null) => {
    router.replace(href(patch, runCase), { scroll: false });
  }, [router, href]);
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
