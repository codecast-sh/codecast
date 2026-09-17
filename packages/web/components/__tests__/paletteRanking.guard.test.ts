import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const palette = readFileSync(join(import.meta.dir, "../CommandPalette.tsx"), "utf8");

test("named New note is a compose fallback after search results, not the default", () => {
  const named = palette.indexOf('key="vault-new-named"');
  const search = palette.indexOf("Search Results (${searchRows.length})");
  expect(named).toBeGreaterThan(0);
  expect(search).toBeGreaterThan(0);
  expect(named).toBeGreaterThan(search);
  expect(palette.slice(named, named + 220)).toContain("__compose__");
  expect(palette).toContain("filter={paletteItemScore}");
  expect(palette).toContain("!searchAwaiting");
});
