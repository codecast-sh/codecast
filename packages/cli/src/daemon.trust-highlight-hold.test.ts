import { describe, expect, test } from "bun:test";
import { HIGHLIGHT_HOLD_AFTER_FAILURES, HIGHLIGHT_HOLD_REASON, highlightFailureCount, selectHighlightedOption, trustHighlightHold } from "./daemon.js";

// A trust dialog whose highlight cannot be placed was retried every second for
// hours, logging "pressing nothing" each time and never showing the screen. The
// refusal stays (never confirm the wrong option); the repeat does not.

// The cursor sits on "No, exit" and never moves, whatever key is pressed.
const STUCK = "Do you trust this folder?\n  1. Yes, I trust this folder\n❯ 2. No, exit";
const isYes = (line: string) => /Yes, I trust/.test(line);

function fakePane(screen: string) {
  const keys: string[] = [];
  const exec = async (args: string[]) => {
    if (args[0] === "send-keys") keys.push(args[args.length - 1]);
    return { stdout: args[0] === "capture-pane" ? screen : "", stderr: "" };
  };
  return { keys, exec: exec as any };
}

describe("a trust dialog whose highlight cannot be placed", () => {
  test("presses only the cursor keys, never Enter, and counts each refusal", async () => {
    const pane = fakePane(STUCK);
    expect(await selectHighlightedOption("t:stuck", isYes, "the trust dialog", pane.exec)).toBe(false);
    expect(pane.keys).not.toContain("Enter");
    expect(highlightFailureCount("t:stuck")).toBe(1);
    await selectHighlightedOption("t:stuck", isYes, "the trust dialog", pane.exec);
    expect(highlightFailureCount("t:stuck")).toBe(2);
  }, 30_000);

  test("holds the message with the screen once the refusals reach the limit", async () => {
    const pane = fakePane("Do you trust this folder?\n  1. Yes, I trust this folder\n  2. No, exit");
    for (let i = 0; i < HIGHLIGHT_HOLD_AFTER_FAILURES; i++) {
      expect(trustHighlightHold("t:hold", STUCK)).toBeNull();
      await selectHighlightedOption("t:hold", isYes, "the trust dialog", pane.exec);
    }
    const hold = trustHighlightHold("t:hold", STUCK)!;
    expect(hold.holdReason).toBe(HIGHLIGHT_HOLD_REASON);
    expect(hold.screen).toContain("No, exit");
  });

  test("a placed highlight clears the streak", async () => {
    await selectHighlightedOption("t:ok", isYes, "the trust dialog", fakePane(STUCK).exec);
    expect(highlightFailureCount("t:ok")).toBe(1);
    const ok = fakePane("Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit");
    expect(await selectHighlightedOption("t:ok", isYes, "the trust dialog", ok.exec)).toBe(true);
    expect(highlightFailureCount("t:ok")).toBe(0);
  }, 30_000);
});
