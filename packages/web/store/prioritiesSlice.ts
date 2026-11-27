// The person's controls over their priorities (convex priorities.ts): a move,
// a title, a milestone's tier, done state, title and drop, a priority's done, set
// aside, restore and merge, a session's move and "not this", and corrections.
// Each paints the rows at once (lib/priorities paint*): the `priorities` list
// row, else the detail's own copy of a priority the list does not hold, and
// the detail's corrections. Each rides `dispatch` to the side effect of the
// same name (convex/dispatch.ts), which runs the API's own mutation. The
// list is localFirst (store/clientSyncRegistry): every field a paint writes
// whole holds over pushes from before the server had the write (an edit
// inside a joined object is written whole by heldWhole, so a milestone holds
// with its count), and the write's acknowledgement settles it on the server's
// next answer (PRIORITY_ACTIONS); a refused write is put back by its caller
// (lib/priorityWrites).
import { asyncAction } from "./mutativeMiddleware";
import { PRIORITY_OBJECT_FIELDS } from "./clientSyncRegistry";
import type { PriorDone, PriorityRow, PrioritySetBy, PriorityStepTier } from "@codecast/shared/contracts/priorities";
import {
  paintCorrection, paintCorrectionDelete, paintDetachedMove, paintDrop, paintedRow, paintMerge, paintMove, paintPriorityDone, paintRename, paintSessionMove,
  paintSessionNotThis, paintStatus, paintStepDone, paintTier, paintTitle, paintUndoPriorityDone, paintUndoStepDone, type PaintState, type PriorityMove,
} from "../lib/priorities";

export type PrioritiesSliceActions = {
  movePriority: (shortId: string, to: PriorityMove) => Promise<unknown>;
  setPriorityStepTier: (shortId: string, stepKey: string, tier: PriorityStepTier) => Promise<unknown>;
  setPriorityAside: (shortId: string) => Promise<unknown>;
  restorePriority: (shortId: string) => Promise<unknown>;
  setPriorityStepDone: (shortId: string, stepKey: string, done: boolean) => Promise<unknown>;
  renamePriorityTitle: (shortId: string, title: string) => Promise<unknown>;
  renamePriorityStep: (shortId: string, stepKey: string, title: string) => Promise<unknown>;
  dropPriorityStep: (shortId: string, stepKey: string) => Promise<unknown>;
  markPriorityDone: (shortId: string) => Promise<unknown>;
  /** The undo of the person's own done (lib/priorityWrites records it): what the press replaced comes back. */
  undoPriorityStepDone: (shortId: string, stepKey: string, setBy: PrioritySetBy | null) => Promise<unknown>;
  undoPriorityDone: (shortId: string, prior: PriorDone) => Promise<unknown>;
  mergePriority: (shortId: string, into: string) => Promise<unknown>;
  /** `from` is the priority the session shows on, for the paint; the server reads the session's own. */
  movePrioritySession: (session: string, from: string, to: string, stepKey: string | null) => Promise<unknown>;
  prioritySessionNotThis: (session: string, from: string) => Promise<unknown>;
  /** Must-deliver (store/mutativeMiddleware): `clientKey` lets the server store a retried write once. */
  correctPriority: (shortId: string, text: string, stepKey: string | null, clientKey: string) => Promise<unknown>;
  deletePriorityCorrection: (correctionId: string) => Promise<unknown>;
  /** One pass now in a workspace (priorities.run). Paints nothing: the pass writes its rows in a minute. */
  runPriorities: (workspace: string) => Promise<unknown>;
};

const listOf = (s: PaintState): PriorityRow[] => Object.values(s.priorities ?? {});
const listed = (s: PaintState, shortId: string) => listOf(s).some((r) => r.short_id === shortId);

/**
 * Writes each object a painted row joins (steps, counts, sessions, links…)
 * whole. The engine locks only a row's own field writes, so an edit inside
 * steps or links would sit unprotected beside its locked count, and a push
 * from before the server had the write would put the old milestone back under
 * the new count. A field the paint left alone locks at the value the server
 * already holds, and the next push retires it.
 */
function heldWhole(...rows: Array<PriorityRow | undefined>): void {
  for (const row of rows) {
    if (!row) continue;
    const r = row as unknown as Record<string, unknown>;
    for (const field of Object.keys(PRIORITY_OBJECT_FIELDS)) {
      const v = r[field];
      if (Array.isArray(v)) r[field] = [...v];
      else if (v && typeof v === "object") r[field] = { ...v };
    }
  }
}

