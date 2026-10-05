// The one rule for what a tab may hold as its address. A tab's path (and each
// split leaf's) is persisted to IndexedDB and synced to Convex client_state,
// and an action carrying it rides the outbox, so a path is brought to the
// form that is safe to store before the tab system keeps it, wherever the
// path came from: a link, the address bar, a hydrated tab list. Today that is
// the Evals area, whose addresses may name private freezes and batches
// (components/evals/evalsPaths.ts evalsCanonicalPath); every other path
// passes through unchanged. Pure and relative-imported, so the store, the
// stage and the router compat layer can all call it.

import { evalsCanonicalPath, isEvalsPath } from "../components/evals/evalsPaths";

export function tabSafePath(path: string): string {
  return isEvalsPath(path) ? evalsCanonicalPath(path) : path;
}
