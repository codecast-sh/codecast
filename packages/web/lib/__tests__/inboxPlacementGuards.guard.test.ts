import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MOBILE_ROOT, WEB_ROOT, offendersUnder } from "./sourceWalk";

// THE PLACEMENT CHOKEPOINT GUARD (docs/architecture/sync-convergence.md C5).
//
// `placeInboxRows` (store/inboxStore.ts) is the ONE function that places the
// replica's rows for every counting surface — panel, sidebar/dock badges,
// active-agents pill, fleet board, thread cards, palette, mobile inbox. The
// classifiers it replaced are DELETED; any reappearance of their names in code
// is a parallel counting path being reborn — the divergence class (panel 24 /
// badge 25 / mobile 50) the chokepoint exists to end:
//
//   categorizeSessions / categorizeMineSessions  the pre-chokepoint section
//                                                builders (panel vs badge split)
//   partitionOldSessions                         the per-device liveInboxIds
//                                                counting gate
//   liftQuestions                                the client-only question pass
//                                                (now the `questions` bucket)
//
// If this fails on new code, call placeInboxRows (or read its returned
// sections/placements/tally) — do not re-create a classifier.

// The deleted classifiers, and the deleted per-row chain (sync-convergence
// C3: `isSessionWaitingForInput` / `sessionRestState` / `isSessionHardWaiting`
// were deleted, not wrapped — classifySession is a thin adapter over the
// shared work state).
const BANNED = /\b(categorizeSessions|categorizeMineSessions|partitionOldSessions|liftQuestions|isSessionWaitingForInput|sessionRestState|isSessionHardWaiting)\b/;

const offendersIn = (root: string, dirs: string[]) => offendersUnder(root, dirs, BANNED);

describe("the deleted classifiers stay deleted (placeInboxRows is the chokepoint)", () => {
  test("web: no source file references a deleted classifier", () => {
    expect(offendersIn(WEB_ROOT, ["app", "components", "hooks", "lib", "store", "src", "shortcuts", "tips"])).toEqual([]);
  }, 120_000);

  test("mobile: no source file references a deleted classifier", () => {
    expect(offendersIn(MOBILE_ROOT, ["app", "components", "lib", "hooks"])).toEqual([]);
  }, 120_000);

  test("the chokepoint itself exists and exports the placed sections", () => {
    const store = readFileSync(join(WEB_ROOT, "store", "inboxStore.ts"), "utf8");
    expect(store).toContain("export function placeInboxRows(");
    for (const section of ["questions", "pinned", "newSessions", "needsInput", "done", "dormant", "working", "stashed", "dismissed"]) {
      expect(store.includes(`${section}:`)).toBe(true);
    }
  });
});
