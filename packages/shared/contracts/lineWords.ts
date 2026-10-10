// What the line's engine leaves on a problem when a run stops, in the words a
// person reads (learning-loop.md LL6: plain words, never the engine's). The
// runner writes these (cli/src/workflow/runner.ts taskStopCard); the web reads
// comments written before they existed through lineCommentWords, so old and new
// say the same thing.
import { groundedNoteWords } from "./goalsBrief";

const stepWords = (id: string) => id.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** A station finished (or failed) and the graph had no route after it: "Prove finished, and the line had no next step for it. The problem is open again." */
export function deadEndWords(step: string, outcome?: string | null): string {
  return `${step} ${outcome && /^fail/i.test(outcome) ? "failed" : "finished"}, and the line had no next step for it. The problem is open again.`;
}

/** A run that failed for another reason: its reason, then where the problem is. */
export const runFailedWords = (reason: string): string => `The run stopped: ${reason.replace(/\.$/, "")}. The problem is open again.`;

/** A station that ran as many rounds as the line allows. */
export const roundsOutWords = (step: string): string => `${step} ran the most rounds this line allows. The problem waits in review, marked blocked.`;

/** A session that handed the problem back. */
export const handedBackWords = (step: string, handoff: string): string =>
  `${step} handed the problem back: ${handoff === "needs_context" ? "it needs more context" : "it is blocked"}. The problem waits in review.`;

/** The engine's failure reason read as a stop: a dead end by its station, else the reason as it is. */
export function failReasonWords(reason: string, label: (id: string) => string = stepWords): string {
  const m = /^no outgoing edge from (\S+)(?:.*?\boutcome (\w+))?/.exec(reason.trim());
  return m ? deadEndWords(label(m[1]), m[2]) : runFailedWords(reason);
}

/** A comment the line wrote before these words existed ("Workflow failed (no outgoing edge from prove ...); task returned to open.",
 *  "Grounded: goal X, code, risk plan, ready."), in today's words. Any other text comes back unchanged. */
export function lineCommentWords(text: string): string {
  const t = text.trim();
  let m = /^Workflow failed \((.+)\); task returned to open\.$/.exec(t);
  if (m) return failReasonWords(m[1]);
  m = /^Workflow stopped: retries exhausted \(.*?(?:on (\S+))?\); task left in review as blocked\.$/.exec(t);
  if (m) return roundsOutWords(m[1] ? stepWords(m[1]) : "A station");
  m = /^Workflow stopped: the hand handed off (\w+) \(.*\); task left in review\.$/.exec(t);
  if (m) return handedBackWords("The session", m[1]);
  return groundedNoteWords(text);
}
