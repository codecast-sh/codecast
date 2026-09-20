import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// Source files larger than the cap must be listed here with the size they had
// when they were last measured, plus a small allowance. A listed file may
// shrink freely; lower its number when it does. It may not grow past the
// allowance, so the pressure that built ConversationView.tsx to 18,552 lines
// cannot rebuild it: a new message kind goes in components/conversation/blocks,
// a new container feature goes in a hook, and a file that needs a bigger
// number needs a reason in the commit that raises it.
const ROOT = join(import.meta.dir, "..", "..");
const CAP = 1500;
const ALLOWANCE: Record<string, number> = {
  "store/inboxStore.ts": 13400,
  "components/GlobalSessionPanel.tsx": 5900,
  "components/ConversationView.tsx": 4950,
  "components/CommandPalette.tsx": 3650,
  "components/MessageInput.tsx": 2800,
  "app/tasks/page.tsx": 1900,
  "app/triggers/page.tsx": 1900,
  "lib/calls/walkie.ts": 1850,
  "components/Sidebar.tsx": 1750,
  "lib/desktop.ts": 1700,
  "components/conversation/blocks/turnBlocks.tsx": 1650,
  "store/chatSlice.ts": 1650,
  "components/conversation/blocks/toolBlocks.tsx": 1650,
  "components/GenericListView.tsx": 1550,
};

function* sourceFiles(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "__tests__") continue;
    if (statSync(p).isDirectory()) yield* sourceFiles(p);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

function lineCount(p: string): number {
  return readFileSync(p, "utf8").split("\n").length;
}

describe("Source file size ratchet", () => {
  const files = ["app", "components", "store", "lib", "hooks"].flatMap((d) => [...sourceFiles(join(ROOT, d))]);
  const sizes = new Map(files.map((p) => [relative(ROOT, p), lineCount(p)]));

  test("no file grows past its allowance", () => {
    const over: string[] = [];
    for (const [file, lines] of sizes) {
      const allowed = ALLOWANCE[file] ?? CAP;
      if (lines > allowed) over.push(`${file}: ${lines} lines, allowed ${allowed}`);
    }
    expect(over).toEqual([]);
  });

  test("every listed file still exists and still needs listing", () => {
    const stale: string[] = [];
    for (const [file, allowed] of Object.entries(ALLOWANCE)) {
      const lines = sizes.get(file);
      if (lines === undefined) stale.push(`${file}: listed but missing`);
      else if (lines <= CAP) stale.push(`${file}: ${lines} lines is under the cap, drop it from the list`);
      else if (lines < allowed * 0.9) stale.push(`${file}: ${lines} lines, lower its allowance from ${allowed}`);
    }
    expect(stale).toEqual([]);
  });
});
