// Priorities (convex priorities.ts): the feeder and reader of the `priorities`
// collection, and the person's controls with their put-back on a refusal.
// One subscription feeds it: priorities.list over every workspace the viewer
// holds; the active workspace's pass timing is its own small query.
// /priorities mounts it, and so do the sync host's feeders wherever the
// active workspace has Priorities on (useSyncInboxPriorities).
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { api as _api } from "@codecast/convex/convex/_generated/api";
import { serverErrorText } from "../lib/errorCause";
import { listMeta, listRows, prioritySig, withLiveRanks, type PriorityListMeta, type PriorityRow, type PriorityWrites } from "../lib/priorities";
import { priorityWrites } from "../lib/priorityWrites";
import { DEFAULT_GROUP_BY, type GroupBy } from "../lib/prioritySections";
import { useInboxStore } from "../store/inboxStore";
import { useAnyWorkspaceFeature } from "../lib/teamFeatures";
import { isRefusedDispatchError } from "../store/mutativeMiddleware";
// Installs sonner as the undo notifier, which raises a check-off's Undo receipt (lib/priorityWrites).
import "../store/undoStack";
import { useSyncCollection } from "./useSyncCollection";
import { useQueryNoThrow } from "./useQueryNoThrow";
import { useServerAuthSettled } from "./useServerAuthSettled";
import { useCoarseNow } from "./useCoarseNow";
import { useActiveWorkspaceKey, useWorkspacesCollection } from "./useWorkspaceCollection";

const api = _api as any;

/** The list's args, the same object for every caller: every workspace, one subscription. */
const EVERY_WORKSPACE = {};

/** Feeder: the priorities the viewer can read in every workspace they hold, a snapshot of all of them. */
export function useSyncPriorities(on = true) {
  return useSyncCollection("priorities", api.priorities.list, on ? EVERY_WORKSPACE : "skip", { select: listRows });
}

/**
 * The priorities the inbox sorts by in its Priorities view and filters by in
 * its Top 3 / 5 / 10, while any workspace the viewer holds has the feature on:
 * the filter is offered in every view, so the ranks it reads stay live in
 * every view. Mounted in the sync host's feeders (DashboardLayout
 * HostFeeders), so the host feeds them whether or not its own window draws
 * the inbox panel; followers read the replicated rows. The same call as
 * /priorities, so neither one's snapshot drops the other's rows.
 */
export function useSyncInboxPriorities() {
  useSyncPriorities(useAnyWorkspaceFeature("priorities"));
}

/** When the active workspace's pass runs (priorities.timing): its own small subscription, so a workspace switch never re-runs the list. It only enriches the header. */
export function usePriorityListMeta(): PriorityListMeta {
  const workspace = useActiveWorkspaceKey();
  const settled = useServerAuthSettled();
  const { data } = useQueryNoThrow(api.priorities.timing, settled && workspace ? { workspace } : "skip", { remember: true });
  return listMeta(data as PriorityListMeta | null | undefined);
}

/** Every workspace the viewer holds: each of their teams, and their own. */
export function useHeldWorkspaceKeys(): string[] {
  const teams = useInboxStore((s) => (s.teams ?? []).map((t: any) => `team:${t._id}`).join("\n"));
  const personal = useInboxStore((s) => (s.currentUser?._id ? `user:${s.currentUser._id}` : ""));
  return useMemo(() => [...(teams ? teams.split("\n") : []), ...(personal ? [personal] : [])], [teams, personal]);
}

/** Reader: the priorities in every workspace the viewer holds, waking on what a row paints, the viewer's ranks read live from their places. */
export function usePriorities(): PriorityRow[] {
  const rows = useWorkspacesCollection<PriorityRow>("priorities", prioritySig, useHeldWorkspaceKeys());
  return useMemo(() => withLiveRanks(rows), [rows]);
}

/** The viewer's view of /priorities (components/priorities/PrioritiesToolbar): workspaces turned off, the grouping as stored, Compact. */
export type PrioritiesViewPrefs = { hidden: string[]; groupBy: unknown; compact: boolean };
type PrioritiesViewPatch = Partial<{ hidden: string[]; group_by: GroupBy; compact: boolean }>;

const NO_HIDDEN: string[] = [];

/** The viewer's view of /priorities and its setter, from the ui prefs bag (one stamped key, written whole). */
export function usePrioritiesView(): [PrioritiesViewPrefs, (patch: PrioritiesViewPatch) => void] {
  const stored = useInboxStore((s) => s.clientState.ui?.priorities_view);
  const updateClientUI = useInboxStore((s) => s.updateClientUI);
  const view = useMemo(() => ({ hidden: stored?.hidden ?? NO_HIDDEN, groupBy: stored?.group_by ?? DEFAULT_GROUP_BY, compact: !!stored?.compact }), [stored]);
  const set = useCallback((patch: PrioritiesViewPatch) => {
    const current = useInboxStore.getState().clientState.ui?.priorities_view;
    updateClientUI({ priorities_view: { ...current, ...patch } });
  }, [updateClientUI]);
  return [view, set];
}

const WRITES = priorityWrites((message) => toast.error(message));

/** The store's priority actions (lib/priorityWrites), each put back when the server refuses it, the reason shown as a toast; a check-off also records its undo. */
export function usePriorityWrites(): PriorityWrites {
  return WRITES;
}

/** A pass reads as running from the press until its rows land, for at most this long. */
const RUN_SHOWN_MS = 5 * 60_000;

/**
 * "Run now": one pass in the active workspace through the store action
 * (priorities.run on the server). It reads as running until the pass's rows
 * land; a refusal says the server's reason and ends it.
 */
export function useRunPriorities(rowCount: number): { running: boolean; run: (() => void) | null } {
  const workspace = useActiveWorkspaceKey();
  const [since, setSince] = useState<number | null>(null);
  const now = useCoarseNow(30_000);
  const run = useCallback(() => {
    if (!workspace) return;
    setSince(Date.now());
    useInboxStore.getState().runPriorities(workspace).catch((e: unknown) => {
      if (!isRefusedDispatchError(e)) return;
      setSince(null);
      toast.error(serverErrorText(e));
    });
  }, [workspace]);
  const running = since != null && rowCount === 0 && Math.max(now, since) - since < RUN_SHOWN_MS;
  return { running, run: workspace ? run : null };
}
