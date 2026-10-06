// The condensed transcript's receipt for a hosted conversation's tool
// activity, in the plain words the assistant's own steps use
// (@platform/assistant/steps): "Read 12 emails from the past week · Drafted
// a reply to Dana" rather than a developer's count of tool names. A busy
// segment says its first steps and how many more there are; open, the
// header just counts them, since the steps themselves sit below it.
import { stepCount, stepText, visibleSteps, type ToolCallLike, type ToolResultLike } from "@platform/assistant/steps";

/** How many steps a closed receipt names before "N more steps". */
export const RECEIPT_STEPS = 3;

export function hostedReceipt<C extends ToolCallLike>(
  calls: C[],
  resultFor: (call: C) => ToolResultLike | undefined,
): { summary: string; counted: string; created: string[] } {
  const lines = calls.map((call) => stepText(call, resultFor(call)));
  const { shown, more } = visibleSteps(lines, false, RECEIPT_STEPS);
  return {
    summary: (more ? [...shown, stepCount(more, true)] : shown).join(" · "),
    counted: stepCount(lines.length),
    created: createdRefs(calls, resultFor),
  };
}

/** The short ids of the to-dos a hosted turn's steps added, read from each
 *  step's result (the tool answers with the new row's id). The receipt links
 *  each as a live pill, so the task opens from the conversation whichever
 *  workspace the person has open: the assistant writes to their own. */
export function createdRefs<C extends ToolCallLike>(calls: C[], resultFor: (call: C) => ToolResultLike | undefined): string[] {
  const refs = new Set<string>();
  for (const call of calls) {
    if (!/(create|add).*(task|todo|to_do)/i.test(call.name ?? "")) continue;
    const content = resultFor(call)?.content;
    const text = typeof content === "string" ? content : JSON.stringify(content ?? "");
    const ref = text.match(/\bct-\d+\b/)?.[0];
    if (ref) refs.add(ref);
  }
  return [...refs];
}
