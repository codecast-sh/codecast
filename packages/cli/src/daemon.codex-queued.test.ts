import { describe, expect, test } from "bun:test";
import { classifyTmuxLiveState, extractTmuxLiveRegion } from "./daemon.js";
import { codexQueuedPane } from "./test-helpers/codexQueuedPane.js";

describe("Codex queued-message live region", () => {
  test("keeps queued reports busy when the working marker is above the five-line tail", () => {
    const pane = codexQueuedPane();
    expect(pane.split("\n").slice(-5).join("\n")).not.toContain("esc to interrupt");
    expect(classifyTmuxLiveState(extractTmuxLiveRegion(pane))).toBe("busy");
  });

  test("recognizes the live queue after the working marker leaves the capture", () => {
    const pane = codexQueuedPane().split("\n").slice(2).join("\n");
    expect(classifyTmuxLiveState(extractTmuxLiveRegion(pane))).toBe("busy");
  });

  test("queued message separators and modal text cannot hide the busy panel", () => {
    const pane = codexQueuedPane("", ["─".repeat(80), "What should Claude do instead?", "─".repeat(80)]);
    expect(classifyTmuxLiveState(extractTmuxLiveRegion(pane))).toBe("busy");
  });

  test("retains a live working marker separated from the composer by blank rows", () => {
    const pane = "• Compacting conversation (2m 10s • esc to interrupt)\n\n\n\n\n› \n\n  gpt-6-astra xhigh · /tmp";
    expect(classifyTmuxLiveState(extractTmuxLiveRegion(pane))).toBe("busy");
  });

  test("ignores a historical queue panel above a completed reply", () => {
    const pane = `${codexQueuedPane()}\n\n• Finished the requested work.\n\n› Ask Codex to do anything\n\n  gpt-6-astra xhigh · /tmp`;
    expect(classifyTmuxLiveState(extractTmuxLiveRegion(pane))).toBe("idle");
  });

  test("ignores a historical working marker above a completed reply", () => {
    const pane = "• Working (1m 00s • esc to interrupt)\n\n• Done.\n\n› Ask Codex to do anything\n\n  gpt-6-astra xhigh · /tmp";
    expect(classifyTmuxLiveState(extractTmuxLiveRegion(pane))).toBe("idle");
  });
});
