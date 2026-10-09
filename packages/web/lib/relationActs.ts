/**
 * The task graph's relation modes and the words for each of them
 * (docs/architecture/task-graph.md TG12). A leaf module on purpose: the
 * palette's rows, the row context menu, the task page's adds and the palette's
 * own field all need these words, and only the writers in `taskRelations` need
 * the store — `taskRelations` re-exports everything here, so nothing imports
 * the store to learn what a button is called.
 */

/** Which link the palette writes: a blocker of the target ("blocker"), a task
 *  that waits on the target ("blocks", the Blocks row's own add, which writes
 *  the same edge from the other side), a see-also link, or the task this one
 *  was found while working on ("found_during", a provenance link the server
 *  GUESSES from the filing session's bound task and so needs repointing, TG5).
 *
 *  One list, which the type and the guard below both derive from: a mode added
 *  here reaches every palette branch that gates on `isRelationMode`, rather
 *  than compiling while the guard quietly answers false for it. */
export const RELATION_MODES = ["blocker", "related", "blocks", "found_during"] as const;

export type RelationMode = (typeof RELATION_MODES)[number];

/** Whether a palette mode is one of the relation searches, for the palette's
 *  branches. */
export function isRelationMode(mode: string | null | undefined): mode is RelationMode {
  return (RELATION_MODES as readonly string[]).includes(mode as string);
}

/**
 * What each relation add is called, and what the field that opens for it says.
 * One act per mode, in one place, because a button, a row menu item and the
 * palette's placeholder are three halves of one gesture: when they drifted,
 * "Make a task wait on this…" opened a field headed "Add a task that waits on
 * this", and `blocks` is the direction TG12 says people already get backwards,
 * so it is the worst place to rename the act mid-gesture. The parent is here
 * too: it is a relation the same palette writes.
 *
 * The Blocks ROW has a label above it saying which way the edge points, so
 * there the add can be the short "Add blocked task…" (`BLOCKS_ADD`); every
 * other place the act stands alone and says the whole of it.
 */
export const RELATION_ACT: Record<RelationMode | "parent", string> = {
  blocker: "Add blocker…",
  blocks: "Make a task wait on this…",
  related: "Link related task…",
  found_during: "Set what this was found during…",
  parent: "Set parent…",
};

/**
 * The act said of a link that already HAS a value, for the one row that
 * offers a repoint rather than an add: `found_during` is the server's guess
 * from the filing session's bound task (TG5), so the task page's Found during
 * row changes it instead of setting it. Same stem as the act, so the button,
 * the field it opens and the row's label are one sentence either way.
 */
export const RELATION_REPOINT: Partial<Record<RelationMode | "parent", string>> = {
  found_during: "Change what this was found during…",
};

/** What a mode's field reads. A blocker is any of TG3's refs, not only a
 *  task; the hint under the field carries the exact forms. */
const RELATION_FIELD: Partial<Record<RelationMode | "parent", string>> = {
  blocker: "a task, a PR, a decision or a time…",
};

/** The placeholder of the field a mode opens: the act that opened it with the
 *  ellipsis replaced by what the field reads ("Set parent…" → "Set parent —
 *  search tasks…"), so an act and its field can only ever be written
 *  together. `repoint` is the field opened over a link that already has a
 *  value, which the row offers as a change (`RELATION_REPOINT`). */
export function relationPlaceholder(mode: RelationMode | "parent", opts?: { repoint?: boolean }): string {
  const act = (opts?.repoint ? RELATION_REPOINT[mode] : undefined) ?? RELATION_ACT[mode];
  return `${act.replace(/…$/, "")} — ${RELATION_FIELD[mode] ?? "search tasks…"}`;
}
