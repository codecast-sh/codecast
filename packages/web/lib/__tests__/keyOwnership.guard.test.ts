import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { keyBelongsElsewhere, keysOwnedElsewhere } from "../../shortcuts/keyOwnership";

// Two layers keep a page from acting on keys that belong to something on top
// of it. An overlay holding focus (the undo timeline card) claims its keys in
// the app's first key listener (claimKeys), so no page listener sees them at
// all; UndoTimelineView.mount.test proves that against listeners in every
// phase. A focused region inside the page that owns its plain keys (the
// branch map, the vault explorer, an active review) keeps them by asking:
// page key listeners run beside the region's own handler, so each must check
// keyBelongsElsewhere.

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

// Every keydown listener under app/, components/ and hooks/ (addEventListener
// on window or document, or useEventListener) that skips text fields by hand
// must also honour key ownership, through the one helper. The listed files skip text fields for a different reason (a field
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
    ["git", "grep", "-lE", '((window|document)\\.addEventListener|useEventListener)\\(\\s*"keydown"', "--", "app", "components", "hooks"],
    { cwd: ROOT },
  );
  return out.stdout.toString().split("\n").filter((f) => f && /\.tsx?$/.test(f) && !/(__tests__|\.test\.tsx?$)/.test(f));
}

describe("page key listeners honour key ownership", () => {
  test("no page keydown listener skips text fields without the ownership rule", () => {
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
  }, 60_000);
});

// The card's keys are claimed, never handled in React: a React onKeyDown on
// the card runs after every window and document capture listener has already
// seen the key, which is how each earlier page leak happened.
describe("the undo timeline card claims its keys", () => {
  test("UndoTimelineView handles no key in React and registers a claim", () => {
    const src = readFileSync(join(ROOT, "components/undo/UndoTimelineView.tsx"), "utf8");
    expect(src).not.toMatch(/onKeyDown|onKeyUp|addEventListener\("key/);
    expect(src).toMatch(/claimKeys\(/);
  });
});

// A keyboard owner's allow list must cover every chord the owner hands on by
// name. The desktop Edit menu takes ⌘Z before the page and hands it back
// through the same ownership check, so a chord the card dispatches itself but
// its owner entry rejects is dead from the menu bar (the mouse path).
describe("keyboard owners allow the chords they hand on", () => {
  test("the undo card's handed-on chords pass the ownership check with focus in the card", async () => {
    const { KEY_OWNERSHIP, UNDO_CARD_CHORDS } = await import("../../shortcuts/keyOwnership");
    const { shortcutAllowedAt } = await import("@platform/keys");
    const { getShortcutsForAction } = await import("../../shortcuts");
    const cardFocus = { tagName: "DIV", closest: (sel: string) => (sel === '[data-undo-timeline="interactive"]' ? {} : null) } as any;
    expect(UNDO_CARD_CHORDS).toEqual(["ui.undo", "ui.redo", "ui.undoHistory"]);
    for (const action of UNDO_CARD_CHORDS) {
      const defs = getShortcutsForAction(action);
      expect(defs.length).toBeGreaterThan(0);
      expect(defs.some((d) => shortcutAllowedAt(cardFocus, d, KEY_OWNERSHIP, false))).toBe(true);
    }
  });
});
