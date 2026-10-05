// One edit of a goal's intent record
// (docs/architecture/initiatives-projects-role-page.md I5) on the client. The
// rules are the contract's one reducer (applyRecordOp), the same one
// `initiatives.record` runs on the server, so the entry the store paints is
// the entry the server stores. This file holds only what the store adds: the
// op the side effect is handed, and the ops an undo sends. Pure and import
// free of the store, so the slice and the undo writer both read it.
import { applyRecordOp, recordKeyOf, sameRecordEntry, type InitiativeRecordList, type InitiativeRecordOp } from "@codecast/shared/contracts/initiative";

export type { InitiativeRecordOp };

/**
 * One op applied to one list: the list as it then stands and the op to send,
 * carrying the whole entry it wrote (its key, who and when). Null when the op
 * moves nothing or cannot be applied; the server, handed the caller's own op,
 * refuses it in words.
 */
export function settleRecordOp(prior: readonly any[], op: InitiativeRecordOp, who: { by?: string; now: number }): { next: any[]; op: InitiativeRecordOp } | null {
  const out = applyRecordOp(prior, op, who);
  return "error" in out || !out.moved ? null : { next: out.next, op: out.op };
}

/**
 * The ops that take a list from how it stands to how it was: an entry that
 * was not there is removed, one that is gone is added back whole at the place
 * it sat, and one that changed is edited to its prior fields (null for each
 * it did not have).
 */
export function recordOpsBetween(list: InitiativeRecordList, current: readonly any[] | undefined, prior: readonly any[] | undefined): InitiativeRecordOp[] {
  const now = current ?? [];
  const was = prior ?? [];
  const keyOf = (e: any) => recordKeyOf(list, e);
  const wasByKey = new Map(was.map((e) => [keyOf(e), e]));
  const nowByKey = new Map(now.map((e) => [keyOf(e), e]));
  const ops: InitiativeRecordOp[] = [];
  for (const e of now) if (!wasByKey.has(keyOf(e))) ops.push({ list, action: "remove", key: keyOf(e) });
  was.forEach((e, index) => {
    const cur = nowByKey.get(keyOf(e));
    // Put back as it was: an entry nobody signed is not signed by whoever undoes.
    if (!cur) ops.push({ list, action: "add", entry: list === "questions" || list === "decisions" ? { ...e, by: e.by ?? null } : e, index });
    else if (!sameRecordEntry(cur, e)) ops.push({ list, action: "edit", key: keyOf(e), entry: { ...Object.fromEntries(Object.keys(cur).filter((k) => !(k in e)).map((k) => [k, null])), ...e } });
  });
  return ops;
}
