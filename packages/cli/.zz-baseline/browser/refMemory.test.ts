/**
 * Stale-ref recovery: which element the retry lands on.
 *
 * The wrong answer here is silent and destructive — recovering the third
 * row's "Delete" onto the first row's "Delete" deletes the wrong thing and
 * reports success. So the choice is a pure function, pinned by test.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isolateCodecastDir, type IsolatedCodecastDir } from "../test-helpers/codecastDir.js";
import {
  isStaleRefFailure, recallSnapshotRef, recoverRefPlan, rememberSnapshotRefs, type SnapshotRefEntry,
} from "./refMemory.js";

const rows = (refs: string[]): SnapshotRefEntry[] =>
  refs.map((ref, i) => ({ ref, role: "button", name: "Delete", nth: i + 1 }));

describe("recoverRefPlan", () => {
  test("takes the namesake at the same ordinal, not the first one", () => {
    const was = { role: "button", name: "Delete", nth: 3 };
    expect(recoverRefPlan(was, rows(["e7", "e8", "e9"]))).toBe("e9");
  });

  test("a unique name has no ordinal and takes the only match", () => {
    const fresh = [
      { ref: "e2", role: "button", name: "Save" },
      { ref: "e3", role: "link", name: "Save" },
    ];
    expect(recoverRefPlan({ role: "link", name: "Save" }, fresh)).toBe("e3");
  });

  test("a list that got shorter falls back to the first namesake", () => {
    // Better to act on a plausible neighbour than to report a dead ref for a
    // row the agent can still see.
    expect(recoverRefPlan({ role: "button", name: "Delete", nth: 3 }, rows(["e7", "e8"]))).toBe("e7");
  });

  test("no namesake at all, and nothing remembered, both give up", () => {
    expect(recoverRefPlan({ role: "button", name: "Delete", nth: 1 }, [])).toBeNull();
    expect(recoverRefPlan(null, rows(["e7"]))).toBeNull();
  });

  test("role is part of the identity", () => {
    const fresh = [{ ref: "e4", role: "link", name: "Delete" }];
    expect(recoverRefPlan({ role: "button", name: "Delete" }, fresh)).toBeNull();
  });
});

describe("isStaleRefFailure", () => {
  test("recognises the engine's own wording for an unresolvable ref", () => {
    // Verbatim from agent-browser 0.34.0, observed on a re-rendering list.
    expect(isStaleRefFailure("✗ Could not locate element with role=button name=Delete")).toBe(true);
    expect(isStaleRefFailure("✗ Unknown ref: e5")).toBe(true);
    expect(isStaleRefFailure("Element not found: @e5")).toBe(true);
    expect(isStaleRefFailure("No objectId for ref e5")).toBe(true);
  });

  test("a failure that could have touched the page is not a stale ref", () => {
    // The retry re-runs the command, so anything else must not qualify or a
    // half-done click gets clicked twice.
    expect(isStaleRefFailure("navigation timed out after 30s")).toBe(false);
    expect(isStaleRefFailure("tab_gone")).toBe(false);
    expect(isStaleRefFailure("")).toBe(false);
  });
});

describe("the remembered table", () => {
  let home: IsolatedCodecastDir;
  beforeEach(() => {
    home = isolateCodecastDir("cast-refmem-");
  });
  afterEach(() => home.restore());

  test("round-trips a ref's tuple, with or without the @", () => {
    rememberSnapshotRefs("s1", rows(["e7", "e8", "e9"]));
    expect(recallSnapshotRef("s1", "e8")).toEqual({ role: "button", name: "Delete", nth: 2 });
    expect(recallSnapshotRef("s1", "@e8")).toEqual({ role: "button", name: "Delete", nth: 2 });
  });

  test("a unique name is stored without an ordinal", () => {
    rememberSnapshotRefs("s1", [{ ref: "e2", role: "button", name: "Save" }]);
    expect(recallSnapshotRef("s1", "e2")).toEqual({ role: "button", name: "Save" });
  });

  test("each browser session remembers its own page", () => {
    rememberSnapshotRefs("s1", rows(["e7"]));
    expect(recallSnapshotRef("s2", "e7")).toBeNull();
  });

  test("a later snapshot replaces the table outright", () => {
    rememberSnapshotRefs("s1", rows(["e7", "e8"]));
    rememberSnapshotRefs("s1", [{ ref: "e7", role: "link", name: "Home" }]);
    expect(recallSnapshotRef("s1", "e7")).toEqual({ role: "link", name: "Home" });
    expect(recallSnapshotRef("s1", "e8")).toBeNull();
  });

  test("no table yet is a miss, not a throw", () => {
    expect(recallSnapshotRef("never-snapshotted", "e1")).toBeNull();
  });
});
