// The folding now lives in @codecast/shared/diff so `cast diff` draws the same
// tree; re-exported here to keep the web import paths.
export { computeCumulativeFiles } from "@codecast/shared/diff";

import { computeRangeFiles, type RangeDiffFile } from "@codecast/shared/diff";
import { withBody, type FileChange, type FileChangeBody } from "./fileChangeExtractor";
import type { FileChangeEntry } from "../store/diffViewerStore";

/**
 * Fold the files whose inputs all have text. `inputs` is what the fold reads
 * on each side of the base (shared/diff selectRangeFoldInputs; a fold from
 * the session's start has an empty `base`); a body comes from the entry
 * itself (the loaded window's extraction) or from the fetched cache. A file
 * with an unfetched input is `pending`; one with a body the server does not
 * have is left out and not waited on.
 */
export function foldReadyFiles(
  inputs: { base: FileChangeEntry[]; head: FileChangeEntry[] },
  bodies: Record<string, FileChangeBody>,
  missing: Record<string, true>,
): { files: RangeDiffFile[]; pending: number } {
  const byFile = new Map<string, { ready: boolean; missing: boolean }>();
  for (const change of [...inputs.base, ...inputs.head]) {
    const state = byFile.get(change.filePath) ?? { ready: true, missing: false };
    if (missing[change.id]) {
      state.missing = true;
      state.ready = false;
    } else if (change.newContent === undefined && !bodies[change.id]) {
      state.ready = false;
    }
    byFile.set(change.filePath, state);
  }
  let pending = 0;
  for (const state of byFile.values()) if (!state.ready && !state.missing) pending++;
  const withText = (list: FileChangeEntry[]): FileChange[] => list
    .filter((change) => byFile.get(change.filePath)?.ready)
    .map((change) => {
      const { oldBytes: _o, newBytes: _n, oldContent, newContent, ...ref } = change;
      const body = newContent !== undefined ? { oldContent, newContent } : bodies[change.id];
      return withBody({ ...ref, newBytes: 0 }, body);
    });
  return { files: computeRangeFiles(withText(inputs.base), withText(inputs.head)), pending };
}
