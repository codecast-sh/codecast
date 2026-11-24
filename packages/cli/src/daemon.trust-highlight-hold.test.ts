import { describe, expect, test } from "bun:test";
import { HIGHLIGHT_HOLD_AFTER_FAILURES, HIGHLIGHT_HOLD_REASON, highlightFailureCount, probeStartedPane, selectHighlightedOption, trustHighlightHold } from "./daemon.js";

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
    expect(await selectHighlightedOption("stuck:0.0", isYes, "the trust dialog", pane.exec)).toBe(false);
    expect(pane.keys).not.toContain("Enter");
    expect(highlightFailureCount("stuck:0.0")).toBe(1);
    await selectHighlightedOption("stuck:0.0", isYes, "the trust dialog", pane.exec);
    expect(highlightFailureCount("stuck:0.0")).toBe(2);
  }, 30_000);

  test("holds the message with the screen once the refusals reach the limit", async () => {
    const pane = fakePane("Do you trust this folder?\n  1. Yes, I trust this folder\n  2. No, exit");
    for (let i = 0; i < HIGHLIGHT_HOLD_AFTER_FAILURES; i++) {
      expect(trustHighlightHold("hold:0.0", STUCK)).toBeNull();
      await selectHighlightedOption("hold:0.0", isYes, "the trust dialog", pane.exec);
    }
    const hold = trustHighlightHold("hold:0.0", STUCK)!;
    expect(hold.holdReason).toBe(HIGHLIGHT_HOLD_REASON);
    expect(hold.screen).toContain("No, exit");
  });

  test("a placed highlight clears the streak", async () => {
    await selectHighlightedOption("ok:0.0", isYes, "the trust dialog", fakePane(STUCK).exec);
    expect(highlightFailureCount("ok:0.0")).toBe(1);
    const ok = fakePane("Do you trust this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit");
    expect(await selectHighlightedOption("ok:0.0", isYes, "the trust dialog", ok.exec)).toBe(true);
    expect(highlightFailureCount("ok:0.0")).toBe(0);
  }, 30_000);
});

// The launch path: a newly started session is probed again after every delivery
// retry, and each probe re-answers the dialog. It never held, so the first
// message waited behind the refusals for hours (1 h 52 min, ~1 probe per 1.3 s).
describe("a started session sitting at a trust dialog whose highlight cannot be placed", () => {
  const NO_CURSOR = "Do you trust this folder?\n  1. Yes, I trust this folder\n  2. No, exit";
  const entry = { tmuxSession: "started-stuck", projectPath: "/work", startedAt: 0, agentType: "claude" } as any;

  test("is probed without end until a delivery asks the probe to hold", async () => {
    const pane = fakePane(NO_CURSOR);
    const opts = { exec: pane.exec, pause: async () => {} };
    for (let i = 0; i < HIGHLIGHT_HOLD_AFTER_FAILURES * 3; i++) {
      expect(await probeStartedPane(entry, undefined, opts)).toMatchObject({ state: "trust" });
    }
    expect(pane.keys).toEqual([]);
  });

  test("holds the first message with the screen after the limit, pressing nothing", async () => {
    const pane = fakePane(NO_CURSOR);
    const pauses: number[] = [];
    const opts = { exec: pane.exec, pause: async (ms: number) => { pauses.push(ms); }, holdOnTrust: true };
    const entry2 = { ...entry, tmuxSession: "started-hold" };
    for (let i = 0; i < HIGHLIGHT_HOLD_AFTER_FAILURES - 1; i++) {
      expect(await probeStartedPane(entry2, undefined, opts)).toMatchObject({ state: "trust" });
    }
    const err = await probeStartedPane(entry2, undefined, opts).catch((e: any) => e);
    expect(err.holdReason).toBe(HIGHLIGHT_HOLD_REASON);
    expect(err.screen).toContain("No, exit");
    expect(pauses).toEqual([1000, 2000, 3000, 4000]);
    expect(pane.keys).toEqual([]);
  });

  test("the injection path and the launch path share one count per pane", async () => {
    const pane = fakePane(NO_CURSOR);
    await selectHighlightedOption("started-shared:0.0", isYes, "the trust dialog", pane.exec);
    expect(highlightFailureCount("started-shared")).toBe(1);
  });
});
