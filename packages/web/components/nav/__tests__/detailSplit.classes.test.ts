import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The Modern list-and-item split once shared the class `cc-split` with the
// app's resize handle (globals.css: width 1px, col-resize), which squeezed
// every list page in Modern to a 1px column. Its classes are its own.
test("no rule in globals.css targets a class of the Modern detail split", () => {
  const split = readFileSync(join(import.meta.dir, "..", "detailSplit.css"), "utf8");
  const globals = readFileSync(join(import.meta.dir, "..", "..", "..", "app", "globals.css"), "utf8");
  const names = [...new Set([...split.matchAll(/\.(cc-[a-z0-9_-]+)/g)].map((m) => m[1]))];
  expect(names.length).toBeGreaterThan(0);
  const shared = names.filter((name) => new RegExp(`\\.${name}(?![a-z0-9_-])`).test(globals));
  expect(shared).toEqual([]);
});
