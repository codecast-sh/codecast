// "Seen" marks on a conversation's diff pane: the reader's own note that a
// file is read. A mark keeps the stamp of the file's text when it was made
// (shared/diff contentHash), so it lapses by itself when the agent changes the
// file again, and survives a base switch, which changes the diff but not the
// text. Stored in clientState.ui.diff_seen_files, so it follows the person.

import { useInboxStore } from "../store/inboxStore";

/** Path to the stamp of the file's text when it was marked. */
export type SeenMarks = Record<string, string>;

/** Marked, and not changed since. */
export function isSeen(marks: SeenMarks | undefined, path: string, contentHash: string): boolean {
  return marks?.[path] === contentHash;
}

/** Mark a file seen, or clear a live mark. A lapsed mark counts as unmarked,
 *  so the gesture on a file that changed since marks it again. */
export function toggleSeen(marks: SeenMarks | undefined, path: string, contentHash: string): SeenMarks {
  const next = { ...marks };
  if (isSeen(marks, path, contentHash)) delete next[path];
  else next[path] = contentHash;
  return next;
}

export function toggleSeenFile(conversationId: string, path: string, contentHash: string): void {
  const s = useInboxStore.getState();
  const all = s.clientState.ui?.diff_seen_files ?? {};
  const next = toggleSeen(all[conversationId], path, contentHash);
  const { [conversationId]: _old, ...rest } = all;
  s.updateClientUI({ diff_seen_files: Object.keys(next).length ? { ...rest, [conversationId]: next } : rest });
}
