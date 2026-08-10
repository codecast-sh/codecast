import { describe, expect, test } from "bun:test";
import { planLeadPaneHeal } from "./daemon.js";

// Regression: Claude Code's teammate panes split the daemon's 220-column
// window and squeeze the lead pane (observed: lead 66, two 153-wide teammate
// panes). The old heal only ran resize-window, a no-op on a window that is
// already full size, so the lead pane — the one the classifier reads and the
// web terminal mirrors — stayed narrow forever. A split squeeze must widen
// the lead pane itself.
describe("planLeadPaneHeal", () => {
  test("healthy pane needs no heal", () => {
    expect(planLeadPaneHeal(220, 1)).toEqual([]);
    expect(planLeadPaneHeal(80, 3)).toEqual([]);
  });

  test("narrow single-pane window is healed by resize-window alone", () => {
    const cmds = planLeadPaneHeal(66, 1);
    expect(cmds).toHaveLength(1);
    expect(cmds[0][0]).toBe("resize-window");
  });

  test("narrow lead pane in a split window also gets resize-pane", () => {
    const cmds = planLeadPaneHeal(66, 3);
    expect(cmds.map((c) => c[0])).toEqual(["resize-window", "resize-pane"]);
    const resizePane = cmds[1];
    const width = parseInt(resizePane[resizePane.indexOf("-x") + 1], 10);
    // Lead must clear the 80-column TUI floor without starving the side stack
    // of a 220-column window below that same floor.
    expect(width).toBeGreaterThanOrEqual(80);
    expect(220 - width - 1).toBeGreaterThanOrEqual(80);
  });

  test("unparseable geometry falls back to the old resize-window-only heal", () => {
    expect(planLeadPaneHeal(NaN, NaN).map((c) => c[0])).toEqual(["resize-window"]);
  });
});
