// @ts-nocheck
import { describe, expect, it } from "bun:test";
import { activeViewId, currentViewId, isViewActive, isViewDirty, prefsForSaving, significantPrefs, VIEW_ID_KEY } from "../savedViews";

describe("significantPrefs", () => {
  it("drops every shape of 'not set' so they compare equal", () => {
    expect(significantPrefs({ status: "", label: undefined, source: null, hide_agent: false }))
      .toEqual({});
  });

  it("drops presentation-only fields", () => {
    expect(significantPrefs({ status: "open", view: "kanban", dir: "asc" }))
      .toEqual({ status: "open" });
  });

  it("normalises values so a boolean and its string compare equal", () => {
    expect(significantPrefs({ hide_agent: true })).toEqual({ hide_agent: "true" });
  });
});

describe("isViewActive", () => {
  it("matches a view whose filters are exactly what the list is showing", () => {
    expect(isViewActive({ status: "open", group: "assignee" }, { status: "open", group: "assignee" }))
      .toBe(true);
  });

  it("ignores unset fields on either side", () => {
    expect(isViewActive({ status: "open", label: "" }, { status: "open" })).toBe(true);
    expect(isViewActive({ status: "open" }, { status: "open", label: undefined })).toBe(true);
  });

  it("stays selected when only the presentation changed", () => {
    // Flipping to the board or reversing the sort is still the same view.
    expect(isViewActive({ status: "open" }, { status: "open", view: "kanban", dir: "desc" }))
      .toBe(true);
  });

  it("deselects once you narrow past the view", () => {
    expect(isViewActive({ status: "open" }, { status: "open", label: "bug" })).toBe(false);
  });

  it("deselects when the view asks for more than the list is doing", () => {
    expect(isViewActive({ status: "open", label: "bug" }, { status: "open" })).toBe(false);
  });

  it("deselects on a different value for the same filter", () => {
    expect(isViewActive({ status: "open" }, { status: "done" })).toBe(false);
  });

  it("matches an empty view only against an empty list", () => {
    // Otherwise a filter-less view would light up on every screen.
    expect(isViewActive({}, {})).toBe(true);
    expect(isViewActive({}, { status: "open" })).toBe(false);
    expect(isViewActive(undefined, undefined)).toBe(true);
  });
});

describe("activeViewId", () => {
  const views = [
    { id: "a", prefs: { status: "open" } },
    { id: "b", prefs: { status: "done" } },
    { id: "c", prefs: { status: "open" } },
  ];

  it("names the view the list is showing", () => {
    expect(activeViewId(views, { status: "done" })).toBe("b");
  });

  it("returns nothing when the list matches no saved view", () => {
    expect(activeViewId(views, { status: "backlog" })).toBeUndefined();
  });

  it("picks the first of two identical views, so the choice is stable", () => {
    expect(activeViewId(views, { status: "open" })).toBe("a");
  });
});

describe("view identity", () => {
  it("reads the view a list was opened from", () => {
    expect(currentViewId({ [VIEW_ID_KEY]: "v1", status: "open" })).toBe("v1");
    expect(currentViewId({ status: "open" })).toBeUndefined();
    expect(currentViewId({ [VIEW_ID_KEY]: "" })).toBeUndefined();
  });

  it("never lets the stamp affect matching — a view opens clean, not dirty", () => {
    const view = { _id: "v1", prefs: { status: "open" } };
    expect(isViewActive(view.prefs, { [VIEW_ID_KEY]: "v1", status: "open" })).toBe(true);
    expect(isViewDirty(view, { [VIEW_ID_KEY]: "v1", status: "open" })).toBe(false);
  });

  it("goes dirty as soon as a filter drifts from the view", () => {
    const view = { _id: "v1", prefs: { status: "open" } };
    expect(isViewDirty(view, { [VIEW_ID_KEY]: "v1", status: "open", label: "bug" })).toBe(true);
    expect(isViewDirty(view, { [VIEW_ID_KEY]: "v1", status: "done" })).toBe(true);
  });

  it("stays clean when only the presentation changed", () => {
    const view = { _id: "v1", prefs: { status: "open" } };
    expect(isViewDirty(view, { [VIEW_ID_KEY]: "v1", status: "open", view: "kanban" })).toBe(false);
  });

  it("reports no view as never dirty, so callers need no special case", () => {
    expect(isViewDirty(undefined, { status: "open" })).toBe(false);
  });
});

describe("prefsForSaving", () => {
  it("strips the identity stamp so a view never stores a pointer to itself", () => {
    expect(prefsForSaving({ [VIEW_ID_KEY]: "v1", status: "open" })).toEqual({ status: "open" });
  });

  it("drops unset fields so a saved view carries only real filters", () => {
    expect(prefsForSaving({ status: "open", label: "", priority: undefined })).toEqual({ status: "open" });
  });

  it("keeps presentation, which is part of how a view should look when reopened", () => {
    // Presentation is ignored when COMPARING, but a view still restores it.
    expect(prefsForSaving({ status: "open", view: "kanban", dir: "asc" }))
      .toEqual({ status: "open", view: "kanban", dir: "asc" });
  });
});
