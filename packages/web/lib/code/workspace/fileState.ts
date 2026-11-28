// The words and name style a listed file (a tab, the tab switcher, quick
// open's open files) carries for what it needs from the person.

import type { CodeConflict } from "../../../store/codeStore";

const WORD: Record<CodeConflict["kind"], string> = {
  stale: "changed on disk",
  merge: "merging",
  deleted: "deleted on disk",
  readonly: "read-only on disk",
  offline: "not saved, reconnecting",
  error: "save failed",
};

/** The words a list row's label adds for this state, or null for none. */
export function fileStateWords(conflict: CodeConflict | undefined, dirty: boolean): string | null {
  if (conflict?.kind === "merge" && conflict.conflicts > 0) return `${conflict.conflicts} ${conflict.conflicts === 1 ? "conflict" : "conflicts"}`;
  if (conflict) return WORD[conflict.kind];
  return dirty ? "unsaved" : null;
}

/** A deleted file's name is struck through where it is listed. */
export const deletedNameClass = (conflict: CodeConflict | undefined) => (conflict?.kind === "deleted" ? "line-through opacity-60" : "");
