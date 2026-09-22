import { describe, expect, test } from "bun:test";
import { escalationFirstLine, formatSessionEscalation, isMachineDeliveredMessage, isSessionEscalationMessage, parseSessionEscalation, sessionEscalationCaption } from "./machineMessages";

// The one tag every move of a session between a role and a person is written
// as (org-roles-run-work.md R1, revised): the formatter and the parser round
// trip, the line survives whole, and every machine-delivered surface skips it.
describe("session escalation wire tag", () => {
  const base = {
    move: "handed" as const,
    by: "role" as const,
    role: { short_id: "or-8", handle: "calling", name: "Calling", avatar: "fox" },
    session: { short_id: "jx7abcd", title: 'Market growth "mandate" <beta>' },
    to: "Ashot",
    at: 1_790_000_000_000,
    line: "the market fill is a **judgement call**\n\n- 40 seats\n- or 80",
  };

  test("round trips every field, the line as markdown, attributes escaped", () => {
    const wire = formatSessionEscalation(base);
    expect(wire.startsWith('<session-escalation move="handed" by="role" role="or-8" handle="calling"')).toBe(true);
    expect(wire).toContain('title="Market growth &quot;mandate&quot; &lt;beta&gt;"');
    expect(isSessionEscalationMessage(wire)).toBe(true);
    expect(isMachineDeliveredMessage(wire)).toBe(true);
    expect(parseSessionEscalation(wire)).toEqual(base);
  });

  test("a hand back carries no line and no avatar; a torn preview still parses", () => {
    const wire = formatSessionEscalation({ ...base, move: "back", by: "person", role: { short_id: "or-8", handle: "calling", name: "Calling" }, session: { short_id: "jx7abcd" }, line: "" });
    const parsed = parseSessionEscalation(wire)!;
    expect(parsed.move).toBe("back");
    expect(parsed.by).toBe("person");
    expect(parsed.line).toBe("");
    expect(parsed.role.avatar).toBeUndefined();
    expect(parsed.session.title).toBeUndefined();
    const torn = formatSessionEscalation(base).slice(0, 200);
    expect(isSessionEscalationMessage(torn)).toBe(true);
    expect(parseSessionEscalation(torn)?.role.handle).toBe("calling");
  });

  test("a leaked keystroke before the tag and an unknown move", () => {
    expect(parseSessionEscalation("h" + formatSessionEscalation(base))?.move).toBe("handed");
    expect(parseSessionEscalation('<session-escalation move="sideways" role="or-8">x</session-escalation>')).toBeNull();
    expect(isSessionEscalationMessage("<session-message from=\"jx7\">hi</session-message>")).toBe(false);
  });

  test("captions read from the child's side and from the role's side", () => {
    expect(sessionEscalationCaption(base, { inChild: true })).toBe("@calling handed this session to Ashot");
    expect(sessionEscalationCaption(base, { inChild: false })).toBe("@calling handed jx7abcd to Ashot");
    expect(sessionEscalationCaption({ ...base, move: "direct" }, { inChild: true })).toBe("@calling put this session in front of Ashot");
    expect(sessionEscalationCaption({ ...base, move: "direct", by: "person" }, { inChild: false })).toBe("Ashot put jx7abcd in front of Ashot");
    expect(sessionEscalationCaption({ ...base, move: "back" }, { inChild: true })).toBe("this session is back with @calling");
    expect(sessionEscalationCaption({ ...base, move: "back", left: true }, { inChild: false })).toBe("jx7abcd no longer reports to @calling");
    expect(parseSessionEscalation(formatSessionEscalation({ ...base, move: "back", left: true }))?.left).toBe(true);
    expect(parseSessionEscalation(formatSessionEscalation(base))?.left).toBeUndefined();
  });

  test("every strip shows the first non blank line; the divider gets the whole thing", () => {
    expect(escalationFirstLine("\n\n  the ask  \n\nmore")).toBe("the ask");
    expect(escalationFirstLine("one line")).toBe("one line");
    expect(escalationFirstLine("")).toBe("");
  });
});
