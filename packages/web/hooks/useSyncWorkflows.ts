// Workflows and workflow runs — store-fed. Three server windows overlay one
// runs collection (registry: workflowRuns isDelta).
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { isConvexId, useInboxStore } from "../store/inboxStore";
import { liveRunsSig } from "./useLiveRunsCheck";
import { activeTeamIdOf } from "../lib/activeTeam";
import { entityIdArgs, useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import { stableRefId } from "../store/wakeSig";
import { isViewersWorkflow } from "../store/lineWorkflowSlice";
import { useFeederWorkspace } from "./useWorkspaceArgs";
import { useWatchEffect } from "./useWatchEffect";
import { cachedAt, pinDetailRows } from "../lib/detailRows";
import { useWorkspaceCollection } from "./useWorkspaceCollection";

const api = _api as any;

// Module-level: a fresh select per render re-applied the same payload on every
// render of the host (useSyncCollection keys its sync callback on it).
const ONE_ROW = { select: (row: any) => (row ? [row] : []) };

export function useSyncWorkflows(enabled = true) {
  return useSyncCollection("workflows", api.workflows.webList, enabled ? {} : "skip");
}

const newestFirst = (a: any, b: any) => (b.created_at ?? b._creationTime ?? 0) - (a.created_at ?? a._creationTime ?? 0);
const workflowSig = (w: any) => `${w.name}|${w.slug}|${w.goal ?? ""}|${w.updated_at ?? 0}|${w.nodes?.length ?? 0}`;

/** The viewer's id, for the readers that mean the viewer's own rows: the
 *  collection also holds the graphs teammates' runs ran (useSyncRunGraph). */
const useViewerId = () => useInboxStore((s) => (s.currentUser?._id ? String(s.currentUser._id) : null));

/** Reader: the viewer's workflows, newest first. */
export function useWorkflows(enabled = true): { workflows: any[]; ready: boolean } {
  const { ready } = useSyncWorkflows(enabled);
  const viewerId = useViewerId();
  const where = useMemo(() => (w: any) => isViewersWorkflow(w, viewerId), [viewerId]);
  const workflows = useCollectionRows<any>("workflows", { where, sig: workflowSig, sort: newestFirst });
  return { workflows, ready };
}

/** Feeder: the flows published to a workspace's pool (flows.md FL2), a
 *  teammate's included. The active workspace unless one is named. */
export function useSyncPoolFlows(workspace?: string | null, enabled = true) {
  const { args } = useFeederWorkspace(workspace);
  return useSyncCollection("workflows", api.workflows.webPool, enabled ? args : "skip");
}

/** Reader: the pushed rows a workspace's pool draws from: the flows filed under
 *  the workspace, the viewer's own first, then newest first. A row the viewer
 *  filed under another workspace is not this one's (a personal flow stays out of
 *  a team's pool). appPool keeps the first of a slug, so the viewer's own copy wins. */
export function usePoolFlowRows(workspace?: string | null, enabled = true): any[] {
  useSyncPoolFlows(workspace, enabled);
  const viewerId = useViewerId();
  const rows = useWorkspaceCollection<any>("workflows", workflowSig, workspace ?? null);
  return useMemo(() => {
    const mine = (w: any) => Number(String(w.user_id) === viewerId);
    return rows.slice().sort((a, b) => mine(b) - mine(a) || (b.updated_at ?? 0) - (a.updated_at ?? 0));
  }, [rows, viewerId]);
}

/** The slug a team set as its default flow (teams.setDefaultFlow), or null when it set none or there is no team (the
 *  personal workspace). The active team unless one is named. Resolve it against a pool with defaultFlowOf. */
export function useTeamDefaultFlowSlug(teamId?: string | null): string | null {
  return useInboxStore((s) => {
    const team = teamId === undefined ? activeTeamIdOf(s) : teamId;
    return (team && ((s.teams || []) as Array<{ _id: string; default_flow?: string }>).find((t) => String(t._id) === team)?.default_flow) || null;
  });
}

/** Feeder: the viewer's workflow of one slug, whatever its age (webList is a
 *  50-newest window, and a project's customized line must always arrive). */
export function useSyncWorkflowBySlug(slug: string | null | undefined) {
  return useSyncCollection(
    "workflows",
    api.workflows.webGetBySlug,
    slug ? { slug } : "skip",
    ONE_ROW,
  );
}

/** Reader: the viewer's workflow of one slug, or null once the server said
 *  there is none (undefined while cold). Its graph is in the signature, so an
 *  edited station re-renders. */
export function useWorkflowBySlug(slug: string | null | undefined): any | null | undefined {
  const { ready } = useSyncWorkflowBySlug(slug);
  const viewerId = useViewerId();
  const where = useMemo(() => (w: any) => !!slug && w.slug === slug && isViewersWorkflow(w, viewerId), [slug, viewerId]);
  const rows = useCollectionRows<any>("workflows", { where, sig: workflowGraphSig });
  if (!slug) return null;
  if (rows[0]) return rows[0];
  return ready ? null : undefined;
}
const workflowGraphSig = (w: any) => `${workflowSig(w)}|${w.nodes ? stableRefId(w.nodes) : 0}|${w.edges ? stableRefId(w.edges) : 0}`;

/** Feeder: the graph one run ran (its workflows row), for any viewer who may
 *  read the run, the owner of the row or not (the line page's graphs). */
export function useSyncRunGraph(runId: string | null | undefined) {
  return useSyncCollection(
    "workflows",
    api.workflow_runs.graphOfRun,
    entityIdArgs("run_id", runId ?? undefined),
    ONE_ROW,
  );
}

/** Reader: the workflows row a run ran, by the run's workflow_id (undefined
 *  while cold, null once the server said the viewer cannot read it). Its
 *  graph is in the signature, so an edited station re-renders. */
export function useRunGraph(runId: string | null | undefined, workflowId: string | null | undefined): any | null | undefined {
  const { ready } = useSyncRunGraph(workflowId ? runId : null);
  const where = useMemo(() => (w: any) => !!workflowId && w._id === workflowId, [workflowId]);
  const rows = useCollectionRows<any>("workflows", { where, sig: workflowGraphSig });
  if (!workflowId) return null;
  if (rows[0]) return rows[0];
  return ready ? null : undefined;
}

/** Feeder: the viewer's dynamic (multi-agent) runs window. */
export function useSyncDynamicRuns(enabled = true) {
  return useSyncCollection("workflowRuns", api.workflow_runs.listDynamicRuns, enabled ? {} : "skip");
}

/** Feeder: one workflow's recent runs. */
export function useSyncWorkflowRuns(workflowId: string | null | undefined) {
  return useSyncCollection(
    "workflowRuns",
    api.workflow_runs.listForWorkflow,
    entityIdArgs("workflow_id", workflowId ?? undefined),
  );
}

/** Feeder: one run, enriched (node sessions). */
export function useSyncWorkflowRun(runId: string | null | undefined) {
  return useSyncCollection(
    "workflowRuns",
    api.workflow_runs.get,
    entityIdArgs("id", runId ?? undefined),
    // A single row → the collection's overlay takes an array.
    ONE_ROW,
  );
}

const runSig = (r: any) =>
  `${r.status}|${r.current_node_id ?? ""}|${r.updated_at ?? 0}|${r.total_tokens ?? 0}|${r.agent_count ?? 0}|${r.gate_prompt ?? ""}|` +
  `${r.waiting_on_session?.node_id ?? ""}:${r.waiting_on_session?.since ?? 0}|${r.merge?.sha ?? ""}|${r.gate_decision_id ?? ""}|` +
  (r.node_statuses ?? []).map((n: any) =>
    `${n.node_id}:${n.status}:${n.session?._id ?? ""}:${n.session?.is_active ? 1 : 0}:${n.session?.title ?? ""}:${n.session?.message_count ?? 0}:` +
    `${n.completed_at ?? 0}:${n.outcome ?? ""}:${n.tokens ?? 0}:${n.activity ?? ""}:${n.result_preview ? 1 : 0}:${n.visits ?? 0}`,
  ).join(",");
const runNewestFirst = (a: any, b: any) => (b.updated_at ?? 0) - (a.updated_at ?? 0);

/** Reader: runs, optionally filtered. */
export function useWorkflowRuns(where?: (r: any) => boolean): any[] {
  return useCollectionRows<any>("workflowRuns", { where, sig: runSig, sort: runNewestFirst });
}

/** Reader: dynamic (multi-agent) runs, newest first. */
export function useDynamicRuns(): { runs: any[]; ready: boolean } {
  const { ready } = useSyncDynamicRuns();
  const where = useMemo(() => (r: any) => r.run_kind === "workflow", []);
  const runs = useWorkflowRuns(where);
  return { runs, ready };
}

/** Reader: one run by id (undefined while cold, null once the server said no). */
export function useWorkflowRun(runId: string | null | undefined): any | null | undefined {
  const { ready } = useSyncWorkflowRun(runId);
  const where = useMemo(() => (runId ? (r: any) => r._id === runId : () => false), [runId]);
  const rows = useWorkflowRuns(where);
  if (!runId) return undefined;
  if (rows[0]) return rows[0];
  return ready ? null : undefined;
}

/** Feeder: one workflow by id (same raw doc shape as webList). */
export function useSyncWorkflow(id: string | null | undefined) {
  return useSyncCollection(
    "workflows",
    api.workflows.webGet,
    id ? { id } : "skip",
    ONE_ROW,
  );
}

/** Reader: one workflow (undefined while cold, null once the server said no). */
export function useWorkflow(id: string | null | undefined): any | null | undefined {
  const { ready } = useSyncWorkflow(id);
  const row = useInboxStore((s) => (id ? (s.workflows as any)[id] : undefined));
  if (!id) return undefined;
  return row ?? (ready ? null : undefined);
}

type PinnedRun = { _id: string; workflow_id?: string | null; graph_version_id?: string | null; flow_versions?: ReadonlyArray<{ version_id: string }> | null };

/** A pinned graph as the capped `runGraphs` collection holds it: stamped with when it was last fed (lib/detailRows). */
const RUN_GRAPH_FEED = {
  select: (row: any) => (row ? [{ ...row, _cachedAt: cachedAt((useInboxStore.getState().runGraphs as any)?.[row._id], Date.now()) }] : []),
};

/** The version a run pinned (convex lib/runGraph.ts): a library run's flow version, else its pin. */
const pinOf = (run: PinnedRun | null | undefined) => run?.flow_versions?.[0]?.version_id ?? run?.graph_version_id ?? null;

/**
 * Reader: the workflows row a run executes. A run that pinned a version reads
 * that version's graph (runGraphs, ct-98653), so another checkout's push of the
 * same slug never redraws it; a run from before pins reads the row. The row's
 * own id stays `_id`. Undefined while cold, null once the server said no.
 */
export function useRunWorkflow(run: PinnedRun | null | undefined): any | null | undefined {
  const pin = pinOf(run);
  const { ready, error } = useSyncCollection("runGraphs", api.workflow_runs.pinnedGraphOfRun, pin && run ? entityIdArgs("run_id", run._id) : "skip", RUN_GRAPH_FEED);
  // The card on screen holds its graph against the collection's cap.
  useWatchEffect(() => (pin ? pinDetailRows("runGraphs", [pin]) : undefined), [pin]);
  // A refusal answers as "no pinned graph" does: a backend without the query yet, or a version that kept no content
  // (one from before every push kept it), draws the row.
  const answered = ready || !!error;
  const pinned = useInboxStore((s) => (pin ? (s.runGraphs as any)[pin] : undefined));
  const row = useRunGraph(run?._id, pin && (pinned || !answered) ? null : run?.workflow_id);
  const graph = useMemo(() => (pinned ? { ...pinned, _id: pinned.workflow_id, version_id: pinned._id } : null), [pinned]);
  if (!pin) return row;
  return graph ?? (answered ? row : undefined);
}

const LIVE_RUN = new Set(["pending", "running", "paused"]);

/**
 * The runs the store holds as live for a session that the session's feed no longer names. The feed answers every live
 * run of the session and only its newest few ended ones, so a run that ended outside that window (a session that
 * shipped four times) would read live forever: these are asked for by id, and their rows heal in place.
 */
export function sessionRunsEndedOutOfWindow(runs: Record<string, any>, conversationId: string, answer: ReadonlyArray<{ _id: string }>): string[] {
  const named = new Set(answer.map((r) => String(r._id)));
  return Object.values(runs)
    .filter((r) => String(r.spawner_conversation_id ?? "") === conversationId && r.takes_change === true && LIVE_RUN.has(r.status) && !named.has(String(r._id)) && isConvexId(String(r._id)))
    .map((r) => String(r._id))
    .sort();
}

/** Feeder: the runs a session started for its change (convex sessionFlowRuns), live ones first. */
export function useSyncSessionFlowRuns(conversationId: string | null | undefined) {
  // entityIdArgs: a session not yet created on the server is a local stub id,
  // and v.id("conversations") rejects it (a server error per pane per stub).
  const feed = useSyncCollection("workflowRuns", api.sessionFlowRuns.forConversation, entityIdArgs("conversation_id", conversationId ?? undefined));
  const answer = Array.isArray(feed.data) ? (feed.data as Array<{ _id: string }>) : null;
  // Woken by the live rows' status only (liveRunsSig), never a heartbeat.
  const sig = useInboxStore((s) => liveRunsSig((s as any).workflowRuns ?? {}));
  const ended = useMemo(
    () => (answer && conversationId ? sessionRunsEndedOutOfWindow((useInboxStore.getState() as any).workflowRuns ?? {}, conversationId, answer).join(",") : ""),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the signature carries every field the walk reads
    [answer, conversationId, sig],
  );
  const args = useMemo(() => (ended ? { ids: ended.split(",") } : "skip"), [ended]);
  useSyncCollection("workflowRuns", api.workflow_runs.byIds, args as { ids: string[] } | "skip");
  return feed;
}

/** Reader: a session's own flow runs, newest first (undefined while cold and empty). */
export function useSessionFlowRuns(conversationId: string | null | undefined): any[] | undefined {
  const { ready } = useSyncSessionFlowRuns(conversationId);
  // A session also starts runs of other flows (a deploy, a line run, an eval), which other feeds bring into the same
  // collection: only a run the server stamped as carrying a change (its flow takes a branch and lands it) is its Ship.
  const where = useMemo(
    () => (r: any) => !!conversationId && String(r.spawner_conversation_id ?? "") === conversationId && r.takes_change === true,
    [conversationId],
  );
  const rows = useWorkflowRuns(where);
  return rows.length || ready ? rows.slice().sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0)) : undefined;
}

