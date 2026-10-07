// The condensed transcript's receipt for a hosted conversation's tool
// activity, in the plain words the assistant's own steps use
// (@platform/assistant/steps): "Read 12 emails from the past week · Drafted
// a reply to Dana" rather than a developer's count of tool names. A busy
// segment says its first steps and how many more there are; open, the
// header just counts them, since the steps themselves sit below it.
import { stepCount, stepText, visibleSteps, type ToolCallLike, type ToolResultLike } from "@platform/assistant/steps";

/** How many steps a closed receipt names before "N more steps". */
export const RECEIPT_STEPS = 3;

/** `asking`: the conversation is parked on the person's approval, so a call
 *  with no result yet waits on them rather than running (stepText).
 *  `cardShown`: the approval's card is drawn under the receipt, so a step
 *  still waiting on it is the card's to say and the receipt leaves it out. */
export function hostedReceipt<C extends ToolCallLike>(
  calls: C[],
  resultFor: (call: C) => ToolResultLike | undefined,
  opts: { asking?: boolean; cardShown?: boolean } = {},
): { summary: string; counted: string; created: string[]; steps: number } {
  const said = opts.asking && opts.cardShown ? calls.filter((call) => resultFor(call) !== undefined) : calls;
  const lines = said.map((call) => stepText(call, resultFor(call), { asking: opts.asking }));
  const { shown, more } = visibleSteps(lines, false, RECEIPT_STEPS);
  return {
    summary: (more ? [...shown, stepCount(more, true)] : shown).join(" · "),
    counted: stepCount(lines.length),
    created: createdRefs(calls, resultFor),
    steps: lines.length,
  };
}

/** What a step that made or changed something names, read from its result
 *  (the tool answers with the row's id): a to-do it added (`ct-N`), a routine
 *  it set (`tr-N`), a note it wrote or rewrote (`doc:<id>`). The receipt links each as a live pill
 *  carrying the object's title, so it opens from the conversation whichever
 *  workspace the person has open: the assistant writes to their own. */
const MADE: { tool: RegExp; ref: (text: string) => string | undefined }[] = [
  { tool: /(create|add).*(task|todo|to_do)/i, ref: (text) => text.match(/\bct-\d+\b/)?.[0] },
  { tool: /schedule.*routine/i, ref: (text) => text.match(/\btr-\d+\b/)?.[0] },
  { tool: /(write|replace).*doc/i, ref: (text) => {
    const id = text.match(/\bdoc ([a-z0-9]{32})\b/)?.[1];
    return id ? `doc:${id}` : undefined;
  } },
];

export function createdRefs<C extends ToolCallLike>(calls: C[], resultFor: (call: C) => ToolResultLike | undefined): string[] {
  const refs = new Set<string>();
  for (const call of calls) {
    const made = MADE.find((m) => m.tool.test(call.name ?? ""));
    if (!made) continue;
    const content = resultFor(call)?.content;
    const ref = made.ref(typeof content === "string" ? content : JSON.stringify(content ?? ""));
    if (ref) refs.add(ref);
  }
  return [...refs];
}
