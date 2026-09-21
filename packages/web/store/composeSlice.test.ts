import { describe, expect, test } from "bun:test";
import { createComposeSlice, type ComposeSliceState } from "./composeSlice";

type State = ComposeSliceState & { drafts: Record<string, any> };
function makeStore(): State {
  const state = { drafts: {} } as State;
  Object.assign(state, createComposeSlice((patch: Partial<State>) => Object.assign(state, patch), () => state));
  return state;
}
const shape = (s: State) => s.composes.map((c) => `${c.id}:${c.mode}${c.collapsed ? ":collapsed" : ""}`);

describe("compose slice", () => {
  test("the dock shortcut opens docked composers side by side, then minimizes an open modal", () => {
    const s = makeStore();
    s.toggleComposeDock();
    s.toggleComposeDock();
    expect(shape(s)).toEqual(["1:dock", "2:dock"]);
    s.openCompose();
    s.toggleComposeDock();
    expect(shape(s)).toEqual(["1:dock", "2:dock", "3:dock"]);
  });

  test("a third docked composer folds the oldest open one", () => {
    const s = makeStore();
    for (let i = 0; i < 3; i++) s.openCompose(undefined, undefined, { dock: true });
    expect(shape(s)).toEqual(["1:dock:collapsed", "2:dock", "3:dock"]);
  });

  test("a new modal keeps a displaced modal's draft in the dock and drops an empty one", () => {
    const s = makeStore();
    s.openCompose();
    s.openCompose();
    expect(shape(s)).toEqual(["2:modal"]);
    s.bindComposeStub(2, "stub-2");
    s.drafts["stub-2"] = { draft_message: "fix the flaky test" };
    s.openCompose("seeded");
    expect(shape(s)).toEqual(["2:dock:collapsed", "3:modal"]);
    expect(s.composes[1].initialQuery).toBe("seeded");
  });

  test("expanding a dock keeps sibling order, and closeCompose with no id closes the modal", () => {
    const s = makeStore();
    s.toggleComposeDock();
    s.toggleComposeDock();
    s.expandCompose(1);
    expect(shape(s)).toEqual(["1:modal", "2:dock"]);
    s.closeCompose();
    expect(shape(s)).toEqual(["2:dock"]);
    s.closeCompose(2);
    expect(shape(s)).toEqual([]);
  });
});
