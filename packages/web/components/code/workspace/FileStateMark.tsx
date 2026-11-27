// What a file needs from the person, marked where it is listed (a tab, the
// tab switcher, quick open's open files): unsaved edits, or a state its strip
// holds (changed on disk, a merge, deleted, read-only, a save that failed or
// waits on the daemon). The same mark everywhere, so a background tab says
// which file wants attention without opening it.
import { conflictTone, type CodeConflict } from "../../../store/codeStore";

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

/** The dot in the slot a dirty file's dot takes; a merge with conflicts shows
 *  their count. Nothing for a clean file with nothing pending. */
export function FileStateMark({ conflict, dirty, className = "" }: { conflict: CodeConflict | undefined; dirty: boolean; className?: string }) {
  const tone = conflictTone(conflict);
  const words = fileStateWords(conflict, dirty);
  if (!words) return null;
  const color = tone === "alarm" ? "bg-sol-red" : tone === "warn" ? "bg-sol-yellow" : "bg-sol-text-muted";
  if (conflict?.kind === "merge" && conflict.conflicts > 0) {
    return (
      <span role="img" aria-label={words} data-file-state="merge" className={`min-w-4 rounded-full bg-sol-yellow/20 px-1 text-center text-mark font-semibold leading-4 tabular-nums text-sol-yellow ${className}`}>
        {conflict.conflicts}
      </span>
    );
  }
  return <span role="img" aria-label={words} data-file-state={conflict?.kind ?? "dirty"} className={`size-2 shrink-0 rounded-full ${color} ${className}`} />;
}
