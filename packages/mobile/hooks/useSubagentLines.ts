import { useMemo, useRef } from 'react';
import { useInboxStore, resolveSubagentFilter, resolveSubagentRows, type PlacedInbox } from '@codecast/web/store/inboxStore';
import type { SubagentStateGroup } from '@codecast/web/lib/subagentRows';
import { drawsSubagentLine, subagentLines } from '@/lib/subagentLine';

/** How the inbox's cards show their subagents, as the rail's view menu set it
 *  (the phone has no menu and follows it), and each card's folded line
 *  (lib/subagentLine), or none at all. The previous map rides along so an
 *  unchanged line keeps its array and the memoized row does not re-render. */
export function useSubagentLines(placed: Pick<PlacedInbox, 'subsByParent' | 'workersNeedingYouByParent'>, now: number, flatView: boolean) {
  const subagentRows = useInboxStore((s) => resolveSubagentRows(s.clientState?.ui));
  const subagentFilter = useInboxStore((s) => resolveSubagentFilter(s.clientState?.ui));
  const prev = useRef<Map<string, SubagentStateGroup[]> | undefined>(undefined);
  const lines = useMemo(() => {
    if (!drawsSubagentLine(subagentRows, flatView)) return null;
    const all = useInboxStore.getState().sessions;
    const next = subagentLines([placed.subsByParent, placed.workersNeedingYouByParent], (id) => all[id], now, subagentFilter, prev.current);
    prev.current = next;
    return next;
  }, [placed.subsByParent, placed.workersNeedingYouByParent, now, subagentRows, subagentFilter, flatView]);
  return { subagentRows, subagentFilter, showSubagents: subagentRows === 'full', lines };
}
