import { decisionAnswerLabel } from "@codecast/shared/contracts";
import type { DecisionAnswerInput, DecisionParty, SessionDecisionItem } from "../../store/inboxStore";

type Row = Pick<SessionDecisionItem, "status" | "kind" | "options" | "answer_index" | "answer_text" | "answer_json" | "answered_by" | "resolved_at" | "answer_history">;

/** One answer a decision has had: what it said, who gave it, and when it stopped standing (null for the one on record). */
export type AnswerEntry = { label: string; by?: DecisionParty; at?: number; replacedAt: number | null; replacedBy?: string };

const labelOf = (row: Row, v: { status: string; answer_index?: number; answer_text?: string; answer_json?: unknown }) =>
  v.status === "dismissed" ? "Dismissed" : decisionAnswerLabel(row, v as any) ?? "No answer";

/** Every answer the decision has had, newest first: the one on record, then each it replaced. */
export function answerTimeline(row: Row): AnswerEntry[] {
  if (row.status !== "answered" && row.status !== "dismissed") return [];
  const current: AnswerEntry = { label: labelOf(row, row), by: row.answered_by, at: row.resolved_at, replacedAt: null };
  const earlier = (row.answer_history ?? []).map((h): AnswerEntry => ({ label: labelOf(row, h), by: h.answered_by, at: h.resolved_at, replacedAt: h.replaced_at, replacedBy: h.replaced_by }));
  return [current, ...earlier.reverse()];
}

/** The words a new answer would put on record, for the confirm step. */
export function inputLabel(row: Pick<SessionDecisionItem, "kind" | "options">, input: DecisionAnswerInput): string {
  if ("dismiss" in input) return "Dismissed";
  return decisionAnswerLabel(row, { answer_index: input.index, answer_text: input.text, answer_json: input.json }) ?? "No answer";
}

/** Whether a new answer says the same as the one on record. */
export function sameAnswer(row: Row, input: DecisionAnswerInput): boolean {
  return row.status === "answered" && !("dismiss" in input) && inputLabel(row, input) === labelOf(row, row);
}

/** Why a settled answer cannot change (answerChangeable said no), in a few words; null when nothing needs saying. */
export function answerLockedReason(row: Pick<SessionDecisionItem, "status" | "workflow_run_id" | "card" | "run" | "silent" | "trial" | "category" | "blocking">): string | null {
  if (row.status !== "answered" && row.status !== "dismissed") return null;
  if (row.workflow_run_id) return "Its flow already acted on this answer.";
  if (row.run) return "Its command already ran on this answer.";
  if (row.category === "access") return "An access answer. Change access in Vault.";
  if (row.card && row.blocking !== false) return "The change already went ahead on this answer.";
  return null;
}
