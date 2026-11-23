import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Every owners control a finger reaches gets a 44px target on a coarse
// pointer (the Daylight tablet, a phone browser): the menu, the composer
// strip, the header segment, the Reports-to picker on a role's own session
// and the docked terminal's copy title.
const css = readFileSync(join(import.meta.dir, "..", "..", "app/globals.css"), "utf8");
const coarse = (() => {
  const at = css.indexOf("@media (pointer: coarse) {\n  [data-owners-menu]");
  expect(at).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("\n}\n", at));
})();

test("the Reports-to picker's rows are 44px tall on a coarse pointer", () => {
  expect(coarse).toMatch(/\[data-seat-reports-to\] \.own-row[^{]*\{ min-height: 44px; \}/);
});

test("the terminal's copy title is a 44px target in a 44px bar on a coarse pointer", () => {
  expect(coarse).toContain("[data-terminal-bar] { height: 44px !important; }");
  expect(coarse).toContain("[data-terminal-attach] { min-height: 44px; }");
  const terminal = readFileSync(join(import.meta.dir, "..", "terminal/ConversationTerminal.tsx"), "utf8");
  expect(terminal).toMatch(/<div data-terminal-bar className="flex items-center h-\[24px\]/);
});
