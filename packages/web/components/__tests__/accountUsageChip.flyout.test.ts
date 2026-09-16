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
