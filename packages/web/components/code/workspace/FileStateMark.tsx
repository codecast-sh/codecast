// What a file needs from the person, marked where it is listed (a tab, the
// tab switcher, quick open's open files): unsaved edits, or a state its strip
// holds (changed on disk, a merge, deleted, read-only, a save that failed or
// waits on the daemon). The same mark everywhere, so a background tab says
// which file wants attention without opening it.
import { fileStateWords } from "../../../lib/code/workspace/fileState";
import { conflictTone, type CodeConflict } from "../../../store/codeStore";

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
