// A session's changes folded from a boundary instead of from the start: what
// the file was at the boundary against what it is at the end. The diff pane's
// base switch picks the boundary (diffBaseStart); the fold reads only the
// changes that carry weight on either side of it (selectRangeFoldInputs), the
// same economy selectFoldInputs gives the whole-session fold.

import { computeCumulativeDiff, diffFileOf, type CumulativeChange, type DiffFile } from "./index";
import { selectFoldInputs, type FoldInputRef } from "./foldInputs";

/** Where the diff starts. `session`: the session's first edit. `branch`: the
 *  merge base with the default branch, as far as the session's own commits
 *  show it. `commit`: the session's last commit. `turn`: the last message the
 *  person sent. */
export type DiffBase = "session" | "branch" | "commit" | "turn";
export const DIFF_BASES: readonly DiffBase[] = ["session", "branch", "commit", "turn"];

export type DiffBaseInputs = {
  /** When the person last spoke (the last user message's timestamp). */
  turnStartedAt?: number;
  /** The session's branch: the branch a commit row that does not name its own was made on. */
  branch?: string | null;
  /** The repository's default branch, when known; main and master count either way. */
  defaultBranch?: string | null;
};

type BaseRef = FoldInputRef & { timestamp: number; commitBranch?: string };

const isDefaultBranch = (name: string | null | undefined, inputs: DiffBaseInputs) =>
  !!name && (name === inputs.defaultBranch || name === "main" || name === "master");

/**
 * The index of the first change after the boundary, or null when the base
 * names nothing in this session (no commit yet, no message of the person's).
 * A start equal to `changes.length` is a real answer: nothing changed since.
 */
export function diffBaseStart(changes: readonly BaseRef[], base: DiffBase, inputs: DiffBaseInputs = {}): number | null {
  if (base === "session") return 0;
  if (base === "turn") {
    if (inputs.turnStartedAt === undefined) return null;
    const at = changes.findIndex((c) => c.timestamp >= inputs.turnStartedAt!);
    return at === -1 ? changes.length : at;
  }
  for (let i = changes.length - 1; i >= 0; i--) {
    const c = changes[i];
    if (c.changeType !== "commit") continue;
    // The last commit, or the last one that landed on the default branch: the
    // session's commits on a feature branch sit after the merge base, so
    // their edits stay in the diff.
    if (base === "commit" || isDefaultBranch(c.commitBranch ?? inputs.branch, inputs)) return i + 1;
  }
  return base === "commit" ? null : 0;
}

/**
 * What a fold from `from` to `to` (inclusive indexes) reads, by side: `base`
 * recovers each touched file's text at the boundary, `head` its text at `to`.
 * Only files with a change inside the range appear. Fetch the union's bodies.
 */
export function selectRangeFoldInputs<T extends FoldInputRef>(changes: T[], from: number, to: number | null): { base: T[]; head: T[] } {
  const end = Math.min(to ?? changes.length - 1, changes.length - 1);
  if (from > end) return { base: [], head: [] };
  const touched = new Set<string>();
  for (let i = Math.max(0, from); i <= end; i++) {
    if (changes[i].changeType !== "commit") touched.add(changes[i].filePath);
  }
  const ofTouched = (list: T[]) => list.filter((c) => touched.has(c.filePath));
  return {
    base: from > 0 ? ofTouched(selectFoldInputs(changes, from - 1)) : [],
    head: ofTouched(selectFoldInputs(changes, end)),
  };
}

/**
 * The tree from the boundary to the end, newest file first. A file whose text
 * at the boundary is known (some whole-file change came before it) diffs that
 * text against its latest; one the session only ever string-edited before the
 * boundary shows the edits inside the range; one first touched inside the
 * range folds exactly as the whole-session fold would.
 */
export function computeRangeFiles(base: CumulativeChange[], head: CumulativeChange[]): RangeDiffFile[] {
  const baseSeqs = new Set(base.map((c) => c.sequenceIndex));
  const byFile = <C extends CumulativeChange>(list: C[]) => {
    const map = new Map<string, C[]>();
    for (const c of list) if (c.changeType !== "commit") (map.get(c.filePath) ?? map.set(c.filePath, []).get(c.filePath)!).push(c);
    return map;
  };
  const baseByFile = byFile(base);
  const files: Array<RangeDiffFile & { last: number }> = [];
  for (const [filePath, headChanges] of byFile(head)) {
    const before = baseByFile.get(filePath) ?? [];
    const after = computeCumulativeDiff(headChanges)[0];
    if (!after) continue;
    const newStr = after.deleted ? "" : after.newContent;
    let oldStr: string;
    let existed: boolean;
    if (before.some((c) => c.changeType !== "edit")) {
      const atBoundary = computeCumulativeDiff(before)[0];
      existed = !atBoundary?.deleted;
      oldStr = existed ? atBoundary?.newContent ?? "" : "";
    } else if (before.length === 0) {
      oldStr = after.oldContent ?? "";
      existed = !(headChanges[0].changeType === "write" && headChanges[0].oldContent === undefined);
    } else {
      const inRange = computeCumulativeDiff(headChanges.filter((c) => !baseSeqs.has(c.sequenceIndex)))[0];
      if (!inRange) continue;
      oldStr = inRange.oldContent ?? "";
      existed = true;
      if (!after.deleted) {
        files.push({ ...diffFileOf(filePath, oldStr, inRange.newContent, "modified"), contentHash: contentHash(newStr), last: lastSeq(headChanges) });
        continue;
      }
    }
    const status = after.deleted ? "deleted" : existed ? "modified" : "added";
    if (status === "modified" && oldStr === newStr) continue;
    files.push({ ...diffFileOf(filePath, oldStr, newStr, status), contentHash: contentHash(after.deleted ? "\u0000deleted" : newStr), last: lastSeq(headChanges) });
  }
  files.sort((a, b) => b.last - a.last);
  return files.map(({ last: _last, ...file }) => file);
}

/** A file of the tree with a stamp of its text at the end of the range: the
 *  same text gives the same stamp whatever the base, so a reader's "seen"
 *  mark outlives a base switch and lapses only when the file changes. */
export type RangeDiffFile = DiffFile & { contentHash: string };

/** FNV-1a, 32 bits, as hex: a stamp, not a security boundary. */
export function contentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const lastSeq = (list: CumulativeChange[]) => Math.max(...list.map((c) => c.sequenceIndex));
