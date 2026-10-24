// "Seen" marks on a conversation's diff pane: the reader's own note that a
// file is read. A mark keeps the stamp of the file's text when it was made
// (shared/diff contentHash), so it lapses by itself when the agent changes the
// file again, and survives a base switch, which changes the diff but not the
// text. It also keeps the change that produced that text, which is what the
// "review" base diffs from, and the mark before it, so a file that has not
// moved since still shows what changed since the review before. Stored in
// clientState.ui.diff_seen_files, so it follows the person.

import { useInboxStore } from "../store/inboxStore";

/** One reviewed version: the text's stamp and the id of the change that wrote it. */
export type SeenVersion = { h: string; at?: string };
/** A file's mark. A bare string is a stamp made before marks kept the version. */
export type SeenMark = string | (SeenVersion & { prev?: SeenVersion });
/** Path to its mark. */
export type SeenMarks = Record<string, SeenMark>;

const versionOf = (mark: SeenMark | undefined): SeenVersion | undefined =>
  mark === undefined ? undefined : typeof mark === "string" ? { h: mark } : { h: mark.h, ...(mark.at && { at: mark.at }) };

/** Marked, and not changed since. */
export function isSeen(marks: SeenMarks | undefined, path: string, contentHash: string): boolean {
  return versionOf(marks?.[path])?.h === contentHash;
}

/** Mark a file seen at the change `at`, or clear a live mark. A lapsed mark
 *  counts as unmarked, so the gesture on a file that changed since marks it
 *  again and keeps the old version as the one before. Clearing a live mark
 *  steps back to the version before it, when there is one. */
export function toggleSeen(marks: SeenMarks | undefined, path: string, contentHash: string, at?: string): SeenMarks {
  const next = { ...marks };
  const current = marks?.[path];
  if (isSeen(marks, path, contentHash)) {
    const prev = typeof current === "object" ? current.prev : undefined;
    if (prev) next[path] = prev;
    else delete next[path];
  } else {
    const prev = versionOf(current);
    next[path] = { h: contentHash, ...(at && { at }), ...(prev && { prev }) };
  }
  return next;
}

/** The change the "review" base diffs a file from, given its last change: the
 *  reviewed version when the file moved since, else the review before that.
 *  Undefined means the file has no reviewed version to start from. */
export function reviewBaseId(mark: SeenMark | undefined, lastChangeId: string): string | undefined {
  if (!mark || typeof mark === "string") return undefined;
  if (mark.at && mark.at !== lastChangeId) return mark.at;
  return mark.prev?.at;
}

/** Does any mark carry a version the "review" base can start from? */
export function hasReviewBase(marks: SeenMarks | undefined): boolean {
  return !!marks && Object.values(marks).some((m) => typeof m === "object" && !!(m.at || m.prev?.at));
}

export function toggleSeenFile(conversationId: string, path: string, contentHash: string, at?: string): void {
  const s = useInboxStore.getState();
  const all = s.clientState.ui?.diff_seen_files ?? {};
  const next = toggleSeen(all[conversationId], path, contentHash, at);
  const { [conversationId]: _old, ...rest } = all;
  s.updateClientUI({ diff_seen_files: Object.keys(next).length ? { ...rest, [conversationId]: next } : rest });
}