/** Reader (and its feeder): the newest run whose PR station opened this pull request, or null. */
export function usePullRequestRun(repository: string | null | undefined, number: number | null | undefined): any | null {
  useSyncCollection("workflowRuns", api.sessionFlowRuns.forPullRequest, repository && number ? { repository, number } : "skip");
  const repo = repository?.toLowerCase() ?? null;
  const where = useMemo(() => (r: any) => !!repo && r.pr?.number === number && String(r.pr?.repository ?? "").toLowerCase() === repo, [repo, number]);
  return useWorkflowRuns(where)[0] ?? null;
}

/** Feeder: the run a session works in (convex sessionFlowRuns.ofSession): its own run, or its parent log's for a station. */
export function useSyncSessionRun(conversationId: string | null | undefined) {
  return useSyncCollection("workflowRuns", api.sessionFlowRuns.ofSession, entityIdArgs("conversation_id", conversationId ?? undefined));
}

/** Reader: the run a session works in, matched in the store by the session's own pointer or by a station that ran as
 *  this session (undefined while cold, null when the session works in no run). */
export function useSessionRun(conversationId: string | null | undefined, ownRunId?: string | null): any | null | undefined {
  const { ready } = useSyncSessionRun(conversationId);
  const where = useMemo(() => (r: any) => !!conversationId && (
    (!!ownRunId && r._id === ownRunId) ||
    (r.node_statuses ?? []).some((n: any) => String(n.session?._id ?? "") === conversationId)
  ), [conversationId, ownRunId]);
  const rows = useWorkflowRuns(where);
  if (!conversationId) return null;
  if (rows[0]) return rows[0];
  return ready ? null : undefined;
}
