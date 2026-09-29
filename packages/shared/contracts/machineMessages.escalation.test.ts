import { describe, expect, test } from "bun:test";
import { isMachineDeliveredMessage, isSessionEscalationMessage, parseSessionEscalation, sessionEscalationCaption } from "./machineMessages";

// The verb that wrote this tag (`cast escalate`) is gone (org-staffing.md
// S28); threads written before that still carry it, so the parser and the
// caption stay so those dividers keep reading. Only reads are tested: nothing
// writes the tag any more.
describe("session escalation wire tag (legacy reader)", () => {
  const wire = [
    '<session-escalation move="handed" by="role" role="or-8" handle="calling" name="Calling" avatar="fox" session="jx7abcd" title="Market growth &quot;mandate&quot; &lt;beta&gt;" to="Ashot" at="1790000000000">',
    "the market fill is a **judgement call**\n\n- 40 seats\n- or 80",
    "</session-escalation>",
  ].join("\n");
  const base = {
    move: "handed" as const,
    by: "role" as const,
    role: { short_id: "or-8", handle: "calling", name: "Calling", avatar: "fox" },
    session: { short_id: "jx7abcd", title: 'Market growth "mandate" <beta>' },
    to: "Ashot",
    at: 1_790_000_000_000,
    line: "the market fill is a **judgement call**\n\n- 40 seats\n- or 80",
  };

  test("parses every field, the line as markdown, attributes unescaped; every machine-delivered surface skips it", () => {
    expect(isSessionEscalationMessage(wire)).toBe(true);
    expect(isMachineDeliveredMessage(wire)).toBe(true);
    expect(parseSessionEscalation(wire)).toEqual(base);
  });

  test("a hand back carries no line and no avatar; a torn preview still parses", () => {
    const back = '<session-escalation move="back" by="person" left="1" role="or-8" handle="calling" name="Calling" session="jx7abcd" to="Ashot" at="1790000000000">\n\n</session-escalation>';
    const parsed = parseSessionEscalation(back)!;
    expect(parsed.move).toBe("back");
    expect(parsed.by).toBe("person");
    expect(parsed.left).toBe(true);
    expect(parsed.line).toBe("");
    expect(parsed.role.avatar).toBeUndefined();
    expect(parsed.session.title).toBeUndefined();
    const torn = wire.slice(0, 200);
    expect(isSessionEscalationMessage(torn)).toBe(true);
    expect(parseSessionEscalation(torn)?.role.handle).toBe("calling");
  });

  test("a leaked keystroke before the tag and an unknown move", () => {
    expect(parseSessionEscalation("h" + wire)?.move).toBe("handed");
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
  });
});
