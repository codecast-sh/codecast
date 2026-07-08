import { test, expect, describe } from "bun:test";
import { focusedActionSessionId } from "./actions";

// Regression guard for "kill in Stashed killed a different session above it":
// selecting a stashed/dismissed session on the inbox page opens it as a
// view-only peek (viewingDismissedId) and leaves currentSessionId on the last
// live session. The kill/stash/defer/pin/rename/label chords used to act on
// currentSessionId, so the chord tore down the live session behind the peek
// instead of the hidden one the user saw highlighted. The chord target must be
// viewingDismissedId ?? currentSessionId on the inbox page (mirrors
// sessionListActiveId in DashboardLayout).
describe("focusedActionSessionId", () => {
  const state = (over: Partial<Record<"currentSessionId" | "viewingDismissedId" | "sidePanelSessionId", string | null>>) => ({
    currentSessionId: null,
    viewingDismissedId: null,
    sidePanelSessionId: null,
    ...over,
  });

  test("inbox: peeking a stashed session targets the peek, not the live session behind it", () => {
    const s = state({ currentSessionId: "live-working", viewingDismissedId: "stashed-peek" });
    expect(focusedActionSessionId(s, true)).toBe("stashed-peek");
  });

  test("inbox: no peek open targets the current session", () => {
    const s = state({ currentSessionId: "live-working" });
    expect(focusedActionSessionId(s, true)).toBe("live-working");
  });

  test("off the inbox: targets the side panel selection", () => {
    const s = state({ currentSessionId: "live-working", viewingDismissedId: "stashed-peek", sidePanelSessionId: "panel-sel" });
    expect(focusedActionSessionId(s, false)).toBe("panel-sel");
  });

  test("nothing selected resolves falsy so chords no-op", () => {
    expect(focusedActionSessionId(state({}), true)).toBeFalsy();
    expect(focusedActionSessionId(state({}), false)).toBeFalsy();
  });
});
