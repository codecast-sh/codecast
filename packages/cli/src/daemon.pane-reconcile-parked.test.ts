import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { extractTmuxLiveRegion, paneReconcileTarget } from "./daemon.js";
import { classifyTmuxLiveState, claudeTurnRunningOnPane } from "./tmuxPaneState.js";

// A session that declared itself parked (waiting, dormant, done) while its pane
// reads busy: only a turn the pane shows running promotes it back to working.
describe("paneReconcileTarget: a parked declaration over a busy pane", () => {
  const settled = ["waiting", "dormant", "done"] as const;

  test("a turn the pane shows running is the lost wake: working", () => {
    for (const stored of settled) expect(paneReconcileTarget("busy", stored, true)).toBe("working");
  });

  // An idle compaction's overpainted rule, or a lead squeezed to its chip
  // list, reads busy for hours with no turn running.
  test("a busy reading with no running turn keeps the declaration", () => {
    for (const stored of settled) expect(paneReconcileTarget("busy", stored, false)).toBeNull();
    const squeezed = " ◯ nav…\n ◯ rev…\n        ↓ 2 more";
    expect(classifyTmuxLiveState(squeezed)).toBe("busy");
    expect(paneReconcileTarget("busy", "dormant", claudeTurnRunningOnPane(squeezed))).toBeNull();
  });

  test("a quiet status still climbs to working on any busy reading", () => {
    for (const stored of ["idle", "connected", undefined] as const) expect(paneReconcileTarget("busy", stored, false)).toBe("working");
  });

  // The 2026-11-23 captures: leads parked on their background agents. Before
  // the fix each read busy and was promoted to working; now the declaration
  // goes back through the settle verdict ("idle" here) and stands.
  test.each([
    "lead-idle-finished-agent-chip.txt",
    "lead-idle-running-agent-chips.txt",
    "lead-idle-agent-chip-tokens.txt",
    "lead-idle-agent-chips-background-tasks.txt",
  ])("a lead parked on its background agents is never promoted: %s", (name) => {
    const region = extractTmuxLiveRegion(fs.readFileSync(path.join(import.meta.dir, "__fixtures__", "claude-panes", name), "utf8"));
    for (const stored of settled) {
      expect(paneReconcileTarget(classifyTmuxLiveState(region), stored, claudeTurnRunningOnPane(region))).not.toBe("working");
    }
  });
});
