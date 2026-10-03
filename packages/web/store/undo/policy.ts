// Every store creator's undo classification, in one place.
//
// Each creator on the inbox store is classified exactly once, in one of the
// policy files below: a spec (the action is undoable; the engine records the
// cells it changed and replays them on undo) or a reason it never is. The
// guard test (store/__tests__/undoPolicy.guard.test.ts) fails on a creator
// nobody classified, on one classified twice, and on a stale name. The engine
// receives only the specs, as PlatformConfig.undo.specs.
import type { UndoSpec } from "@platform/engine";
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

export const UNDO_SPECS: Record<string, UndoSpec> = Object.fromEntries(
  Object.entries(UNDO_POLICY).flatMap(([name, entry]) => ("spec" in entry ? [[name, entry.spec]] : [])),
);
