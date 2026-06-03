import { test, expect, describe } from "bun:test";
import { parseSessionMessage, formatSessionMessage } from "./sessionMessage";

describe("parseSessionMessage", () => {
  test("extracts sender short id and body", () => {
    const r = parseSessionMessage('<session-message from="jx7c6zk">\ncan you take the auth half?\n</session-message>');
    expect(r).toEqual({ from: "jx7c6zk", body: "can you take the auth half?" });
  });

  test("round-trips with formatSessionMessage", () => {
    const wire = formatSessionMessage("jx7c6zk", "done with the daemon side");
    expect(parseSessionMessage(wire)).toEqual({ from: "jx7c6zk", body: "done with the daemon side" });
  });

  test("preserves multi-line / markdown body", () => {
    const body = "Here's the plan:\n\n- step one\n- step two\n\nSee `jx7abcd` for context.";
    const r = parseSessionMessage(formatSessionMessage("jx7c6zk", body));
    expect(r?.body).toBe(body);
  });

  test("tolerates extra attributes after from", () => {
    const r = parseSessionMessage('<session-message from="jx7c6zk" title="Auth fix">hi</session-message>');
    expect(r).toEqual({ from: "jx7c6zk", body: "hi" });
  });

  test("returns null for unknown sender placeholder body but still parses", () => {
    const r = parseSessionMessage('<session-message from="unknown">orphan message</session-message>');
    expect(r).toEqual({ from: "unknown", body: "orphan message" });
  });

  test("does not match plain text or other wrappers", () => {
    expect(parseSessionMessage("just a normal message")).toBeNull();
    expect(parseSessionMessage('<scheduled-task title="x">y</scheduled-task>')).toBeNull();
    expect(parseSessionMessage("")).toBeNull();
  });

  test("ignores a malformed wrapper missing the from attribute", () => {
    expect(parseSessionMessage("<session-message>no attr</session-message>")).toBeNull();
  });
});
