import { beforeEach, describe, expect, test } from "bun:test";
import { selectionGesture, useInboxSelection } from "./inboxSelection";

// The inbox multi-selection: toggle, shift-range over screen order, clear.

const order = ["a", "b", "c", "d", "e"];

beforeEach(() => useInboxSelection.getState().clear());

describe("useInboxSelection", () => {
  test("toggle adds, toggles off, and moves the anchor", () => {
    const sel = useInboxSelection.getState();
    sel.toggle("b");
    sel.toggle("d");
    expect(useInboxSelection.getState().ids).toEqual(["b", "d"]);
    expect(useInboxSelection.getState().anchorId).toBe("d");
    useInboxSelection.getState().toggle("b");
    expect(useInboxSelection.getState().ids).toEqual(["d"]);
  });

  test("range selects the run between the anchor and the click, either direction, keeping earlier picks", () => {
    useInboxSelection.getState().toggle("b");
    useInboxSelection.getState().range("d", order);
    expect(useInboxSelection.getState().ids).toEqual(["b", "c", "d"]);
    // Anchor stays put, so a second shift-click re-ranges from the same spot.
    useInboxSelection.getState().range("a", order);
    expect(useInboxSelection.getState().ids).toEqual(["b", "c", "d", "a"]);
    expect(useInboxSelection.getState().anchorId).toBe("b");
  });

  test("a plain click sets the anchor without selecting; a later shift-click ranges from it", () => {
    useInboxSelection.setState({ anchorId: "c" });
    expect(useInboxSelection.getState().ids).toEqual([]);
    useInboxSelection.getState().range("e", order);
    expect(useInboxSelection.getState().ids).toEqual(["c", "d", "e"]);
  });

  test("a range with no usable anchor just adds the clicked card", () => {
    useInboxSelection.getState().range("c", order);
    expect(useInboxSelection.getState().ids).toEqual(["c"]);
    useInboxSelection.getState().range("zzz", order);
    expect(useInboxSelection.getState().ids).toEqual(["c", "zzz"]);
  });

  test("clear empties everything", () => {
    useInboxSelection.getState().set(["a", "b"]);
    useInboxSelection.getState().clear();
    expect(useInboxSelection.getState()).toMatchObject({ ids: [], anchorId: null });
  });
});

describe("selectionGesture", () => {
  const ev = (o: Partial<{ metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }>) => ({ metaKey: false, ctrlKey: false, shiftKey: false, ...o });
  test("shift ranges, meta/ctrl toggles, plain is not a gesture", () => {
    expect(selectionGesture(ev({ shiftKey: true }))).toBe("range");
    expect(selectionGesture(ev({ metaKey: true }))).toBe("toggle");
    expect(selectionGesture(ev({ ctrlKey: true }))).toBe("toggle");
    expect(selectionGesture(ev({ shiftKey: true, metaKey: true }))).toBe("range");
    expect(selectionGesture(ev({}))).toBeNull();
  });
});
