// The phone Priorities list's data (app/priorities.tsx) and the inbox's
// Priorities view feeder: priorities.list over every workspace the viewer
// holds, the active one's pass timing riding the same answer (one
// subscription: same query, same args), read across every workspace, each
// rank read live from its place; and the viewer's view of the list (hidden
// workspaces, Group by, Compact) from clientState.ui.priorities_view, so it
// follows them to every device. Web's hooks/usePriorities is the twin, with
// the same args and prefs key, but imports sonner, which the phone lacks.
import { useCallback, useMemo } from 'react';
import { api as _api } from '@codecast/convex/convex/_generated/api';
import type { PriorityList, PriorityRow } from '@codecast/shared/contracts/priorities';
import { useSyncCollection } from '@codecast/web/hooks/useSyncCollection';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { useActiveWorkspaceKey, useWorkspacesCollection } from '@codecast/web/hooks/useWorkspaceCollection';
import { listMeta, listRows, prioritySig, withLiveRanks, type PriorityListMeta } from '@codecast/web/lib/priorities';
import { DEFAULT_GROUP_BY, type GroupBy } from '@codecast/web/lib/prioritySections';
import { useInboxStore } from '@codecast/web/store/inboxStore';

const api = _api as any;

/** The list's args: every workspace, the active one's pass timing. Every reader passes these, so they share one subscription. */
function useListArgs(): { timing_for: string } | null {
  const workspace = useActiveWorkspaceKey();
  return useMemo(() => (workspace ? { timing_for: workspace } : null), [workspace]);
}

/** Feeder: the priorities the viewer can read in every workspace they hold, a snapshot of all of them. */
export function useSyncPriorities(on = true) {
  const args = useListArgs();
  return useSyncCollection('priorities', api.priorities.list, on && args ? args : 'skip', { select: listRows });
}

/** Every workspace the viewer holds: each of their teams, and their own. */
function useHeldWorkspaceKeys(): string[] {
  const teams = useInboxStore((s) => (s.teams ?? []).map((t: any) => `team:${t._id}`).join('\n'));
  const personal = useInboxStore((s) => (s.currentUser?._id ? `user:${s.currentUser._id}` : ''));
  return useMemo(() => [...(teams ? teams.split('\n') : []), ...(personal ? [personal] : [])], [teams, personal]);
}

export function usePriorityList(): { feed: ReturnType<typeof useSyncCollection>; rows: PriorityRow[]; meta: PriorityListMeta } {
  const args = useListArgs();
  const feed = useSyncPriorities();
  const stored = useWorkspacesCollection<PriorityRow>('priorities', prioritySig, useHeldWorkspaceKeys());
  const rows = useMemo(() => withLiveRanks(stored), [stored]);
  const meta = listMeta(useQueryNoThrow(api.priorities.list, args ?? 'skip', { remember: true }).data as PriorityList | null | undefined);
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
