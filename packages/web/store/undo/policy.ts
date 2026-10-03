// Every store creator's undo classification, in one place.
//
// Each creator on the inbox store is classified exactly once, in one of the
// policy files below: a spec (the action is undoable; the engine records the
// cells it changed and replays them on undo) or a reason it never is. The
// guard test (store/__tests__/undoPolicy.guard.test.ts) fails on a creator
// nobody classified, on one classified twice, and on a stale name. The engine
// receives only the specs, as PlatformConfig.undo.specs.
import type { CellChange, UndoSpec } from "@platform/engine";
import { NEVER_UNDO_POLICY } from "./policies/never";
import { SESSIONS_UNDO_POLICY } from "./policies/sessions";
import { WORK_UNDO_POLICY } from "./policies/work";

export type UndoPolicyEntry = { spec: UndoSpec } | { never: string };
export type UndoPolicy = Record<string, UndoPolicyEntry>;

/** The policy files, by owner, so the guard can prove each name appears once. */
export const UNDO_POLICY_FILES: Record<"never" | "sessions" | "work", UndoPolicy> = {
  never: NEVER_UNDO_POLICY,
  sessions: SESSIONS_UNDO_POLICY,
  work: WORK_UNDO_POLICY,
};

export const UNDO_POLICY: UndoPolicy = Object.assign({}, ...Object.values(UNDO_POLICY_FILES));

// A session that was never opened in this window has no `conversations` row,
// and an action that writes one (favorite, pin, privacy, project) creates a
// thin `{_id}` row to carry the write. That row stands for a server row: no
// undoable action mints a conversation (creates are never undoable). So the
// undo of such an add clears the fields the action wrote and keeps the row.
// Deleting it would plant a `conversations:<id>` exclude that nothing retires,
// and the conversation's meta could never sync in again; it would also throw
// away meta that loaded between the gesture and its undo.
export const keepConversationRows = (cells: CellChange[]): CellChange[] =>
  cells.flatMap((c) => {
    if (c.store !== "conversations" || c.field !== undefined || c.hadBefore || !c.hadAfter) return [c];
    const added = (c.after ?? {}) as Record<string, unknown>;
    return Object.keys(added)
      .filter((field) => field !== "_id")
      .map((field) => ({ ...c, field, before: undefined, after: added[field] }));
  });

const keepingConversationRows = (spec: UndoSpec): UndoSpec => {
  const own = spec.spell;
  return { ...spec, spell: own ? (cells) => own(keepConversationRows(cells)) : keepConversationRows };
};

export const UNDO_SPECS: Record<string, UndoSpec> = Object.fromEntries(
  Object.entries(UNDO_POLICY).flatMap(([name, entry]) => ("spec" in entry ? [[name, keepingConversationRows(entry.spec)]] : [])),
);
