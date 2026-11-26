// The inbox's Priorities view (web's): the status sections stay, each sorted
// by the viewer's priority a session serves, and every row says its rank. The
// priorities are fed only while the view is up, which resolveInboxViewMode
// allows only in a workspace with them on.
import { useMemo } from 'react';
import { api } from '@codecast/convex/convex/_generated/api';
import { useInboxStore, type InboxSession, type InboxViewMode } from '@codecast/web/store/inboxStore';
import { useSyncCollection } from '@codecast/web/hooks/useSyncCollection';
import { useActiveWorkspaceKey } from '@codecast/web/hooks/useWorkspaceCollection';
import { listRows } from '@codecast/web/lib/priorities';
import { priorityInboxSig, priorityInboxView, type PriorityInboxView } from '@/lib/inboxPriorities';

/** The view's sort and rank labels while the Priorities view is up, else null. */
export function useInboxPriorityView(viewMode: InboxViewMode): PriorityInboxView | null {
  const on = viewMode === 'priorities';
  const workspaceKey = useActiveWorkspaceKey();
  // The generated api's type stops short of priorities here, as on the priority screen.
  useSyncCollection('priorities', (api as any).priorities.list, on && workspaceKey ? { workspace: workspaceKey } : 'skip', { select: listRows });
  const sig = useInboxStore((s) => (on ? priorityInboxSig(s) : ''));
  return useMemo(() => {
    if (!sig) return null;
    const st = useInboxStore.getState();
    return priorityInboxView(st.priorities, st.currentUser?._id, st.sessions);
  }, [sig]);
}

const sorted = (view: PriorityInboxView | null, rows: InboxSession[]) => (view ? view.sort(rows) : rows);

/** The inbox's status sections, each sorted by rank while the Priorities view is up, else as given. */
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
