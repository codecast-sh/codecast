import { stripInjectionNoise, unescapeTagAttr } from "./machineMessages";

// Every move of a session between the role that looked after it and the
// person was written into BOTH threads as one machine message (through the
// ordinary pending message rail, so it synced like any message), and each
// thread renders it as
// an inline divider, never a bubble: the role's face, what moved where, the
// whole line as markdown, the time. LEGACY: the verb that wrote it (`cast
// escalate`) is gone (org-staffing.md S28); threads written before that still
// carry the tag, so only the reader and the caption remain. One tag, three
// moves:
//
//   handed   the role put the session in front of the person through its own
//            card (the default); the child stays nested under the role
//   direct   the child itself became a card in the person's needs input
//   back     the session is the role's again (hand back, --clear)
//
//   <session-escalation move="handed" by="role" role="or-8" handle="calling"
//     name="Calling" avatar="fox" session="jx7abcd" title="Market growth mandate"
//     to="Ashot" at="1790000000000">
//   the line, markdown, as long as the role wrote it
//   </session-escalation>
//
// Attribute order is fixed by the formatter; the parser reads by name, so a
// reader that predates an attribute ignores it. Keys off the opening tag only
// (a 200-char preview can drop the close tag).
export type SessionEscalationMove = "handed" | "direct" | "back";

export interface SessionEscalationMessage {
  move: SessionEscalationMove;
  /** Who moved it: the role from its own session, or the person's gesture. */
  by: "role" | "person";
  /** On a `back` move: the session did not go back under the role, it left
   *  it (its visibility changed and a team role may no longer hold it). */
  left?: boolean;
  role: { short_id: string; handle: string; name: string; avatar?: string };
  session: { short_id: string; title?: string };
  /** The person it moved to (or back from), by display name. */
  to: string;
  at: number;
  /** The reason, markdown. Empty on a hand back with no line. */
  line: string;
}

export function parseSessionEscalation(rawContent: string | null | undefined): SessionEscalationMessage | null {
  if (!rawContent) return null;
  const text = stripInjectionNoise(rawContent);
  // The head alone still parses: a preview slice can tear the tag before its
  // close, and the strip only needs the move and the role.
  const m = text.match(/^<session-escalation\s+([^>]*)(?:>([\s\S]*?)(?:<\/session-escalation>\s*$|$)|$)/);
  if (!m) return null;
  const attr = (k: string) => { const a = m[1].match(new RegExp(`(?:^|\\s)${k}="([^"]*)"`)); return a ? unescapeTagAttr(a[1]) : ""; };
  const move = attr("move");
  if (move !== "handed" && move !== "direct" && move !== "back") return null;
  const avatar = attr("avatar");
  const title = attr("title");
  return {
    move,
    by: attr("by") === "person" ? "person" : "role",
    ...(attr("left") === "1" ? { left: true } : {}),
    role: { short_id: attr("role"), handle: attr("handle"), name: attr("name") || attr("handle"), ...(avatar ? { avatar } : {}) },
    session: { short_id: attr("session"), ...(title ? { title } : {}) },
    to: attr("to"),
    at: Number(attr("at")) || 0,
    line: (m[2] ?? "").trim(),
  };
}

/** The caption a divider draws for a move, from the reader's side: the child's
 *  thread names the session by "this session"; the role's thread names it. */
export function sessionEscalationCaption(m: SessionEscalationMessage, opts: { inChild: boolean }): string {
  const what = opts.inChild ? "this session" : m.session.short_id;
  if (m.move === "back") return m.left ? `${what} no longer reports to @${m.role.handle}` : `${what} is back with @${m.role.handle}`;
  const who = m.by === "person" ? m.to : `@${m.role.handle}`;
  const verb = m.move === "direct" ? "put" : "handed";
  const where = m.move === "direct" ? `in front of ${m.to}` : `to ${m.to}`;
  return `${who} ${verb} ${what} ${where}`;
}
