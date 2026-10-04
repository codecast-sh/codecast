import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keyBelongsElsewhere, keysOwnedElsewhere } from "../../shortcuts/keyOwnership";

// A focused region that owns its plain keys (the undo timeline card, the
// branch map, an active review) keeps them. Page key listeners on window or
// document run beside the region's own handler, so each must ask; one that
// only skips text fields drove the page behind an open timeline (Esc on a
// task page went to /tasks, arrows moved the Line's cursor).

const owner = { owns: true };
const inRegion = { closest: (sel: string) => (sel.includes("[data-owns-keys]") ? owner : null) };
const plain = { closest: () => null };

describe("keyBelongsElsewhere", () => {
  test("a text field or a key-owning region keeps the key; plain page focus does not", () => {
    expect(keyBelongsElsewhere({ tagName: "INPUT", closest: () => null } as any)).toBe(true);
    expect(keyBelongsElsewhere({ tagName: "SELECT", closest: () => null } as any)).toBe(true);
    expect(keyBelongsElsewhere({ tagName: "DIV", isContentEditable: true, closest: () => null } as any)).toBe(true);
    expect(keyBelongsElsewhere({ tagName: "DIV", ...inRegion } as any)).toBe(true);
    expect(keyBelongsElsewhere({ tagName: "BODY", ...plain } as any)).toBe(false);
    expect(keyBelongsElsewhere(null)).toBe(false);
  });
  test("a surface's own region is not elsewhere", () => {
    expect(keysOwnedElsewhere(inRegion, { contains: (n: unknown) => n === inRegion })).toBe(false);
    expect(keysOwnedElsewhere(inRegion, null)).toBe(true);
  });
});

// Every window or document keydown listener under app/ and components/ that
// skips text fields by hand must also honour key ownership, through the one
// helper. The listed files skip text fields for a different reason (a field
// of their own, Esc that blurs) and do not act on page focus.
const ROOT = join(import.meta.dir, "..", "..");
const EXEMPT = new Set([
  "components/ComposeView.tsx",
  "components/team/TeamFlowShell.tsx",
  "components/team/WorkspaceSharePicker.tsx",
  "components/decisions/DecisionAnswerControls.tsx",
]);

// Files that register a keydown listener on window or document (git grep, so
// a loaded machine does not read every file).
function listenerFiles(): string[] {
  const out = Bun.spawnSync(
    ["git", "grep", "-lE", '(window|document)\\.addEventListener\\("keydown"', "--", "app", "components"],
    { cwd: ROOT },
  );
  return out.stdout.toString().split("\n").filter((f) => f && /\.tsx?$/.test(f) && !/(__tests__|\.test\.tsx?$)/.test(f));
}

describe("page key listeners honour key ownership", () => {
  test("no window or document keydown listener skips text fields without the ownership rule", () => {
    const offenders: string[] = [];
    const files = listenerFiles();
    expect(files.length).toBeGreaterThan(10);
    for (const rel of files) {
      if (EXEMPT.has(rel)) continue;
      const src = readFileSync(join(ROOT, rel), "utf8");
      if (!/tagName === "INPUT"/.test(src)) continue;
      if (/keyBelongsElsewhere|keysOwnedElsewhere/.test(src)) continue;
      offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
