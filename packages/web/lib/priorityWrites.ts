// The person's priority controls as both apps press them: each runs its store
// action (store/prioritiesSlice), which paints at once and rides dispatch. A
// refusal takes back only the rows that press painted: the store's rows are
// immutable, so the rows changed are the ones whose reference the action
// replaced, and each goes back to the row held before the press unless
// something newer (a server push, another window) has replaced it since.
// Imported by the phone, so it reaches nothing DOM-only and imports by
// relative path.
import { useInboxStore } from "../store/inboxStore";
import { isRefusedDispatchError } from "../store/mutativeMiddleware";
import { writeOrRestore, type PriorityWrites } from "./priorities";

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

/** Every priority control, each reporting a refusal through `onError`. */
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
  return {
    move: (id, to) => run(() => st().movePriority(id, to)),
    setStepTier: (id, key, tier) => run(() => st().setPriorityStepTier(id, key, tier)),
    setAside: (id) => run(() => st().setPriorityAside(id)),
    restore: (id) => run(() => st().restorePriority(id)),
    setStepDone: (id, key, done) => run(() => st().setPriorityStepDone(id, key, done)),
    renameStep: (id, key, title) => run(() => st().renamePriorityStep(id, key, title)),
    dropStep: (id, key) => run(() => st().dropPriorityStep(id, key)),
    markDone: (id) => run(() => st().markPriorityDone(id)),
    merge: (id, into) => run(() => st().mergePriority(id, into)),
    moveSession: (session, from, to, key) => run(() => st().movePrioritySession(session, from, to, key)),
    sessionNotThis: (session, from) => run(() => st().prioritySessionNotThis(session, from)),
    correct: (id, text, key) => run(() => st().correctPriority(id, text, key, crypto.randomUUID())),
    deleteCorrection: (cid) => run(() => st().deletePriorityCorrection(cid)),
  };
}
