// Every action the keyboard settings let a person rebind must be read through
// the live catalog: registered with the dispatcher (useShortcutAction,
// usePaneShortcutAction, registerAction) or matched by a page's own handler
// with matchesAction. A handler that tests `e.key === "m"` keeps answering
// the default after a rebind, so an action read that way is `fixed: true`
// in packages/shared/contracts/shortcutCatalog.ts instead.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SHORTCUTS } from "@codecast/shared/contracts/shortcutCatalog";

const WEB = join(import.meta.dir, "..");
const ROOTS = ["app", "components", "hooks", "lib", "shortcuts", "src", "tips"];
// The shared Evals views (vendored @platform/evals) name their actions as
// keys of the map they hand the host's useShortcuts (components/evals/host),
// which registers each one with the dispatcher.
const EVALS = join(WEB, "../../platform/packages/evals/src/react");

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sources(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(readFileSync(path, "utf8"));
  }
  return out;
}

const ID = `['"]([a-zA-Z]+\\.[a-zA-Z0-9]+)['"]`;
const READS = [
  new RegExp(`(?:useShortcutAction|usePaneShortcutAction|registerAction)\\(\\s*${ID}`, "g"),
  new RegExp(`matchesAction\\(\\s*\\w+,\\s*${ID}`, "g"),
  // GenericListView's paletteShortcuts and HOSTED_SECTION_KEYS: rows whose
  // action the list (matchesAction) or HostedSectionKeys (useShortcutAction)
  // reads.
  new RegExp(`\\{\\s*action:\\s*${ID},\\s*(?:mode|path):`, "g"),
  // A map handed to the evals host's useShortcuts.
  new RegExp(`${ID}:\\s*\\{\\s*keys:`, "g"),
];

const read = new Set<string>();
for (const text of [...ROOTS.flatMap((root) => sources(join(WEB, root))), ...sources(EVALS)]) {
  for (const re of READS) for (const m of text.matchAll(re)) read.add(m[1]);
}

describe("rebindable shortcuts", () => {
  const rebindable = [...new Set(SHORTCUTS.filter((d) => !d.fixed).map((d) => d.action))];

  test("every action without fixed: true is read through the live catalog", () => {
    expect(rebindable.filter((id) => !read.has(id))).toEqual([]);
  });

  test("an action is fixed in all of its defs or in none", () => {
    const mixed = rebindable.filter((id) => SHORTCUTS.some((d) => d.action === id && d.fixed));
    expect(mixed).toEqual([]);
  });
});
