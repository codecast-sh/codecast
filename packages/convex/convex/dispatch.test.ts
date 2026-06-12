import { describe, expect, test } from "bun:test";
import { classifyHideTransition } from "./dispatch";

// The conversation hide-transition hook in applyPatches is the ONE place the
// "dismiss = kill, stash = keep alive" contract is enforced — every dismiss
// path (chord, palette, card button, /sessions toggle) funnels its patch
// through it. These tests pin the decision matrix.
describe("classifyHideTransition", () => {
  test("a patch with neither hide flag is inert", () => {
    expect(classifyHideTransition({}, {}, false)).toBe("none");
    expect(classifyHideTransition({ title: "x" } as any, {}, true)).toBe("none");
  });

  test("undo (flags cleared to null/undefined) never reaps or kills", () => {
    expect(classifyHideTransition({ inbox_dismissed_at: undefined, inbox_stashed_at: undefined }, {}, false)).toBe("none");
  });

  test("hiding an EMPTY conversation reaps it — dismissed or stashed alike", () => {
    expect(classifyHideTransition({ inbox_dismissed_at: 111 }, {}, true)).toBe("reap");
    expect(classifyHideTransition({ inbox_stashed_at: 111 }, {}, true)).toBe("reap");
  });

  test("dismissing a conversation with real work kills the agent", () => {
    expect(classifyHideTransition({ inbox_dismissed_at: 111 }, {}, false)).toBe("kill");
  });

  test("stashing a conversation with real work does NOT kill — the whole point of stash", () => {
    expect(classifyHideTransition({ inbox_stashed_at: 111 }, {}, false)).toBe("none");
  });

  test("a re-asserted dismiss (already dismissed pre-patch) does not re-kill", () => {
    expect(classifyHideTransition({ inbox_dismissed_at: 222 }, { inbox_dismissed_at: 111 }, false)).toBe("none");
  });

  test("dismissing a previously-stashed session kills (stash is no shield once you dismiss)", () => {
    expect(classifyHideTransition({ inbox_dismissed_at: 222, inbox_stashed_at: null }, { inbox_dismissed_at: null }, false)).toBe("kill");
  });
});
