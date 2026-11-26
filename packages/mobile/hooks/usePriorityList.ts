// The phone Priorities list's data (app/priorities.tsx): the feeder of the
// `priorities` collection for the active workspace and its reader, each rank
// read live from its place, plus when the pass next runs, read off the same
// list answer (one subscription: same query, same args). Web's hooks/
// usePriorities does the same but imports sonner, which the phone lacks.
import { useMemo } from 'react';
import { api as _api } from '@codecast/convex/convex/_generated/api';
import type { PriorityList, PriorityRow } from '@codecast/shared/contracts/priorities';
import { useSyncCollection } from '@codecast/web/hooks/useSyncCollection';
import { useQueryNoThrow } from '@codecast/web/hooks/useQueryNoThrow';
import { useActiveWorkspaceKey, useWorkspaceCollection } from '@codecast/web/hooks/useWorkspaceCollection';
import { listMeta, listRows, prioritySig, withLiveRanks, type PriorityListMeta } from '@codecast/web/lib/priorities';

const api = _api as any;

export function usePriorityList(): { feed: ReturnType<typeof useSyncCollection>; rows: PriorityRow[]; meta: PriorityListMeta } {
  const workspace = useActiveWorkspaceKey();
  const args = workspace ? { workspace } : 'skip';
  const feed = useSyncCollection('priorities', api.priorities.list, args, { select: listRows });
  const stored = useWorkspaceCollection<PriorityRow>('priorities', prioritySig);
  const rows = useMemo(() => withLiveRanks(stored), [stored]);
  const meta = listMeta(useQueryNoThrow(api.priorities.list, args, { remember: true }).data as PriorityList | null | undefined);
  return { feed, rows, meta };
}
