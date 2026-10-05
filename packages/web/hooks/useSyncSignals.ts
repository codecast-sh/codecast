// Signals (docs/architecture/the-line-end-to-end.md LE3, LE13): one
// workspace's last two weeks into the `signals` collection, the active one
// unless a surface names the workspace its record lives in (a project's Line
// tab, a cause's task page opened from another team). A snapshot feed, so a
// signal that ages out leaves the store; a page mounts one workspace's feeder,
// and the next surface that reads another refetches its window.
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useFeederWorkspace } from "./useWorkspaceArgs";
import { useWorkspaceCollection } from "./useWorkspaceCollection";
import type { LineSignal } from "../lib/lineFlow";

const api = _api as any;

/** Feeder: a workspace's recent signals; the active one unless `workspace`
 *  names another (a stored access key). */
export function useSyncSignals(workspace?: string | null) {
  const { args } = useFeederWorkspace(workspace);
  const teamId = args === "skip" ? "skip" : args.team_id ?? "";
  const queryArgs = useMemo(() => (teamId === "skip" ? "skip" : teamId ? { team_id: teamId } : {}), [teamId]);
  return useSyncCollection("signals", api.signals.webList, queryArgs as any);
}

const signalSig = (s: LineSignal) => `${s.created_at}|${s.task_id}|${s.reopened ? 1 : 0}`;

/** Reader: a workspace's signals out of the store; the active one unless
 *  `workspace` names another. */
export function useWorkspaceSignals(workspace?: string | null): LineSignal[] {
  return useWorkspaceCollection<LineSignal & { workspace: string }>("signals", signalSig, workspace);
}
