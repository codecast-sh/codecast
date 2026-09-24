// The folding now lives in @codecast/shared/diff so `cast diff` draws the same
// tree; re-exported here to keep the web import paths.
export { computeCumulativeFiles } from "@codecast/shared/diff";

import { computeCumulativeFiles as foldFiles, type DiffFile } from "@codecast/shared/diff";
import { withBody, type FileChangeBody } from "./fileChangeExtractor";
import type { FileChangeEntry } from "../store/diffViewerStore";

/**
 * Fold the files whose inputs all have text. `inputs` is what the fold reads
 * (shared/diff selectFoldInputs); a body comes from the entry itself (the
 * loaded window's extraction) or from the fetched cache. A file with an
 * unfetched input is `pending`; one with a body the server does not have is
 * left out and not waited on.
 */
export function foldReadyFiles(
  inputs: FileChangeEntry[],
  bodies: Record<string, FileChangeBody>,
  missing: Record<string, true>,
): { files: DiffFile[]; pending: number } {
  const byFile = new Map<string, { ready: boolean; missing: boolean }>();
  for (const change of inputs) {
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
  const folded = inputs
    .filter((change) => byFile.get(change.filePath)?.ready)
    .map((change) => {
      const { oldBytes: _o, newBytes: _n, oldContent, newContent, ...ref } = change;
      const body = newContent !== undefined ? { oldContent, newContent } : bodies[change.id];
      return withBody({ ...ref, newBytes: 0 }, body);
    });
  return { files: foldFiles(folded, null), pending };
}
