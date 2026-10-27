import { escapeTagAttr, stripInjectionNoise, unescapeTagAttr } from "./machineMessages";

// --- Decision answers (cast decide) ------------------------------------------------
// The human's answer to a `cast decide` question enters the session as a user
// message (store answerDecision). The first line is the answer the agent acts
// on; the trailing tag names the decision it answers and repeats the question,
// so the transcript explains itself and every surface can render the answer
// against its ask (the web bubble links back to the `cast decide` call and
// unfolds the options and context).
//
//   Decision: Keep vendored (current)
//   <cast-decision id="k97…" question="Keep the browser engine vendored?"/>
//
// The tag rides the same message as the text, so tmux injection collapsing
// the newline to a space must not matter: the parser never requires one.
export const DECISION_ANSWER_TAG_RE = /<cast-decision\s+id="([^"]*)"(?:\s+question="([^"]*)")?\s*\/>/;

export interface DecisionAnswerMessage {
  id: string;
  question?: string;
  // The chosen option's label, or the free text the human typed.
  answer: string;
}

// Among a conversation's answered decision rows, the one a legacy answer
// bubble (id unknown on the wire) most plausibly answered: the recorded
// answer — the chosen option's label, or the free text — matches, and the
// resolution time sits nearest the message. Shared by the server lookup
// (sessionDecisions.findByAnswer) and the web store scan so both resolve
// the same row.
export function pickAnsweredDecision<
  T extends { options: { label: string }[]; answer_index?: number; answer_text?: string; resolved_at?: number; created_at: number },
>(rows: T[], answer: string, near?: number): T | null {
  const recorded = (r: T) => (r.answer_index !== undefined ? r.options[r.answer_index]?.label : r.answer_text);
  const matches = rows.filter((r) => recorded(r) === answer);
  if (matches.length === 0) return null;
  if (near === undefined) return matches[matches.length - 1];
  const distance = (r: T) => Math.abs((r.resolved_at ?? r.created_at) - near);
  return matches.reduce((best, r) => (distance(r) < distance(best) ? r : best));
}

// The one line the asking agent acts on, per decision kind: single = the
// chosen label, multi = labels joined by ", ", rank = labels joined by " > ",
// form = "key=value; key=value". Shared by the server's finalizeAnswer and the
// web's optimistic answerDecision so the delivered message never differs by
// path. A typed free-text answer wins over any index.
export function decisionAnswerLabel(
  row: { kind?: string; options: { label: string }[] },
  verdict: { answer_index?: number; answer_text?: string; answer_json?: any },
): string | undefined {
  if (verdict.answer_text) return verdict.answer_text;
  const kind = row.kind ?? "single";
  const label = (i: number) => row.options[i]?.label ?? `option ${i + 1}`;
  if (kind === "single") return verdict.answer_index !== undefined ? label(verdict.answer_index) : undefined;
  if (kind === "multi" && Array.isArray(verdict.answer_json)) return verdict.answer_json.map(label).join(", ");
  if (kind === "rank" && Array.isArray(verdict.answer_json)) return verdict.answer_json.map(label).join(" > ");
  if (kind === "form" && verdict.answer_json && typeof verdict.answer_json === "object") {
    return Object.entries(verdict.answer_json)
      .map(([k, val]) => `${k}=${String(val)}`)
      .join("; ");
  }
  return verdict.answer_index !== undefined ? label(verdict.answer_index) : undefined;
}

// The client id the server's delivery of an answer carries (sessionDecisions
// deliverAnswer), and its reading: the hosted turn engine tells an answer from
// typed input by it, so both sides go through this pair.
const DECISION_ANSWER_CLIENT_PREFIX = "decision-answer:";

export function decisionAnswerClientId(decisionId: string): string {
  return `${DECISION_ANSWER_CLIENT_PREFIX}${decisionId}`;
}

export function decisionIdFromClientId(clientId: string | null | undefined): string | null {
  return clientId?.startsWith(DECISION_ANSWER_CLIENT_PREFIX) ? clientId.slice(DECISION_ANSWER_CLIENT_PREFIX.length) || null : null;
}

export function formatDecisionAnswer(a: { id: string; question: string; answer: string }): string {
  return `Decision: ${a.answer}\n<cast-decision id="${a.id}" question="${escapeTagAttr(a.question)}"/>`;
}

/** Whether a message is an answer that names its decision (the tagged
 *  form). A hosted conversation's turn consumes such a message and never
 *  writes it to the transcript (convex/assistant/input.ts decisionAnswerOf),
 *  so a client that painted it has no echo to wait for. The legacy untagged
 *  line does not count: a person may type exactly that. */
export function isTaggedDecisionAnswer(rawContent: string | null | undefined): boolean {
  return !!parseDecisionAnswer(rawContent)?.id;
}

export function parseDecisionAnswer(rawContent: string | null | undefined): DecisionAnswerMessage | null {
  if (!rawContent) return null;
  const text = stripInjectionNoise(rawContent);
  const match = text.match(DECISION_ANSWER_TAG_RE);
  if (!match) {
    // Answers sent before the tag shipped were the first line alone: the
    // message is exactly "Decision: <chosen label>". Those transcripts are
    // immutable, so recognize the shape here — id unknown, and single-line
    // only, so a typed message that merely opens with the word stays a
    // normal message. Surfaces resolve the row by conversation + label.
    const legacy = text.trim().match(/^Decision:[ \t]+(\S[^\n]*)$/);
    return legacy ? { id: "", answer: legacy[1].trim() } : null;
  }
  const answer = text.replace(DECISION_ANSWER_TAG_RE, "").trim().replace(/^Decision:\s*/, "");
  return {
    id: match[1],
    question: match[2] !== undefined ? unescapeTagAttr(match[2]) : undefined,
    answer,
  };
}

