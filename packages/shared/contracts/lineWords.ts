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

/** A station whose session ran past its time and was stopped: "Dissolve ran out of time after 30 minutes and was stopped. The problem is open again." */
export const timedOutWords = (step: string, minutes: string): string =>
  `${step} ran out of time after ${minutes} minutes and was stopped. The problem is open again.`;

/** The engine's failure reason read as a stop: a dead end or a timeout by its station, else the reason as it is. */
export function failReasonWords(reason: string, label: (id: string) => string = stepWords): string {
  const r = reason.trim();
  const m = /^no outgoing edge from (\S+)(?:.*?\boutcome (\w+))?/.exec(r);
  if (m) return deadEndWords(label(m[1]), m[2]);
  // The runner's kill note names the session ("hand jx79c63 killed after 30m at dissolve"); a person reads the step and the time.
  const t = /^hand \S+ killed after (\d+)\s*m(?:in)?(?: at (\S+))?/.exec(r);
  if (t) return timedOutWords(t[2] ? label(t[2]) : "The session", t[1]);
  return runFailedWords(reason);
}

/** A comment the line wrote before these words existed ("Workflow failed (no outgoing edge from prove ...); task returned to open.",
 *  "Grounded: goal X, code, risk plan, ready."), in today's words. Any other text comes back unchanged. */
export function lineCommentWords(text: string): string {
  // The summary is the comment's first paragraph; what follows (the station's own words, its session) stays as written.
  const cut = text.search(/\n\s*\n/);
  if (cut > 0) {
    const head = lineCommentWords(text.slice(0, cut));
    return head === text.slice(0, cut) ? text : `${head}${text.slice(cut)}`;
  }
  const t = text.trim();
  let m = /^Workflow failed \((.+)\); task returned to open\.$/.exec(t);
  if (m) return failReasonWords(m[1]);
  m = /^The run stopped: (.+)\. The problem is open again\.$/.exec(t);
  if (m) return failReasonWords(m[1]);
  m = /^Workflow stopped: retries exhausted \(.*?(?:on (\S+))?\); task left in review as blocked\.$/.exec(t);
  if (m) return roundsOutWords(m[1] ? stepWords(m[1]) : "A station");
  m = /^Workflow stopped: the hand handed off (\w+) \(.*\); task left in review\.$/.exec(t);
  if (m) return handedBackWords("The session", m[1]);
  return groundedNoteWords(text);
}
