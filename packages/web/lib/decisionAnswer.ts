import type { DecisionAnswerInput, SessionDecisionItem } from "../store/inboxStore";

// A decision's answer in progress (decisions-as-documents.md D1 / D4), as kept
// in the store's `drafts` by useDecisionDraft, and the rules that turn it into
// the DecisionAnswerInput answerDecision takes. Platform free: web's
// DecisionAnswerControls and the mobile decision screen both answer through
// these, so a multi, rank or form validates and sends the same everywhere.
export type AnswerDraft = { picked: number[]; order: number[]; values: Record<string, any>; otherText: string; otherOpen: boolean };

export type AnswerView = { picked: number[]; order: number[]; values: Record<string, any> };

/** The fixed words on the answer controls, the same on the web and the phone. */
export const ANSWER_WORDS = {
  send: "Send this answer",
  proceeding: "Proceeding with this",
  openPage: "Open its page",
  yes: "Yes",
  no: "No",
} as const;

type DecisionShape = Pick<SessionDecisionItem, "options" | "form" | "kind">;

/** The draft read against the decision as it stands now: an edited decision
 *  (cast decide edit) can drop options under a draft, and a form field the
 *  reader has not touched reads as its type's empty value. */
export function answerView(decision: DecisionShape, draft: Partial<AnswerDraft>): AnswerView {
  const optionCount = decision.options.length;
  const picked = (draft.picked ?? []).filter((n) => n < optionCount);
  const order = draft.order?.length === optionCount ? draft.order : decision.options.map((_, i) => i);
  const values: Record<string, any> = {};
  for (const f of decision.form?.fields ?? []) {
    values[f.key] = draft.values?.[f.key] ?? (f.type === "bool" ? false : f.type === "select" ? (f.options?.[0] ?? "") : "");
  }
  return { picked, order, values };
}

/** Tick or untick option n on a multi. */
export function togglePicked(cur: Partial<AnswerDraft>, n: number): Partial<AnswerDraft> {
  const p = cur.picked ?? [];
  return { picked: p.includes(n) ? p.filter((x) => x !== n) : [...p, n] };
}

/** The rank order with the row at `from` moved one step; null at an edge. */
export function moveInOrder(order: number[], from: number, dir: -1 | 1): number[] | null {
  const to = from + dir;
  if (to < 0 || to >= order.length) return null;
  const next = [...order];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

/** The submit of a multi, rank or form: the answer, or why it cannot go yet. */
export function buildDecisionAnswer(
  decision: DecisionShape,
  view: AnswerView,
): { input: DecisionAnswerInput } | { error: string } | null {
  const kind = decision.kind ?? "single";
  if (kind === "multi") {
    if (view.picked.length === 0) return { error: "Pick at least one option." };
    return { input: { json: [...view.picked].sort((a, b) => a - b) } };
  }
  if (kind === "rank") return { input: { json: view.order } };
  if (kind === "form") {
    const fields = decision.form?.fields ?? [];
    for (const f of fields) {
      const v = view.values[f.key];
      if (f.type !== "bool" && (v === "" || v === undefined)) return { error: `${f.label} is required.` };
      if (f.type === "number" && Number.isNaN(Number(v))) return { error: `${f.label} must be a number.` };
    }
    const out: Record<string, any> = {};
    for (const f of fields) out[f.key] = f.type === "number" ? Number(view.values[f.key]) : view.values[f.key];
    return { input: { json: out } };
  }
  return null;
}
