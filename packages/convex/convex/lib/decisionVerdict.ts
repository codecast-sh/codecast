// The verdict an answer settles a decision at, and the pure helpers around it:
// reading it off a resolved row, the one-line label the asking agent acts on,
// and validating a raw answer against the row's kind. Split out of
// sessionDecisions.ts so the queue's mutations and the run gates share them.
import { decisionAnswerLabel } from "@codecast/shared/contracts";
import type { Doc } from "../_generated/dataModel";

type DecisionKind = "single" | "multi" | "rank" | "form";
type DecisionRow = Doc<"session_decisions">;

export type Verdict = {
  // withdrawn: the asker took the question back (withdrawCore); it settles
  // like a dismissal so the ladder learns the fact, and never scores a grant.
  status: "answered" | "dismissed" | "withdrawn";
  answer_index?: number;
  answer_text?: string;
  answer_json?: any;
};

/** The verdict a resolved row stands at, or null while it is pending. */
export function verdictOfRow(row: DecisionRow): Verdict | null {
  if (row.status === "answered") return { status: "answered", answer_index: row.answer_index, answer_text: row.answer_text, answer_json: row.answer_json };
  return row.status === "pending" ? null : { status: row.status };
}

// The one line the asking agent acts on, per kind.
export function answerLabel(row: { kind?: string; options: { label: string }[] }, verdict: Verdict): string | undefined {
  if (verdict.status !== "answered") return undefined;
  return decisionAnswerLabel(row, verdict);
}

// Validate an answer against the row's kind. Returns the normalized verdict.
export function normalizeVerdict(row: DecisionRow, raw: Verdict): Verdict | { error: string } {
  if (raw.status === "dismissed") return { status: "dismissed" };
  const kind: DecisionKind = (row.kind ?? "single") as DecisionKind;
  const n = row.options.length;
  const inRange = (i: any) => Number.isInteger(i) && i >= 0 && i < n;
  if (kind === "single") {
    if (raw.answer_index === undefined && !raw.answer_text) return { error: "answer_index or answer_text required" };
    if (raw.answer_index !== undefined && !inRange(raw.answer_index)) return { error: "answer_index out of range" };
    return { status: "answered", answer_index: raw.answer_index, answer_text: raw.answer_text };
  }
  if (kind === "multi" || kind === "rank") {
    const list = Array.isArray(raw.answer_json) ? raw.answer_json : raw.answer_index !== undefined ? [raw.answer_index] : null;
    if (!list || list.length === 0) return { error: `${kind} answer needs a list of option indexes` };
    if (!list.every(inRange)) return { error: "an option index is out of range" };
    if (new Set(list).size !== list.length) return { error: "an option index repeats" };
    return { status: "answered", answer_json: list, answer_index: list[0], answer_text: raw.answer_text };
  }
  // form
  const values = raw.answer_json;
  if (!values || typeof values !== "object" || Array.isArray(values)) return { error: "form answer needs key=value pairs" };
  const fields = row.form?.fields ?? [];
  for (const f of fields) {
    if (!(f.key in values)) return { error: `form field missing: ${f.key}` };
    const val = values[f.key];
    // Each value must match the field's declared type: the CLI coerces by
    // that type, and the web sends typed inputs; anything else is refused.
    if (f.type === "number" && !(typeof val === "number" && Number.isFinite(val))) return { error: `form field ${f.key} must be a number` };
    if (f.type === "bool" && typeof val !== "boolean") return { error: `form field ${f.key} must be true or false` };
    if (f.type === "text" && typeof val !== "string") return { error: `form field ${f.key} must be text` };
    if (f.type === "select" && (typeof val !== "string" || (f.options && !f.options.includes(val)))) {
      return { error: `form field ${f.key} must be one of: ${(f.options ?? []).join(", ")}` };
    }
  }
  return { status: "answered", answer_json: values, answer_text: raw.answer_text };
}
