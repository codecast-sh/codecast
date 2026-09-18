import { describe, expect, test } from "bun:test";
import { isBootstrapPrompt, isMachineDeliveredMessage } from "./machineMessages";

// The prompt that seats a standing agent is the host's message, never the
// person's words. One recogniser serves the scope page's cut, the inbox card's
// preview, the sticky prompt header and the navigator.
const rolePrompt = "You are **Gate test**, the standing agent for the **Gate test** role (@gate-test) in the Union workspace. You report to Ashot Petrosian.";
const teamAnchor = "You are **Anchor**, the **team** anchor for Union — every member of that team can reach you";
const personalAnchor = "You are **Anchor**, the **personal** anchor for Ashot — private to them";

describe("the seat's provisioning prompt is a machine message", () => {
  test("known by its first line, for a role and for both anchors", () => {
    for (const prompt of [rolePrompt, teamAnchor, personalAnchor]) {
      expect(isBootstrapPrompt(prompt)).toBe(true);
      expect(isMachineDeliveredMessage(prompt)).toBe(true);
    }
  });

  test("tolerates injection noise and the inbox's truncated preview", () => {
    expect(isBootstrapPrompt(`\x01<system-reminder>x</system-reminder>${rolePrompt}`)).toBe(true);
    expect(isBootstrapPrompt(rolePrompt.slice(0, 60))).toBe(true);
  });

  test("a person mentioning the words is not the prompt", () => {
    expect(isBootstrapPrompt("You are **not** a bootstrap: this is a person talking.")).toBe(false);
    expect(isBootstrapPrompt("Please read: You are **X**, the standing agent for the role")).toBe(false);
    expect(isBootstrapPrompt("")).toBe(false);
    expect(isBootstrapPrompt(null)).toBe(false);
  });
});
