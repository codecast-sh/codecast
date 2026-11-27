// Where the `:` line's Tab completion (complete.ts) reads a folder's files
// and open tabs. Kept free of the vim engine, so a workspace can register
// without loading it.

import type { EditorView } from "@codemirror/view";

export interface ExCompletionSource {
  /** Every path in the folder (relative to its root); folders may appear
   *  with `dir`, and are also read off the paths beneath them. */
  files(): Record<string, { dir?: boolean }>;
  /** The paths of the open tabs, most recent first. */
  tabs(): string[];
}

type SourceFor = (view: EditorView) => ExCompletionSource | null;
const sources = new Set<SourceFor>();

/** A workspace offers its files and tabs for the editors it holds. Returns
 *  the unregister function. */
export function registerExCompletionSource(fn: SourceFor): () => void {
  sources.add(fn);
  return () => {
    sources.delete(fn);
  };
}

export function exCompletionSourceFor(view: EditorView): ExCompletionSource | null {
  for (const fn of sources) {
    const s = fn(view);
    if (s) return s;
  }
  return null;
}
