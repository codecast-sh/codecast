// The inbox's priority tags and Priorities view (web's): in every view a row
// filed under one of the viewer's priorities says its rank and title, read off
// the viewer's ranks (one subscription, fed while any workspace has priorities
// on). The Priorities view also sorts each status section by that priority,
// and feeds every workspace's priorities with the same call as the Priorities
// list, so a move re-sorts at once and neither snapshot drops the other's
// workspaces; resolveInboxViewMode allows it only in a workspace with them on.
import { useMemo } from 'react';
import { api } from '@codecast/convex/convex/_generated/api';
import { useInboxStore, type InboxSession, type InboxViewMode } from '@codecast/web/store/inboxStore';
import { prioritiesAnywhere } from '@codecast/web/store/priorityOrder';
import { useSyncCollection } from '@codecast/web/hooks/useSyncCollection';
import { useSyncPriorities } from '@/hooks/usePriorityList';
import { priorityInboxSig, priorityInboxView, type PriorityInboxView } from '@/lib/inboxPriorities';

/** The rows' priority labels while any workspace has priorities on, sorting only in the Priorities view; else null. */
export function useInboxPriorityView(viewMode: InboxViewMode): PriorityInboxView | null {
  const sorts = viewMode === 'priorities';
  const on = useInboxStore(prioritiesAnywhere);
  // The same call as the Priorities list, so neither one's snapshot drops the other's workspaces.
  useSyncPriorities(sorts);
  // The viewer's ranks and titles in every workspace.
  useSyncCollection('priorityRanks', (api as any).priorityRanks.mine, on ? {} : 'skip');
  const sig = useInboxStore((s) => (on ? priorityInboxSig(s) : ''));
  return useMemo(() => (sig ? priorityInboxView(useInboxStore.getState(), sorts) : null), [sig, sorts]);
}

const sorted = (view: PriorityInboxView | null, rows: InboxSession[]) => (view ? view.sort(rows) : rows);

/** The inbox's status sections, each sorted by rank while the Priorities view is up (the view's `sort`), else as given. */
export function usePrioritySections(view: PriorityInboxView | null, questions: InboxSession[], newRows: InboxSession[], needsInput: InboxSession[], done: InboxSession[], dormant: InboxSession[], working: InboxSession[]) {
  return {
    questions: useMemo(() => sorted(view, questions), [view, questions]),
    newRows: useMemo(() => sorted(view, newRows), [view, newRows]),
    needsInput: useMemo(() => sorted(view, needsInput), [view, needsInput]),
    done: useMemo(() => sorted(view, done), [view, done]),
    dormant: useMemo(() => sorted(view, dormant), [view, dormant]),
    working: useMemo(() => sorted(view, working), [view, working]),
  };
}
