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
): { summary: string; counted: string } {
  const lines = calls.map((call) => stepText(call, resultFor(call)));
  const { shown, more } = visibleSteps(lines, false, RECEIPT_STEPS);
  return {
    summary: (more ? [...shown, stepCount(more, true)] : shown).join(" · "),
    counted: stepCount(lines.length),
  };
}
