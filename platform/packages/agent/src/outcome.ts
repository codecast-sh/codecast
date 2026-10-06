// The words a run answers with when a call did not run, and the one reader
// that tells them apart. Each text is the model's tool result, so it is
// prompt text and will be reworded; a host that shows people what happened
// (a receipt, a step line) classifies results through `toolResultOutcome`,
// which is built from these same builders, so rewording one keeps the reader
// right. Pure and dependency free: web and phone bundles load it alone.

/** A call the person's own rule refused. */
export function refusalText(name: string): string {
  return `The person has not allowed ${name}. It did not run. Do not try it again; tell them what you would have done.`;
}

/** The result a declined call answers with. Exported so a host that settles a
 *  declined call outside a run writes the same words the run would. */
export function declineText(name: string, note?: string): string {
  return note
    ? `The person declined ${name}. It did not run. They said: ${note}`
    : `The person declined ${name}. It did not run.`;
}

/** A call an earlier run started but never reported back from. */
export function startedText(name: string): string {
  return `${name} started in an earlier run that stopped before it reported back, so it may or may not have happened. It was not run again. Check whether it took effect before trying it again.`;
}

/** What the model gets for a call the run did not start because it was cancelled or passed its deadline. */
export function stoppedText(name: string): string {
  return `${name} did not run: the run stopped before it could.`;
}

/** A call whose start could not be recorded, so it was never started. */
export function unrecordedText(name: string, reason: string): string {
  return `${name} did not run: its start could not be recorded (${reason}).`;
}

/** A call to a tool the run no longer offers. */
export function unavailableText(name: string): string {
  return `${name} is no longer available, so it did not run.`;
}

/** A host's own answer for a call it settles without running (a parked call
 *  the person's plan can no longer pay for, say). `why` finishes the
 *  sentence "It did not run: ...". */
export function notRunText(why: string): string {
  return `It did not run: ${why}.`;
}

export const WAITING_TEXT = "Waiting for the person's approval.";
export const CUT_OFF_TEXT = "This call was cut off before its arguments were complete, so it did not run.";

/** How a refused or unstarted call came out: `declined` when the person said
 *  no (to this call, or through a rule they set), `not_run` when it never ran
 *  for any other reason. */
export type ToolResultOutcome = "declined" | "not_run";

const NAME = "\u0000";

/** A builder's text as a pattern from its start: wherever the builder put
 *  the stand-in (the call's name, a note, a reason) anything matches, and
 *  every other word must match exactly. */
function shapeOf(build: (name: string) => string): RegExp {
  const parts = build(NAME).split(NAME).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${parts.join("[\\s\\S]+?")}`);
}

const SHAPES: Array<[RegExp, ToolResultOutcome]> = [
  [shapeOf((n) => declineText(n, n)), "declined"],
  [shapeOf((n) => declineText(n)), "declined"],
  [shapeOf(refusalText), "declined"],
  [shapeOf(startedText), "not_run"],
  [shapeOf(stoppedText), "not_run"],
  [shapeOf((n) => unrecordedText(n, n)), "not_run"],
  [shapeOf(unavailableText), "not_run"],
  [shapeOf(() => CUT_OFF_TEXT), "not_run"],
  [shapeOf(notRunText), "not_run"],
];

/** Which of the texts above a call's result is, or null for anything else
 *  (a real result, or the tool's own error). A gate's own refusal reason is
 *  free text and reads as null. */
export function toolResultOutcome(text: string): ToolResultOutcome | null {
  const t = text.trim();
  return SHAPES.find(([shape]) => shape.test(t))?.[1] ?? null;
}
