import { test, expect, describe } from "bun:test";
import { parseSessionMessage, parseInboundSessionMessage, isSessionMessage, formatSessionMessage } from "./sessionMessage";

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

describe("isSessionMessage", () => {
  test("detects a well-formed inbound message", () => {
    expect(isSessionMessage(formatSessionMessage("jx7c6zk", "hi"))).toBe(true);
  });

  test("detects a TRUNCATED preview that dropped the closing tag", () => {
    // last_message_preview is sliced to 200 chars, so a long body cuts off the
    // closing </session-message> — detection must key off the opening tag only.
    const truncated = formatSessionMessage("jx7c6zk", "x".repeat(400)).slice(0, 200);
    expect(truncated.includes("</session-message>")).toBe(false);
    expect(isSessionMessage(truncated)).toBe(true);
  });

  test("sees through leading control chars leaked by the tmux inject", () => {
    const withCtrl = String.fromCharCode(1, 11) + formatSessionMessage("jx7c6zk", "hi");
    expect(isSessionMessage(withCtrl)).toBe(true);
  });

  test("sees through a leading system/task reminder", () => {
    const withReminder = "<system-reminder>noise</system-reminder>\n" + formatSessionMessage("jx7c6zk", "hi");
    expect(isSessionMessage(withReminder)).toBe(true);
  });

  test("rejects plain text and other wrappers", () => {
    expect(isSessionMessage("just a normal message")).toBe(false);
    expect(isSessionMessage('<scheduled-task title="x">y</scheduled-task>')).toBe(false);
    expect(isSessionMessage("")).toBe(false);
    expect(isSessionMessage(null)).toBe(false);
    expect(isSessionMessage(undefined)).toBe(false);
  });

  test("rejects a wrapper missing the from attribute", () => {
    expect(isSessionMessage("<session-message>no attr</session-message>")).toBe(false);
  });
});

describe("parseInboundSessionMessage", () => {
  test("parses through control chars and reminders", () => {
    const raw = String.fromCharCode(1) + "<system-reminder>x</system-reminder>\n" + formatSessionMessage("jx7c6zk", "take the auth half");
    expect(parseInboundSessionMessage(raw)).toEqual({ from: "jx7c6zk", body: "take the auth half" });
  });

  test("returns null on a truncated wrapper (needs the full body)", () => {
    const truncated = formatSessionMessage("jx7c6zk", "y".repeat(400)).slice(0, 200);
    expect(parseInboundSessionMessage(truncated)).toBeNull();
  });

  test("returns null for plain text and nullish input", () => {
    expect(parseInboundSessionMessage("hello")).toBeNull();
    expect(parseInboundSessionMessage(null)).toBeNull();
    expect(parseInboundSessionMessage(undefined)).toBeNull();
  });

  test("extracts the optional display name (link collaborator with no session pill)", () => {
    const raw = '<session-message from="unknown" name="Ada Lovelace">\nship it\n</session-message>';
    expect(parseInboundSessionMessage(raw)).toEqual({ from: "unknown", body: "ship it", name: "Ada Lovelace" });
  });

  test("a wrapper without a name still parses (backward compatible)", () => {
    const raw = formatSessionMessage("jx7c6zk", "hi");
    const parsed = parseInboundSessionMessage(raw);
    expect(parsed?.from).toBe("jx7c6zk");
    expect(parsed?.name).toBeUndefined();
  });
});
