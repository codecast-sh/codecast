import { describe, expect, test } from "bun:test";
import { NO_CHARACTER_PREFS, DEFAULT_IDENTITY_PREFS, PERSONIFY_ALL_PREFS } from "../../sessionIdentity";
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
