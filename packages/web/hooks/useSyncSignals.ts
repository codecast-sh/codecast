// Signals (docs/architecture/the-line-end-to-end.md LE3, LE13): the active
// workspace's last two weeks into the `signals` collection. A snapshot feed,
// so a signal that ages out of the window leaves the store.
import { useMemo } from "react";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { useSyncCollection } from "./useSyncCollection";
import { useWorkspaceArgs, workspaceStamp } from "./useWorkspaceArgs";
import { useWorkspaceCollection } from "./useWorkspaceCollection";
import type { LineSignal } from "../lib/lineFlow";

const api = _api as any;

/** Feeder: the workspace's recent signals. */
export function useSyncSignals() {
  const ws = useWorkspaceArgs();
  const stamp = workspaceStamp(ws);
  const teamId = "team_id" in stamp ? stamp.team_id : undefined;
  const args = useMemo(() => (ws === "skip" ? "skip" : teamId ? { team_id: teamId } : {}), [ws === "skip", teamId]); // eslint-disable-line react-hooks/exhaustive-deps
  return useSyncCollection("signals", api.signals.webList, args as any);
}

const signalSig = (s: LineSignal) => `${s.created_at}|${s.task_id}|${s.reopened ? 1 : 0}`;

/** Reader: the workspace's signals out of the store. */
export function useWorkspaceSignals(): LineSignal[] {
  return useWorkspaceCollection<LineSignal & { workspace: string }>("signals", signalSig);
}