export function createPrioritiesSlice(): PrioritiesSliceActions {
  return {
    movePriority: asyncAction(function (this: PaintState, shortId: string, to: PriorityMove) {
      if (listed(this, shortId)) paintMove(listOf(this), shortId, to);
      else {
        const row = paintedRow(this, shortId);
        if (row) paintDetachedMove(row, to);
      }
    }) as PrioritiesSliceActions["movePriority"],
    setPriorityStepTier: asyncAction(function (this: PaintState, shortId: string, stepKey: string, tier: PriorityStepTier) {
      const row = paintedRow(this, shortId);
      if (row) paintTier(row, stepKey, tier);
      heldWhole(row);
    }) as PrioritiesSliceActions["setPriorityStepTier"],
    setPriorityAside: asyncAction(function (this: PaintState, shortId: string) {
      paintStatus(listOf(this), shortId, "set_aside");
    }) as PrioritiesSliceActions["setPriorityAside"],
    restorePriority: asyncAction(function (this: PaintState, shortId: string) {
      paintStatus(listOf(this), shortId, "active");
    }) as PrioritiesSliceActions["restorePriority"],
    setPriorityStepDone: asyncAction(function (this: PaintState, shortId: string, stepKey: string, done: boolean) {
      const row = paintedRow(this, shortId);
      if (row) paintStepDone(row, stepKey, done, Date.now());
      heldWhole(row);
    }) as PrioritiesSliceActions["setPriorityStepDone"],
    renamePriorityTitle: asyncAction(function (this: PaintState, shortId: string, title: string) {
      const row = paintedRow(this, shortId);
      if (row) paintTitle(row, title);
    }) as PrioritiesSliceActions["renamePriorityTitle"],
    renamePriorityStep: asyncAction(function (this: PaintState, shortId: string, stepKey: string, title: string) {
      const row = paintedRow(this, shortId);
      if (row) paintRename(row, stepKey, title);
      heldWhole(row);
    }) as PrioritiesSliceActions["renamePriorityStep"],
    dropPriorityStep: asyncAction(function (this: PaintState, shortId: string, stepKey: string) {
      const row = paintedRow(this, shortId);
      if (row) paintDrop(this, row, stepKey);
    }) as PrioritiesSliceActions["dropPriorityStep"],
    markPriorityDone: asyncAction(function (this: PaintState, shortId: string) {
      const row = paintedRow(this, shortId);
      if (row) paintPriorityDone(row, Date.now());
    }) as PrioritiesSliceActions["markPriorityDone"],
    undoPriorityStepDone: asyncAction(function (this: PaintState, shortId: string, stepKey: string, setBy: PrioritySetBy | null) {
      const row = paintedRow(this, shortId);
      if (row) paintUndoStepDone(row, stepKey, setBy);
      heldWhole(row);
    }) as PrioritiesSliceActions["undoPriorityStepDone"],
    undoPriorityDone: asyncAction(function (this: PaintState, shortId: string, prior: PriorDone) {
      const row = paintedRow(this, shortId);
      if (row) paintUndoPriorityDone(row, prior);
    }) as PrioritiesSliceActions["undoPriorityDone"],
    mergePriority: asyncAction(function (this: PaintState, shortId: string, into: string) {
      const from = paintedRow(this, shortId);
      const to = paintedRow(this, into);
      if (from && to && from !== to) paintMerge(this, from, to);
      heldWhole(from, to);
    }) as PrioritiesSliceActions["mergePriority"],
    movePrioritySession: asyncAction(function (this: PaintState, session: string, from: string, to: string, stepKey: string | null) {
      const a = paintedRow(this, from);
      const b = paintedRow(this, to);
      if (a && b) paintSessionMove(this, session, a, b, stepKey, Date.now());
      heldWhole(a, b);
    }) as PrioritiesSliceActions["movePrioritySession"],
    prioritySessionNotThis: asyncAction(function (this: PaintState, session: string, from: string) {
      const row = paintedRow(this, from);
      if (row) paintSessionNotThis(this, session, row);
      heldWhole(row);
    }) as PrioritiesSliceActions["prioritySessionNotThis"],
    correctPriority: asyncAction(function (this: PaintState, shortId: string, text: string, stepKey: string | null, clientKey: string) {
      const row = paintedRow(this, shortId);
      // A local id until the server's own list of corrections arrives with the detail's next push.
      if (row && text.trim()) paintCorrection(this, row, { _id: `local-correction-${clientKey}`, step_key: stepKey, text: text.trim(), status: "pending", created_at: Date.now() });
      heldWhole(row);
    }) as PrioritiesSliceActions["correctPriority"],
    deletePriorityCorrection: asyncAction(function (this: PaintState, correctionId: string) {
      paintCorrectionDelete(this, correctionId);
    }) as PrioritiesSliceActions["deletePriorityCorrection"],
    runPriorities: asyncAction(function (this: PaintState, _workspace: string) {}) as PrioritiesSliceActions["runPriorities"],
  };
}

/** Every priority control: its acknowledgement settles the locks its paint planted (lib/dispatchBinding). */
export const PRIORITY_ACTIONS: ReadonlySet<string> = new Set(Object.keys(createPrioritiesSlice()));
