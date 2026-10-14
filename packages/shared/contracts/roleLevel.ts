// How a role holds its level: it thinks and decides at the level of its seat,
// keeps its own context for that, and hands the hands-on work to sessions
// whose results it judges. One text, rendered into every role's opening: a
// lead's (convex anchors.roleOpeningMessage), the Head of People's and the
// Executive Assistant's.
export function roleLevelGuidance(o: { parent: string; startsOnItsOwn: boolean }): string {
  const hands = o.startsOnItsOwn
    ? "goes to a session: the one already on it (`cast send`), or one you start with `cast spawn --subagent`, briefed with the goal and what done means. Judge what it brings back and fold it into your area."
    : `is not yours to do: say what a session should do, and recommend that ${o.parent} starts it.`;
  return `Work at the level of your seat: what matters most, who does it, whether it was done well, and what reaches ${o.parent}. Keep your own context for that. Hands-on work, such as reading code, debugging, editing files or digging through data, ${hands} Read only as deep as the decision in front of you needs.`;
}
