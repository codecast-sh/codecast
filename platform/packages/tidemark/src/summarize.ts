import type { Scope } from './scope';

/**
 * What one summary call returns: the text, or the text and whether the model
 * stopped at its output limit. A truncated summary is a failed call: nothing
 * is written, the stretch waits for a later pass, and the host's breaker
 * should count it like any other failure. Stored, it would stand in for its
 * stretch for good while missing its end.
 */
export type SummaryResult = string | { text: string; truncated?: boolean };

/** Writes the summaries. The host brings the model; the runtime brings the discipline. */
export interface Summarizer {
  /** Raw lines, oldest first, already stamped `[YYYY-MM-DD HH:MM] kind: summary`. */
  leaf(input: { scope: Scope; lines: string[] }): Promise<SummaryResult>;
  /** Two consecutive summaries into one for the whole stretch. */
  merge(input: { scope: Scope; earlier: { range: string; content: string }; later: { range: string; content: string } }): Promise<SummaryResult>;
}

/** The text of a summary fit to store; throws when it is empty or was cut off at the model's output limit. */
export function summaryText(result: SummaryResult, what: 'leaf' | 'merge'): string {
  const { text, truncated } = typeof result === 'string' ? { text: result, truncated: false } : result;
  if (truncated) throw new Error(`the ${what} summary stopped at the model's output limit`);
  if (typeof text !== 'string' || !text.trim()) throw new Error(`summarizer returned an empty ${what}`);
  return text;
}

// Summaries become standing context for every later run, so both prompts
// carry the same rule: an invented specific here gets repeated to a person
// later, as fact.
export const LEAF_PROMPT = `You are summarizing a sequence of logged activities for an agent that will read this later as its history.
Write a brief narrative paragraph (2-4 sentences) that captures the key events, decisions, and outcomes.
Focus on what happened and why it matters for future context. Use past tense.
Do NOT use bullet points. Write prose.
State only what the activity lines say. Never add a name, number, commitment, or outcome the lines do not contain: this summary becomes standing context for future runs, and an invented specific here gets repeated to a person later.

Activities to summarize:`;

export const MERGE_PROMPT = `You are compressing two consecutive summaries of the same history, an earlier stretch and the later one that follows it, into one summary of the whole stretch for an agent that will read this later.
Write one brief narrative paragraph (2-4 sentences) in past tense prose, no bullet points.
Keep what has lasting effect: who the people are, what they want, what was agreed, promised, declined, or decided, and how things stood at the end. Drop what does not.
State only what the two summaries say. Never add a name, number, commitment, or outcome they do not contain: this summary becomes standing context for future runs, and an invented specific here gets repeated to a person later.

Summaries to compress:`;

/** A Summarizer over any `(system, user) => text` model call; a call that knows its stop reason returns `{ text, truncated }`. */
export function promptSummarizer(call: (system: string, user: string) => Promise<SummaryResult>, prompts: { leaf?: string; merge?: string } = {}): Summarizer {
  return {
    leaf: ({ lines }) => call(prompts.leaf ?? LEAF_PROMPT, lines.join('\n')),
    merge: ({ earlier, later }) => call(prompts.merge ?? MERGE_PROMPT, `[Earlier: ${earlier.range}]\n${earlier.content}\n\n[Later: ${later.range}]\n${later.content}`),
  };
}
