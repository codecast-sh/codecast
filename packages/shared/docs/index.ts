/**
 * Doc provenance — the shared rule behind the web docs list, mobile's docs
 * segment, and the convex write paths, so the three never drift. Mirrors
 * @codecast/shared/tasks, which owns the same question for tasks.
 *
 * ORIGIN answers "did a person write this doc, or did a machine file it".
 * The complaint that started this (Aug 26) was the docs list drowning in
 * agent plan bodies and session-mined notes: thousands of machine rows
 * burying the handful of docs a person actually wrote or pinned.
 */

/**
 * Every value docs.source may hold. `plan_mode` comes from the agent
 * transcript importer, `file_sync` / `inline_extract` from session mining,
 * `import` from bulk imports.
 */
export type DocSource =
  | "human"
  | "agent"
  | "plan_mode"
  | "file_sync"
  | "inline_extract"
  | "import";

export type DocOrigin = "human" | "agent";

/**
 * The three classes a person tells apart, mirroring tasks (human board /
 * agent-internal / mined suggestions):
 *
 * - `human` — a person created the doc in the UI (or `cast doc create`
 *   outside a session).
 * - `agent` — an agent deliberately filed it: `cast doc create` in a session,
 *   a plan body, a plan-mode capture.
 * - `mined` — nobody filed it; machinery collected it: session extracts,
 *   synced files, bulk imports.
 */
export type DocOriginClass = "human" | "agent" | "mined";

const MINED_SOURCES = new Set(["file_sync", "inline_extract", "import"]);

export function docOriginClass(doc: { source?: string | null }): DocOriginClass {
  if (doc.source === "human") return "human";
  if (doc.source && MINED_SOURCES.has(doc.source)) return "mined";
  return "agent";
}

/**
 * Only an explicit `human` stamp counts as human. Everything else — including
 * a source literal added later — is machine origin, so a new writer is quiet
 * by default and never leaks onto the human shelf unlabeled.
 */
export function docOrigin(doc: { source?: string | null }): DocOrigin {
  return doc.source === "human" ? "human" : "agent";
}

export function isHumanDocOrigin(doc: { source?: string | null }): boolean {
  return docOrigin(doc) === "human";
}

/**
 * The human's shelf: what a person expects to see in the docs list without
 * asking for agent output. A doc is on it when a person wrote it (human
 * origin) or when someone pinned it — pinning a machine-made doc is the
 * deliberate "this one matters" gesture, the docs analog of promoting a task
 * onto the board.
 */
export function isOnHumanShelf(doc: {
  source?: string | null;
  pinned?: boolean | null;
}): boolean {
  return isHumanDocOrigin(doc) || !!doc.pinned;
}

/**
 * The doc source a plan-body doc should carry, derived from its plan's
 * source. Plans have their own source vocabulary (human, promoted, template,
 * fork, imported…); the doc only needs the origin answer, and anything a
 * person didn't file directly is machine work.
 */
export function docSourceForPlanSource(planSource: string | null | undefined): "human" | "agent" {
  return planSource === "human" ? "human" : "agent";
}
