// The person's priority controls as both apps press them: each runs its store
// action (store/prioritiesSlice), which paints at once and rides dispatch. A
// refusal takes back only the rows that press painted: the store's rows are
// immutable, so the rows changed are the ones whose reference the action
// replaced, and each goes back to the row held before the press unless
// something newer (a server push, another window) has replaced it since.
//
// Checking off a milestone or a priority takes it out of sight while Hide
// done is on, so each check-off records an undo: its receipt's Undo (sonner
// on web, the phone's undo bar, each the engine's notifier), and ⌘Z on web,
// put back exactly what the press replaced (priorities.undoStepDone and
// undoDone), so a milestone the pass held is the pass's again and a priority
// keeps its rank. A redo presses it again. The entry is hand-written because
// the server's echo stamps its own done_at, which the generic undo would read
// as a change made since.
//
// Imported by the phone, so it reaches nothing DOM-only and imports by
// relative path.
import { getUndoHistory, pushUndo, showUndoToast, type UndoOutcome } from "@platform/engine";
import { useInboxStore } from "../store/inboxStore";
import { isRefusedDispatchError } from "../store/mutativeMiddleware";
import { quoted } from "../store/undo/labels";
import { paintedRow, priorDoneOf, writeOrRestore, type PriorityWrites } from "./priorities";

const KEYS = ["priorities", "priorityDetails"] as const;
type Rows = Record<string, unknown>;
/** Per collection, each id the press painted: the row before it (undefined: it had none) and the row it painted (undefined: it removed it). */
type Painted = Record<(typeof KEYS)[number], Array<{ id: string; before: unknown; painted: unknown }>>;

function paintedBy(before: Record<string, Rows>, after: Record<string, Rows>): Painted {
  const out = {} as Painted;
  for (const key of KEYS) {
    const a = before[key] ?? {};
    const b = after[key] ?? {};
    out[key] = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((id) => a[id] !== b[id]).map((id) => ({ id, before: a[id], painted: b[id] }));
  }
  return out;
}

/** Presses a check-off and records its undo; the receipt is the new entry's own, with its Undo. */
function doneUndoable(label: string, isDone: () => boolean, press: () => void, undo: () => void): void {
  // A check-off the server refused is open again already: nothing to take back.
  const step = (want: boolean, write: () => void): UndoOutcome => {
    if (isDone() !== want) return { ok: false, reason: "already" };
    write();
    return { ok: true, applied: 1, skipped: 0 };
  };
  press();
  const id = pushUndo({ label, undo: () => step(true, undo), redo: () => step(false, press) });
  // Inside an undo group the entry is the group's, which raises its own receipt.
  if (getUndoHistory().head === id) showUndoToast(label);
}

/** Every priority control, each reporting a refusal through `onError`; a check-off also records its undo. */
export function priorityWrites(onError: (message: string) => void): PriorityWrites {
  const st = () => useInboxStore.getState() as any;
  const held = () => Object.fromEntries(KEYS.map((k) => [k, st()[k] ?? {}])) as Record<string, Rows>;
  const run = (write: () => Promise<unknown>) => {
    const before = held();
    const pending = write();
    const painted = paintedBy(before, held());
    void writeOrRestore(
      () => pending,
      painted,
      (rows) => {
        const now = held();
        for (const key of KEYS) {
          // A row replaced since the paint is newer than both: it stays.
          const ours = rows[key].filter((r) => now[key][r.id] === r.painted);
          const back = ours.filter((r) => r.before !== undefined).map((r) => r.before);
          const gone = ours.filter((r) => r.before === undefined).map((r) => r.id);
          if (back.length) st().syncTable(key, back, { isDelta: true });
          if (gone.length) st().dropRows(key, gone);
        }
      },
      onError,
      isRefusedDispatchError,
    );
  };
  const row = (id: string) => paintedRow(st(), id);
  const stepDone = (id: string, key: string, done: boolean) => run(() => st().setPriorityStepDone(id, key, done));
  const undoStepDone = (id: string, key: string, setBy: "pass" | "person" | null) => run(() => st().undoPriorityStepDone(id, key, setBy));
  const markDone = (id: string) => run(() => st().markPriorityDone(id));
  const undoDone: PriorityWrites["undoDone"] = (id, prior) => run(() => st().undoPriorityDone(id, prior));
  return {
    move: (id, to) => run(() => st().movePriority(id, to)),
    setStepTier: (id, key, tier) => run(() => st().setPriorityStepTier(id, key, tier)),
    setAside: (id) => run(() => st().setPriorityAside(id)),
    restore: (id) => run(() => st().restorePriority(id)),
    setStepDone: (id, key, done) => {
      const step = done ? row(id)?.steps.find((s) => s.key === key) : undefined;
      if (!step || step.done) return stepDone(id, key, done);
      const setBy = step.done_set_by === "pass" || step.done_set_by === "person" ? step.done_set_by : null;
      doneUndoable(
        `Marked ${quoted(step.title, "milestone")} done`,
        () => !!row(id)?.steps.find((s) => s.key === key)?.done,
        () => stepDone(id, key, true),
        () => undoStepDone(id, key, setBy),
      );
    },
    renameStep: (id, key, title) => run(() => st().renamePriorityStep(id, key, title)),
    dropStep: (id, key) => run(() => st().dropPriorityStep(id, key)),
    markDone: (id) => {
      const before = row(id);
      const prior = before ? priorDoneOf(before) : null;
      if (!before || !prior) return markDone(id);
      doneUndoable(`Marked ${quoted(before.title, "priority")} done`, () => row(id)?.status === "done", () => markDone(id), () => undoDone(id, prior));
    },
    undoStepDone,
    undoDone,
    merge: (id, into) => run(() => st().mergePriority(id, into)),
    moveSession: (session, from, to, key) => run(() => st().movePrioritySession(session, from, to, key)),
    sessionNotThis: (session, from) => run(() => st().prioritySessionNotThis(session, from)),
    correct: (id, text, key) => run(() => st().correctPriority(id, text, key, crypto.randomUUID())),
    deleteCorrection: (cid) => run(() => st().deletePriorityCorrection(cid)),
  };
}
