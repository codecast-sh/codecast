import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The usage chip's hover panel hangs off the desktop titlebar. The titlebar
// is a drag region; a drag region eats pointer events, so moving from the
// chip onto the panel looks like a leave and the panel closes. data-flyout
// opts the panel out (globals.css). Same contract as people-strip-faces.

const web = join(import.meta.dir, "..", "..");
const css = readFileSync(join(web, "app/globals.css"), "utf8");
const chip = readFileSync(join(web, "components/AccountUsageChip.tsx"), "utf8");

describe("usage chip hover panel vs titlebar drag", () => {
  test("globals.css marks [data-flyout] no-drag", () => {
    const rule = css.match(/\[data-flyout\]\s*\{([^}]+)\}/);
    expect(rule).toBeTruthy();
    expect(rule![1]).toMatch(/-webkit-app-region:\s*no-drag/);
  });

  test("the hover panel carries data-flyout", () => {
    const panel = chip.match(/<div([^>]*absolute right-0 top-full[^>]*)>/);
    expect(panel).toBeTruthy();
    expect(panel![1]).toContain("data-flyout");
  });
});

// The switcher is a fixture of the top bar. It used to go three ways: the
// name vanished under 1460px (leaving a bare dot), a quiet or failed query
// blanked the whole chip, and a machine with no reported account rendered
// nothing at all. Each one read as a control that comes and goes.
describe("usage chip never leaves the bar", () => {
  test("the account name carries no width-gated hide", () => {
    expect(chip).not.toContain("tb-squeeze");
    expect(css).not.toContain("tb-squeeze");
  });

  test("a quiet query keeps the last resolve on screen", () => {
    expect(chip).toContain("if (liveResolved) lastResolved.current = liveResolved;");
    expect(chip).toContain("const resolved = liveResolved ?? lastResolved.current;");
  });

  test("an unresolved chip holds its slot instead of returning null", () => {
    const branch = chip.match(/if \(!resolved \|\| !device\) return ([^;]+);/);
    expect(branch).toBeTruthy();
    expect(branch![1]).toContain("AccountChipEmpty");
  });
});
