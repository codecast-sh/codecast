import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("the command palette shortcut stays mounted while the lazy palette is closed", () => {
  const actions = readFileSync(join(import.meta.dir, "actions.ts"), "utf8");
  const palette = readFileSync(join(import.meta.dir, "../components/CommandPalette.tsx"), "utf8");
  const layout = readFileSync(join(import.meta.dir, "../components/DashboardLayout.tsx"), "utf8");

  expect(actions.match(/useShortcutAction\(['"]palette\.toggle['"]/g)).toHaveLength(1);
  expect(palette).not.toMatch(/useShortcutAction\(['"]palette\.toggle['"]/);
  expect(layout).toContain("useGlobalShortcutActions();");
});
