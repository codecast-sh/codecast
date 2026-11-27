// The phone inbox list's lines (app/(tabs)/inbox.tsx): a section is its
// heading and its rows, and the flat views' one "All" run marks each row
// drawn under its card and counts as web's rail does. No React Native here,
// so lib/inboxListItems.test.ts reads the lines the list draws.
import type { ReactNode } from 'react';
import { drawnUnderParentIds, flatHeaderCount, type InboxSession } from '@codecast/web/store/inboxStore';

/** One line of the inbox list: a section's heading, a session row, or a whole
 *  state (the skeleton, an empty inbox). The list is virtualized, so only the
 *  lines near the screen are mounted, whatever the account holds. */
export type InboxListItem =
  | { kind: 'header'; key: string; section: string; label: string; color?: string; count: number; collapsed: boolean }
  | { kind: 'row'; key: string; session: InboxSession; underParent?: boolean }
  | { kind: 'node'; key: string; node: ReactNode };

/** A section's heading and, open, its rows. `count` is the header number
 *  when it is not the rows' (the chokepoint's section count), and
 *  `underParent` the rows drawn under their card. */
export function sectionItems(label: string, items: readonly InboxSession[], opts: { key: string; collapsed: boolean; color?: string; count?: number; underParent?: ReadonlySet<string> }): InboxListItem[] {
  if (items.length === 0) return [];
  const { key, collapsed, color, underParent } = opts;
  const out: InboxListItem[] = [{ kind: 'header', key: `h:${key}`, section: key, label, color, count: opts.count ?? items.length, collapsed }];
  if (!collapsed) for (const session of items) out.push({ kind: 'row', key: `${key}:${session._id}`, session, underParent: underParent?.has(session._id) });
  return out;
}

/** The flat views' "All" run (flatViewSessions' list): a subagent hoisted
 *  under its card reads as drawn there (rowWithOwner), and the header leaves
 *  out the children their sessions own, as web's does (flatHeaderCount). */
export function flatAllItems(flat: readonly InboxSession[], subsByParent: ReadonlyMap<string, readonly InboxSession[]>, opts: { collapsed: boolean; color?: string; meId: string | null | undefined }): InboxListItem[] {
  const { meId, ...look } = opts;
  const underParent = drawnUnderParentIds(flat, subsByParent);
  return sectionItems('All', flat, { key: 'all', ...look, count: flatHeaderCount(flat, underParent, meId), underParent });
}
