import { describe, expect, test } from "bun:test";
import { classifyLivePaneFor, isCodexLoginScreen, isCodexUpdateDialog } from "./tmuxPaneState.js";
import { inputGuard } from "./daemon.js";

// codex 0.169.0 after its login stopped refreshing, captured verbatim from
// MacBook-Pro-2 (jx74mh8, 2026-11-14). The daemon read it as a question for a
// person: four messages waited over an hour behind a card whose answer starts a
// browser login on another machine.
const SIGNED_OUT = `  Welcome to Codex, OpenAI's command-line coding agent

  Choose how you want to use Codex.

> 1. Sign in with ChatGPT
     Usage included with Plus, Pro, Business, and Enterprise plans

  2. Sign in with Device Code
     Sign in from another device with a one-time code

  3. Sign in another way
     Use an API key or another provider

  Press enter to continue`;

const UPDATE = `  ✨ Update available! 0.167.2 -> 0.169.0
  Release notes: https://github.com/openai/codex/releases/latest

› 1. Update now (runs \`bun install -g @openai/codex\`)
  2. Skip
  3. Skip until next version

  Press enter to continue`;

describe("codex at its login screen", () => {
  test("reads as signed out, never as the update menu or a question", () => {
    expect(isCodexLoginScreen(SIGNED_OUT)).toBe(true);
    expect(isCodexUpdateDialog(SIGNED_OUT)).toBe(false);
    expect(classifyLivePaneFor("codex", SIGNED_OUT)).toBe("signed_out");
  });

  test("the update menu stays the update menu", () => {
    expect(isCodexLoginScreen(UPDATE)).toBe(false);
    expect(classifyLivePaneFor("codex", UPDATE)).toBe("update_menu");
  });

  test("delivery holds with the login step, not as a human answer", async () => {
    let caught: any;
    try { await inputGuard(async () => SIGNED_OUT)(); } catch (err) { caught = err; }
    expect(caught?.holdReason).toContain("codex login");
    expect(caught?.holdReason).not.toContain("human answer");
  });
});
