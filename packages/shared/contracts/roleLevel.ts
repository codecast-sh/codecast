// How a role holds its level: it thinks and decides at the level of its seat,
// keeps its own context for that, and hands the hands-on work to sessions
// whose results it judges. One text, rendered into every role's opening
// through convex anchors.standingRoleWays: a lead's, the Head of People's and
// the Executive Assistant's.
export function roleLevelGuidance(o: { parent: string; startsOnItsOwn: boolean }): string {
  const hands = o.startsOnItsOwn
    ? "Hands-on work (reading code, debugging, editing, digging through data) goes to a session: one at work, told with `cast send`, or a worker you start with `cast spawn --subagent -- -`, briefed in full on stdin. It wakes you whenever it stops; read it with `cast read <id>`, steer it with `cast send <id>`, and fold in its result."
    : `You do not start work on your own, so hands-on work, such as reading code, debugging, editing files or digging through data, is not yours to do: say what a session should do, and recommend that ${o.parent} starts it.`;
  return `Work at the level of your seat: what matters most, who does it, whether it was done well, and what reaches ${o.parent}. Keep your own context for that. ${hands} Read only as deep as the decision in front of you needs.`;
}
