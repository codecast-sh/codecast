// Workflows and workflow runs — store-fed. Three server windows overlay one
// runs collection (registry: workflowRuns isDelta).
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useInboxStore } from "../store/inboxStore";
import { activeTeamIdOf } from "../lib/activeTeam";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import { stableRefId } from "../store/wakeSig";
import { isViewersWorkflow } from "../store/lineWorkflowSlice";
import { useFeederWorkspace } from "./useWorkspaceArgs";
import { useWorkspaceCollection } from "./useWorkspaceCollection";
import { appPool, takesSessionChange } from "../lib/line/flowPool";
import { flowGraphAttr } from "@codecast/shared/contracts/flowPool";

const graphTakesBranch = (w: { source?: string | null }) => flowGraphAttr(w?.source, "kind") === "line" && /\bbranch\b/.test(flowGraphAttr(w?.source, "takes") ?? "");

const api = _api as any;

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

/** Reader: the pushed rows a workspace's pool draws from: the viewer's own
 *  workflows, then each flow published to the workspace, newest first. appPool
 *  keeps the first of a slug, so the viewer's own copy wins. */
export function usePoolFlowRows(workspace?: string | null, enabled = true): any[] {
  useSyncPoolFlows(workspace, enabled);
  const { workflows: own } = useWorkflows(enabled);
  const published = useWorkspaceCollection<any>("workflows", workflowSig, workspace ?? null);
  return useMemo(() => [...own, ...published.slice().sort((a, b) => (b.updated_at ?? 0) - (a.updated_at ?? 0))], [own, published]);
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
    { select: (row: any) => (row ? [row] : []) },
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
    runId ? { run_id: runId } : "skip",
    { select: (row: any) => (row ? [row] : []) },
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
    workflowId ? { workflow_id: workflowId } : "skip",
  );
}

/** Feeder: one run, enriched (node sessions). */
export function useSyncWorkflowRun(runId: string | null | undefined) {
  return useSyncCollection(
    "workflowRuns",
    api.workflow_runs.get,
    runId ? { id: runId } : "skip",
    // A single row → the collection's overlay takes an array.
    { select: (row: any) => (row ? [row] : []) },
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
    { select: (row: any) => (row ? [row] : []) },
  );
}

/** Reader: one workflow (undefined while cold, null once the server said no). */
export function useWorkflow(id: string | null | undefined): any | null | undefined {
  const { ready } = useSyncWorkflow(id);
  const row = useInboxStore((s) => (id ? (s.workflows as any)[id] : undefined));
  if (!id) return undefined;
  return row ?? (ready ? null : undefined);
}

/** The shipped flows a session's change goes through. A session also starts runs of other flows (a deploy, a line run),
 *  which other feeds bring into the same collection; those are not its Ship. */
const SHIPPED_SESSION_FLOWS = new Set(appPool().filter((f) => f.kind === "line" && takesSessionChange(f)).flatMap((f) => [f.slug, f.name]));

/** Feeder: the runs a session started for its change (convex sessionFlowRuns), live ones first. */
export function useSyncSessionFlowRuns(conversationId: string | null | undefined) {
  return useSyncCollection("workflowRuns", api.sessionFlowRuns.forConversation, conversationId ? { conversation_id: conversationId } : "skip");
}

/** Reader: a session's own flow runs, newest first (undefined while cold and empty). */
export function useSessionFlowRuns(conversationId: string | null | undefined): any[] | undefined {
  const { ready } = useSyncSessionFlowRuns(conversationId);
  // A team's own flow counts when its graph in the store says it takes a branch:
  // the viewer's own flows and those published to the workspace.
  const { workflows: own } = useWorkflows();
  const published = useWorkspaceCollection<any>("workflows", workflowSig);
  const teamFlows = useMemo(() => {
    const out: string[] = [];
    for (const w of [...own, ...published]) if (graphTakesBranch(w)) out.push(w.slug, w.name);
    return out.sort().join("|");
  }, [own, published]);
  const where = useMemo(() => {
    const ok = new Set([...SHIPPED_SESSION_FLOWS, ...teamFlows.split("|").filter(Boolean)]);
    return (r: any) => !!conversationId && String(r.spawner_conversation_id ?? "") === conversationId && r.run_kind !== "workflow" && (ok.has(r.workflow_slug ?? "") || ok.has(r.workflow_name ?? ""));
  }, [conversationId, teamFlows]);
  const rows = useWorkflowRuns(where);
  return rows.length || ready ? rows.slice().sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0)) : undefined;
}
