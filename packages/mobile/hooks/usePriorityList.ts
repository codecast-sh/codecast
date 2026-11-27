// The phone Priorities list's data (app/priorities.tsx) and the inbox's
// Priorities view feeder: priorities.list over every workspace the viewer
// holds (one subscription: same query, same args), read across every
// workspace, each rank read live from its place; the active workspace's pass
// timing from its own small query (priorities.timing); and the viewer's view
// of the list (hidden workspaces, Group by, Compact) from
// clientState.ui.priorities_view, so it follows them to every device. Web's
// hooks/usePriorities is the twin, with the same args and prefs key, but
// imports sonner, which the phone lacks.
import { useCallback, useMemo } from 'react';
import { api as _api } from '@codecast/convex/convex/_generated/api';
import type { PriorityRow } from '@codecast/shared/contracts/priorities';
import { useSyncCollection } from '@codecast/web/hooks/useSyncCollection';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { useActiveWorkspaceKey, useWorkspacesCollection } from '@codecast/web/hooks/useWorkspaceCollection';
import { listMeta, listRows, prioritySig, withLiveRanks, type PriorityListMeta } from '@codecast/web/lib/priorities';
import { DEFAULT_GROUP_BY, type GroupBy } from '@codecast/web/lib/prioritySections';
import { useInboxStore } from '@codecast/web/store/inboxStore';

const api = _api as any;

/** The list's args, the same object for every caller: every workspace, one subscription. */
const EVERY_WORKSPACE = {};

/** Feeder: the priorities the viewer can read in every workspace they hold, a snapshot of all of them. */
export function useSyncPriorities(on = true) {
  return useSyncCollection('priorities', api.priorities.list, on ? EVERY_WORKSPACE : 'skip', { select: listRows });
}

/** Every workspace the viewer holds: each of their teams, and their own. */
function useHeldWorkspaceKeys(): string[] {
  const teams = useInboxStore((s) => (s.teams ?? []).map((t: any) => `team:${t._id}`).join('\n'));
  const personal = useInboxStore((s) => (s.currentUser?._id ? `user:${s.currentUser._id}` : ''));
  return useMemo(() => [...(teams ? teams.split('\n') : []), ...(personal ? [personal] : [])], [teams, personal]);
}

export function usePriorityList(): { feed: ReturnType<typeof useSyncCollection>; rows: PriorityRow[]; meta: PriorityListMeta } {
  const workspace = useActiveWorkspaceKey();
  const feed = useSyncPriorities();
  const stored = useWorkspacesCollection<PriorityRow>('priorities', prioritySig, useHeldWorkspaceKeys());
  const rows = useMemo(() => withLiveRanks(stored), [stored]);
  // When the active workspace's pass runs: its own query, so a workspace switch never re-runs the list.
  const meta = listMeta(useQueryNoThrow(api.priorities.timing, workspace ? { workspace } : 'skip', { remember: true }).data as PriorityListMeta | null | undefined);
  return { feed, rows, meta };
}

/** The viewer's view of the list: workspaces turned off, the grouping as stored, Compact. */
export type PrioritiesViewPrefs = { hidden: string[]; groupBy: unknown; compact: boolean };
export type PrioritiesViewPatch = Partial<{ hidden: string[]; group_by: GroupBy; compact: boolean }>;

const NO_HIDDEN: string[] = [];

/** The viewer's view and its setter, from the ui prefs bag (one stamped key, written whole), the key web's /priorities reads. */
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
