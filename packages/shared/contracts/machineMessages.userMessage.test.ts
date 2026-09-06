import { describe, expect, test } from "bun:test";
import { formatUserMessage, parseUserMessage, isUserMessage, isMachineDeliveredMessage, isSessionMessage } from "./machineMessages";

describe("user-message wire format (a person typing into a session)", () => {
  test("round-trips name and body", () => {
    const wire = formatUserMessage("Ashot Petrosian", "its me - typing directly\n\nyou can proceed");
    expect(wire).toBe('<user-message from="Ashot Petrosian">\nits me - typing directly\n\nyou can proceed\n</user-message>');
    expect(parseUserMessage(wire)).toEqual({ from: "Ashot Petrosian", body: "its me - typing directly\n\nyou can proceed" });
    expect(isUserMessage(wire)).toBe(true);
  });

  test("is human-typed, not machine-delivered, and not a session message", () => {
    const wire = formatUserMessage("Ashot", "ship it");
    expect(isMachineDeliveredMessage(wire)).toBe(false);
    expect(isSessionMessage(wire)).toBe(false);
  });

  test("tolerates injection noise, a collapsed echo, and a truncated preview", () => {
    expect(parseUserMessage('\x01<system-reminder>x</system-reminder><user-message from="A">\nhi\n</user-message>')).toEqual({ from: "A", body: "hi" });
    expect(parseUserMessage('<user-message from="A"> hi there </user-message>')).toEqual({ from: "A", body: "hi there" });
    expect(parseUserMessage('<user-message from="A">\nlong message cut mid')).toEqual({ from: "A", body: "long message cut mid" });
  });

  test("a quote in the name cannot break the tag", () => {
    const wire = formatUserMessage('Ann "Bo" Lee', "x");
    expect(parseUserMessage(wire)?.from).toBe("Ann 'Bo' Lee");
  });

  test("plain text and session messages are not user messages", () => {
    expect(parseUserMessage("just a prompt")).toBeNull();
    expect(isUserMessage('<session-message from="jx7c6zk">\nx\n</session-message>')).toBe(false);
  });
});
