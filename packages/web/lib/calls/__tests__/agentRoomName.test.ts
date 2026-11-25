import { describe, expect, test } from "bun:test";
import { NO_CHARACTER_PREFS, DEFAULT_IDENTITY_PREFS, PERSONIFY_ALL_PREFS, sessionIdentity } from "../../sessionIdentity";
import { agentRoomName, NEW_AGENT_NAME } from "../findSessionRow";

// ct-101369: an agent fed into a call room has no title until its first
// prompt. Its row has arrived, so the room must call it by a name of its own,
// never the placeholder that means "no row yet".
describe("agentRoomName for an untitled agent whose row has landed", () => {
  const untitled = { _id: "conv_abc123", session_id: "sess-7f3a", short_id: "jx7abcd", title: undefined };

  for (const [label, prefs] of [
    ["characters off", NO_CHARACTER_PREFS],
    ["characters on", DEFAULT_IDENTITY_PREFS],
    ["personify all", PERSONIFY_ALL_PREFS],
  ] as const) {
    test(`${label}: names it, not "${NEW_AGENT_NAME}"`, () => {
      const name = agentRoomName(untitled, prefs);
      expect(name.trim().length).toBeGreaterThan(0);
      expect(name).not.toBe(NEW_AGENT_NAME);
    });
  }
});

describe("agentRoomName is one name per row, whoever reads it", () => {
  const untitled = { _id: "conv_abc123", session_id: "sess-7f3a", short_id: "jx7abcd", title: undefined };

  test("an untitled row gets the same name with characters off as with them on, every time", () => {
    const on = agentRoomName(untitled, DEFAULT_IDENTITY_PREFS);
    expect(agentRoomName(untitled, NO_CHARACTER_PREFS)).toBe(on);
    expect(agentRoomName({ ...untitled }, NO_CHARACTER_PREFS)).toBe(agentRoomName(untitled, NO_CHARACTER_PREFS));
  });

  test("a titled row is its title to a viewer with characters off", () => {
    expect(agentRoomName({ ...untitled, title: "Fix the auth race" }, NO_CHARACTER_PREFS)).toBe("Fix the auth race");
  });

  test("a role's session is the role's name, titled or not", () => {
    const role = { _id: "r1", name: "Hazel", title: "Engineering Co-worker", handle: "eng" };
    const row = { ...untitled, standing_role_id: "r1", role };
    expect(agentRoomName(row, DEFAULT_IDENTITY_PREFS)).toBe((sessionIdentity(row, DEFAULT_IDENTITY_PREFS) as any).name);
    expect(agentRoomName(row, NO_CHARACTER_PREFS)).toBe((sessionIdentity(row, NO_CHARACTER_PREFS) as any).title);
  });
});
