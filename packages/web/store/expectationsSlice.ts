// A project's expectations, changed where they are read (line-map.md LX3,
// LX5; the-line-model.md LM5). Two writes, each painted on the project's
// projectExpectations row on the click and riding `dispatch` to the side
// effect of the same name (convex/dispatch.ts):
//
// - editExpectations: a person's own line, or a retirement with the reason.
//   It is a proposal cited as them (personOp), and it applies as they make it
//   exactly when personEditApplies says so; the server applies by the same
//   rule, so the paint and the echo agree. Otherwise it paints as an open
//   proposal.
// - resolveExpectationProposal: Apply or Drop on an open proposal. When the
//   proposal's card is in this viewer's queue, it is answered here on the
//   decision rail (the queue's own answer path), so both surfaces settle one
//   decision; the side effect then finds the proposal settled.
//
// The row is the server's view (expectations.forProject); its echo replaces
// the paint, and a refusal takes the paint back.
import { action } from "./mutativeMiddleware";
import {
  applyOps,
  expectationPrefix,
  personEditApplies,
  personOp,
  type Expectation,
  type ExpectationOp,
  type PersonEdit,
} from "@codecast/shared/contracts/expectations";
import type { ProjectExpectationsRow } from "../hooks/useSyncProjectExpectations";

/** The card answer the queue gives (inboxStore answerDecisionDraft), handed in so the slice answers on the same rail. */
type AnswerCard = (draft: any, decisionId: string, answer: { index: number }) => void;

export type ExpectationsSliceActions = {
  editExpectations: (projectId: string, edit: PersonEdit) => void;
  resolveExpectationProposal: (projectId: string, proposal: string, verdict: "apply" | "drop") => void;
};

/** The highest line number a document has used, for a paint that has no next_n yet. */
const nextN = (items: Expectation[]) => items.reduce((n, e) => Math.max(n, Number(/-(\d+)$/.exec(e.id)?.[1] ?? 0) + 1), 1);

/** A proposal's changes laid onto the row's document as the next version; false when they cannot apply to it. */
function applyToRow(row: ProjectExpectationsRow, ops: ExpectationOp[], baseVersion: number, now: number): boolean {
  const doc = row.doc;
  const version = (doc?.version ?? 0) + 1;
  const prefix = doc?.prefix ?? expectationPrefix(row.project?.title ?? "");
  const out = applyOps({ items: doc?.items ?? [], prefix, next_n: doc?.next_n ?? nextN(doc?.items ?? []) }, ops, version, baseVersion);
  if (!out.ok) return false;
  row.doc = { ...(doc ?? { project: row.project, prefix, how: "person", summary: "" }), version, prefix, next_n: out.next_n, items: out.items, applied_at: now } as ProjectExpectationsRow["doc"];
  row.current_version = version;
  return true;
}

/** Paint a person's edit on the row: applied when the rule says it applies, else an open proposal at the top. */
export function paintPersonEdit(row: ProjectExpectationsRow, edit: PersonEdit, me: string, now: number): void {
  const op = personOp(edit, me, now);
  const base = row.doc?.version ?? 0;
  if (personEditApplies(op, !!row.you_answer) && applyToRow(row, [op], base, now)) return;
  row.proposals = [{ short_id: "", status: "open", summary: edit.op === "add" ? edit.text : `Retire ${edit.id}: ${edit.reason}`, changes: 1, base_version: base, created_at: now, ops: [op] }, ...(row.proposals ?? [])];
}

/** Paint Apply or Drop on an open proposal; returns the proposal's card id when one was asked. */
export function paintResolve(row: ProjectExpectationsRow, shortId: string, verdict: "apply" | "drop", now: number): string | undefined {
  const p = row.proposals?.find((x) => x.short_id === shortId);
  if (!p || p.status !== "open") return undefined;
  if (verdict === "apply" && !applyToRow(row, p.ops ?? [], p.base_version, now)) return undefined;
  p.status = verdict === "apply" ? "applied" : "dropped";
  if (verdict === "apply") p.applied_version = row.current_version;
  return p.card_id;
}

export function createExpectationsSlice(answerCard: AnswerCard): ExpectationsSliceActions {
  return {
    editExpectations: action(function (this: any, projectId: string, edit: PersonEdit) {
      const row = this.projectExpectations?.[projectId] as ProjectExpectationsRow | undefined;
      const me = String(this.currentUser?._id ?? "");
      if (row && me) paintPersonEdit(row, edit, me, Date.now());
    }) as ExpectationsSliceActions["editExpectations"],
    resolveExpectationProposal: action(function (this: any, projectId: string, proposal: string, verdict: "apply" | "drop") {
      const row = this.projectExpectations?.[projectId] as ProjectExpectationsRow | undefined;
      const card = row ? paintResolve(row, proposal, verdict, Date.now()) : undefined;
      // Apply is the card's first option and Drop its second (EXPECTATION_CARD_OPTIONS).
      if (card && this.sessionDecisions?.[card]?.status === "pending") answerCard(this, card, { index: verdict === "apply" ? 0 : 1 });
    }) as ExpectationsSliceActions["resolveExpectationProposal"],
  };
}
