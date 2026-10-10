// Feeders and readers for the line workspace's actions (line-workspace.md
// LW4, convex lineActions.ts): a project's tries, a drawn graph's versions
// and whether the viewer can edit and try it. Each feeder hands its query's
// pushes to the store; the readers paint from the store, waking on a
// signature of the fields the panels draw.
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useCollectionRows } from "./useCollectionRows";
import { useInboxStore } from "../store/inboxStore";
import type { LineTryRow } from "../lib/line/lineActions";

const api = _api as any;

const trySig = (r: LineTryRow) =>
  `${r._id}|${r.status}|${r.updated_at}|${r.via ?? ""}|${r.reason ?? ""}|${r.new ? 1 : 0}|${r.cost_usd ?? ""}|${r.pickup ? JSON.stringify(r.pickup) : ""}`;

/** A project's tries (all steps), fed while `projectId` is set; read from the store. */
export function useLineTries(projectId: string | null | undefined): LineTryRow[] {
  const args = useMemo(() => (projectId ? { project_id: projectId } : "skip"), [projectId]);
  useSyncCollection("lineTries", api.lineActions.tries, args as any);
  const where = useMemo(() => (r: LineTryRow) => !!projectId && r.project_id === projectId, [projectId]);
  return useCollectionRows<LineTryRow>("lineTries", { where, sig: trySig });
}

export type GraphVersionRow = { _id: string; workflow_id: string; pushed_to: string; graph_hash: string; nodes: Array<{ id: string; h: string }>; changed: string[]; by: string; at: number };
const versionSig = (r: GraphVersionRow) => `${r._id}|${r.graph_hash}|${r.at}`;

/** Every version of the drawn graph, newest first. */
export function useGraphVersions(workflowId: string | null | undefined): GraphVersionRow[] {
  const args = useMemo(() => (workflowId ? { workflow_id: workflowId } : "skip"), [workflowId]);
  useSyncCollection("lineGraphVersions", api.lineActions.versions, args as any);
  const where = useMemo(() => (r: GraphVersionRow) => !!workflowId && r.workflow_id === workflowId, [workflowId]);
  const sort = useMemo(() => (a: GraphVersionRow, b: GraphVersionRow) => b.at - a.at, []);
  return useCollectionRows<GraphVersionRow>("lineGraphVersions", { where, sig: versionSig, sort });
}

export type GraphEditability =
  | { _id: string; editable: true; file: string; files: Array<{ node: string; prompt?: string; script?: string }>; device_id: string; nodes: Array<{ id: string; h: string }>; target: string }
  | { _id: string; editable: false; reason: string };

/** Whether the viewer can save and try the drawn graph's steps, and where; undefined while unread. */
export function useGraphEditability(workflowId: string | null | undefined): GraphEditability | null | undefined {
  const args = useMemo(() => (workflowId ? { workflow_id: workflowId } : "skip"), [workflowId]);
  const { ready } = useSyncCollection("lineGraphEditability", api.lineActions.editability, args as any, { select: (row: GraphEditability | null) => (row ? [row] : []) });
  const row = useInboxStore((s) => (workflowId ? ((s as unknown as { lineGraphEditability?: Record<string, GraphEditability> }).lineGraphEditability?.[workflowId] ?? null) : null));
  if (!workflowId) return null;
  if (row) return row;
  return ready ? null : undefined;
}

/** A save's sessionCommands row, by its request id. */
export function useSaveRow(requestId: string | null): { executed_at?: number | null; result?: string | null; error?: string | null } | null {
  return useInboxStore((s) => (requestId ? ((s as any).sessionCommands?.[requestId] ?? null) : null));
}
