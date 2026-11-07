/**
 * Stale-ref recovery: which element the retry lands on.
 *
 * The wrong answer here is silent and destructive — recovering the third
 * row's "Delete" onto the first row's "Delete" deletes the wrong thing and
 * reports success. So the choice is a pure function, pinned by test, and it
 * refuses whenever the coordinate the ref was minted with is not certain.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isolateCodecastDir, type IsolatedCodecastDir } from "../test-helpers/codecastDir.js";
import type { PageStamp, SettleProbe } from "./snapshotSettle.js";
import {
  isStaleRefFailure, preflightRefPlan, recallSnapshotRef, recoverRefPlan, rememberedSnapshotUrl, rememberSnapshotRefs, SNAPSHOT_AGAIN, type SnapshotRefEntry,
} from "./refMemory.js";

const rows = (refs: string[]): SnapshotRefEntry[] =>
  refs.map((ref, i) => ({ ref, role: "button", name: "Delete", nth: i + 1 }));

describe("recoverRefPlan", () => {
  const url = "https://app.test/list";
  const was = (nth: number | undefined, of?: number) => ({ role: "button", name: "Delete", nth, of, url });

  test("takes the namesake at the same ordinal, not the first one", () => {
    expect(recoverRefPlan(was(3, 3), rows(["e7", "e8", "e9"]), url)).toEqual({ ref: "e9" });
  });

  test("a unique name has no ordinal and takes the only match", () => {
    const fresh = [
      { ref: "e2", role: "button", name: "Save" },
      { ref: "e3", role: "link", name: "Save" },
    ];
    expect(recoverRefPlan({ role: "link", name: "Save", url }, fresh, url)).toEqual({ ref: "e3" });
  });

  test("a list that got shorter refuses instead of acting on a neighbour", () => {
    // Row 1 deleted: the 3rd namesake is gone and every ordinal after the
    // deleted row moved. The first namesake is a different row.
    const plan = recoverRefPlan(was(3, 3), rows(["e7", "e8"]), url);
    expect("refused" in plan && plan.refused).toMatch(/now has 2 .* where the snapshot had 3.*snapshot/);
  });

  test("a list that grew refuses too, even though the nth namesake exists", () => {
    // A row inserted above shifts the ordinal onto the wrong row.
    const plan = recoverRefPlan(was(2, 3), rows(["e7", "e8", "e9", "e10"]), url);
    expect("refused" in plan).toBe(true);
  });

  test("a unique name that became ambiguous refuses", () => {
    const plan = recoverRefPlan({ role: "button", name: "Delete", url }, rows(["e7", "e8"]), url);
    expect("refused" in plan).toBe(true);
  });

  test("a changed URL refuses, whatever the page now holds", () => {
    const plan = recoverRefPlan(was(1, 1), rows(["e7"]), "https://app.test/other");
    expect("refused" in plan && plan.refused).toMatch(/page changed .*app\.test\/list → https:\/\/app\.test\/other/);
  });

  test("an unknown URL on either side refuses (old tables carry none)", () => {
    expect("refused" in recoverRefPlan({ ...was(1, 1), url: null }, rows(["e7"]), url)).toBe(true);
    expect("refused" in recoverRefPlan(was(1, 1), rows(["e7"]), null)).toBe(true);
  });

  test("no namesake at all, and nothing remembered, both refuse", () => {
    expect("refused" in recoverRefPlan(was(1, 1), [], url)).toBe(true);
    expect("refused" in recoverRefPlan(null, rows(["e7"]), url)).toBe(true);
  });

  test("role is part of the identity", () => {
    const fresh = [{ ref: "e4", role: "link", name: "Delete" }];
    expect("refused" in recoverRefPlan({ role: "button", name: "Delete", url }, fresh, url)).toBe(true);
  });

  test("every refusal tells the agent to snapshot again", () => {
    for (const plan of [recoverRefPlan(null, [], url), recoverRefPlan(was(1, 1), [], "x"), recoverRefPlan(was(3, 3), rows(["e1"]), url)]) {
      expect("refused" in plan && plan.refused).toContain(SNAPSHOT_AGAIN);
    }
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

const stamp = (url: string): PageStamp => ({ url, doc: "d1", at: 1000 });

describe("the remembered table", () => {
  let home: IsolatedCodecastDir;
  beforeEach(() => {
    home = isolateCodecastDir("cast-refmem-");
  });
  afterEach(() => home.restore());

  test("round-trips a ref's tuple, with or without the @", () => {
    rememberSnapshotRefs("s1", rows(["e7", "e8", "e9"]), stamp("https://a.test/"));
    const want = { role: "button", name: "Delete", nth: 2, of: 3, url: "https://a.test/", doc: "d1", at: 1000 };
    expect(recallSnapshotRef("s1", "e8")).toEqual(want);
    expect(recallSnapshotRef("s1", "@e8")).toEqual(want);
    expect(rememberedSnapshotUrl("s1")).toBe("https://a.test/");
  });

  test("a unique name is stored without an ordinal", () => {
    rememberSnapshotRefs("s1", [{ ref: "e2", role: "button", name: "Save" }], null);
    expect(recallSnapshotRef("s1", "e2")).toEqual({ role: "button", name: "Save", url: null });
  });

  test("each browser session remembers its own page", () => {
    rememberSnapshotRefs("s1", rows(["e7"]), null);
    expect(recallSnapshotRef("s2", "e7")).toBeNull();
  });

  test("a later snapshot replaces the table outright", () => {
    rememberSnapshotRefs("s1", rows(["e7", "e8"]), stamp("https://a.test/"));
    rememberSnapshotRefs("s1", [{ ref: "e7", role: "link", name: "Home" }], stamp("https://b.test/"));
    expect(recallSnapshotRef("s1", "e7")).toEqual({ role: "link", name: "Home", url: "https://b.test/", doc: "d1", at: 1000 });
    expect(recallSnapshotRef("s1", "e8")).toBeNull();
  });

  test("no table yet is a miss, not a throw", () => {
    expect(recallSnapshotRef("never-snapshotted", "e1")).toBeNull();
  });
});

describe("checking a ref before acting on it", () => {
  // The engine does not fail on a ref whose node is gone: it acts on whatever
  // holds the ref's position now. On the rig's Delete list that deleted the
  // next row and reported success.
  const third = { role: "button", name: "Delete", nth: 3, of: 4, url: "https://a.test/", doc: "d1", at: 1000 };
  const save = { role: "button", name: "Save", url: "https://a.test/", doc: "d1", at: 1000 };
  const probe = (p: Partial<SettleProbe> = {}): SettleProbe => ({
    url: "https://a.test/", sinceLoad: 2000, sinceMutation: 5, doc: "d1", treeAt: -1, hidden: [], ...p,
  });

  test("passes on the same document with no element added or removed", () => {
    expect(preflightRefPlan(third, probe({ treeAt: 900 }))).toBeNull();
  });

  test("refuses a namesake once an element was added or removed after the snapshot", () => {
    expect(preflightRefPlan(third, probe({ treeAt: 1500 }))?.refused).toContain(SNAPSHOT_AGAIN);
  });

  test("refuses a namesake when the element clock cannot tell", () => {
    expect(preflightRefPlan(third, probe({ treeAt: null }))?.refused).toContain(SNAPSHOT_AGAIN);
  });

  test("a unique name survives mutations: re-resolving it lands on the same control", () => {
    expect(preflightRefPlan(save, probe({ treeAt: 1500 }))).toBeNull();
  });

  test("refuses any ref after a reload of the same URL, and after the URL moved", () => {
    expect(preflightRefPlan(save, probe({ doc: "d2" }))?.refused).toMatch(/navigated or reloaded/);
    expect(preflightRefPlan(save, probe({ url: "https://a.test/next" }))?.refused).toMatch(/page changed/);
  });

  test("an unknown ref, an old table without a stamp, or an unreadable page is left to the engine", () => {
    expect(preflightRefPlan(null, probe())).toBeNull();
    expect(preflightRefPlan({ role: "button", name: "Delete", nth: 3, of: 4, url: "https://a.test/" }, probe({ treeAt: 1500 }))).toBeNull();
    expect(preflightRefPlan(third, null)).toBeNull();
  });
});
