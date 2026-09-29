import { escalationFirstLine } from "@codecast/shared/contracts";

// How a role's escalation line reads on a card that has room for a heading
// (the decision sheet, the queue's card). A short first line followed by
// more text is the heading, and the rest is the body. A line that is one
// long paragraph, or one line only, is body: a paragraph set as a title is
// worse than no title.
export const ESCALATION_HEAD_MAX = 120;

export function splitEscalationLine(line: string): { head: string | null; body: string } {
  const first = escalationFirstLine(line);
  const rest = line.trim().slice(line.trim().indexOf(first) + first.length).trim();
  if (rest && first.length <= ESCALATION_HEAD_MAX) return { head: first, body: rest };
  return { head: null, body: line.trim() };
}
