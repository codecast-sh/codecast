import { useMemo, useRef } from 'react';
import { useInboxStore, fullRowsCounts, resolveSubagentFilter, resolveSubagentRows, subagentKeepOf, type PlacedInbox } from '@codecast/web/store/inboxStore';
import { hostedStopsSig } from '@codecast/web/lib/hostedNotice';
import type { SubagentStateGroup } from '@codecast/web/lib/subagentRows';
import { drawsSubagentLine, subagentLines } from '@/lib/subagentLine';

/** How the inbox's cards show their subagents, as the rail's view menu set it
 *  (the phone has no menu and follows it), each card's folded line
 *  (lib/subagentLine), or none at all, and the section counts the cards
 *  drawn (Full rows take the filtered-out nested rows off, as web does). The
 *  previous map rides along so an unchanged line keeps its array and the
 *  memoized row does not re-render. In a flat view the open subagent is a row
 *  of its own under its card, so its card's line leaves it out, as web's does. */
export function useSubagentLines(
  placed: Pick<PlacedInbox, 'subsByParent' | 'workersNeedingYouByParent' | 'counts' | 'nestedSectionOf'>,
  now: number,
  flatView: boolean,
  currentSessionId: string | null | undefined,
) {
  const subagentRows = useInboxStore((s) => resolveSubagentRows(s.clientState?.ui));
  const subagentFilter = useInboxStore((s) => resolveSubagentFilter(s.clientState?.ui));
  // The live facts a state reads beside the row (subagentLiveOf): a change re-reads the states.
  const decisions = useInboxStore((s) => s.sessionDecisions);
  const pendingMessages = useInboxStore((s) => s.pendingMessages);
  const reviveAt = useInboxStore((s) => s.blockedReviveRequestedAt);
  const stopsSig = useInboxStore((s) => hostedStopsSig(s.sessions as never, s.messages as never));
  const prev = useRef<Map<string, SubagentStateGroup[]> | undefined>(undefined);
  const omitId = flatView ? currentSessionId ?? null : null;
  const lines = useMemo(() => {
    if (!drawsSubagentLine(subagentRows, flatView)) return null;
    const all = useInboxStore.getState().sessions;
    const next = subagentLines([placed.subsByParent, placed.workersNeedingYouByParent], (id) => all[id], now, subagentFilter, prev.current, omitId);
    prev.current = next;
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placed.subsByParent, placed.workersNeedingYouByParent, now, subagentRows, subagentFilter, flatView, omitId, decisions, pendingMessages, reviveAt, stopsSig]);
  const showSubagents = subagentRows === 'full';
  const sectionCounts = useMemo(
    () => showSubagents ? fullRowsCounts(placed, subagentKeepOf(subagentFilter, now, currentSessionId)) : placed.counts,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showSubagents, placed.counts, placed.nestedSectionOf, placed.subsByParent, subagentFilter, now, currentSessionId, decisions, pendingMessages, reviveAt, stopsSig],
  );
  return { subagentRows, subagentFilter, showSubagents, lines, sectionCounts };
}
