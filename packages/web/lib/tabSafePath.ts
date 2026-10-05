// The one rule for what a tab may hold as its address. A tab's path (and each
// split leaf's) is persisted to IndexedDB and synced to Convex client_state,
// and an action carrying it rides the outbox, so a path is brought to the
// form that is safe to store before the tab system keeps it, wherever the
// path came from: a link, the address bar, a hydrated tab list. Today that is
// the Evals area, whose addresses may name private freezes and batches
// (components/evals/evalsPaths.ts evalsCanonicalPath); every other path
// passes through unchanged. Pure and relative-imported, so the store, the
// stage and the router compat layer can all call it. A tab's title persists
// beside its path, so an Evals tab is named from its storable address and
// never from words a caller passed in. The engine keeps an action's args as
// the caller passed them (the outbox row, the dispatch call), so the actions
// that carry a tab address have their args brought to the same form at both
// sinks (storableActionArgs).

import { evalsCanonicalPath, evalsTabLabel, isEvalsPath } from "../components/evals/evalsPaths";

export function tabSafePath(path: string): string {
  return isEvalsPath(path) ? evalsCanonicalPath(path) : path;
}

/** The title a tab may keep for `path`: an Evals tab's label from its storable address, any other tab's own title. */
export function tabSafeTitle(path: string, title: string): string {
  return isEvalsPath(path) ? evalsTabLabel(tabSafePath(path)) : title;
}

/**
 * The store actions whose args can carry a tab address: a bare path, or a
 * record with a `path` (a tab, a patch, a split layout's leaves, a workbench).
 * Only these are walked, so free text in any other action (a message that
 * quotes an /evals link) is never rewritten.
 */
const TAB_PATH_ACTIONS = new Set(["openTab", "updateTab", "saveCurrentTabState", "stageInsertLeaf", "stageSetLeafPath", "applyWorkbench"]);

function storable(v: unknown): unknown {
  if (typeof v === "string") return isEvalsPath(v) ? tabSafePath(v) : v;
  if (Array.isArray(v)) {
    const next = v.map(storable);
    return next.some((x, i) => x !== v[i]) ? next : v;
  }
  if (!v || typeof v !== "object") return v;
  const rec = v as Record<string, unknown>;
  let out: Record<string, unknown> | null = null;
  for (const k in rec) {
    const x = storable(rec[k]);
    if (x !== rec[k]) (out ??= { ...rec })[k] = x;
  }
  const r = out ?? rec;
  if (typeof rec.path === "string" && typeof rec.title === "string" && isEvalsPath(rec.path)) {
    const title = tabSafeTitle(rec.path, rec.title);
    if (title !== r.title) (out ??= { ...rec }).title = title;
  }
  return out ?? rec;
}

/** An action's args as they may be stored and sent: a tab-path action's Evals addresses and titles in their storable form, any other action's args as they are. */
export function storableActionArgs<T>(action: string, args: T): T {
  return TAB_PATH_ACTIONS.has(action) ? (storable(args) as T) : args;
}
