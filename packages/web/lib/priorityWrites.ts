// The person's priority controls as both apps press them: each runs its store
// action (store/prioritiesSlice), which paints at once and rides dispatch, and
// a refusal puts back the rows as they were before the press, through
// syncTable as the server still has them, and says why. Imported by the
// phone, so it reaches nothing DOM-only and imports by relative path.
import type { PriorityRow } from "@codecast/shared/contracts/priorities";
import { useInboxStore } from "../store/inboxStore";
import { isRefusedDispatchError } from "../store/mutativeMiddleware";
import { writeOrRestore, type PriorityWrites } from "./priorities";
import type { PriorityDetailRow } from "./priorityDetail";

type Snapshot = { priorities: PriorityRow[]; priorityDetails: PriorityDetailRow[] };

/** Every priority control, each reporting a refusal through `onError`. */
export function priorityWrites(onError: (message: string) => void): PriorityWrites {
  const st = () => useInboxStore.getState() as any;
  const run = (write: () => Promise<unknown>) => {
    const s = st();
    const before: Snapshot = structuredClone({ priorities: Object.values(s.priorities ?? {}), priorityDetails: Object.values(s.priorityDetails ?? {}) });
    void writeOrRestore(
      write,
      before,
      (prior) => {
        st().syncTable("priorities", prior.priorities, { isDelta: true });
        st().syncTable("priorityDetails", prior.priorityDetails, { isDelta: true });
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
    correct: (id, text, key) => run(() => st().correctPriority(id, text, key)),
    deleteCorrection: (cid) => run(() => st().deletePriorityCorrection(cid)),
  };
}
