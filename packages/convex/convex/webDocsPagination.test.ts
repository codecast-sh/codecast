import { describe, expect, test } from "bun:test";
import {
  WEB_DOCS_MAX_PAGE,
  clampWebDocsPageSize,
  resolveWebDocsTeamId,
  webDocsNeedsUserDoc,
} from "./webDocsPagination";

// These two invariants are the backend lever against the "addMessages 60s
// timeout under saturation" failure. They must not silently regress:
//  1. webListPaginated must NOT read the hot, heartbeat-churned user doc when the
//     caller pinned a workspace — otherwise the subscription invalidates on every
//     daemon heartbeat and starves the backend.
//  2. A page must never request more than WEB_DOCS_MAX_PAGE docs — a large page of
//     multi-MB docs blows the 64MB per-query memory cap (TooMuchMemoryCarryOver).

describe("webDocsNeedsUserDoc — hot user doc is read ONLY on the unpinned path", () => {
  // Every real web/mobile caller pins a workspace, so none of these read the user doc.
  test("team view (workspace pinned + team_id) does NOT read the user doc", () => {
    expect(webDocsNeedsUserDoc({ workspace: "team", team_id: "tm_1" })).toBe(false);
  });

  test("personal view (workspace pinned) does NOT read the user doc", () => {
    expect(webDocsNeedsUserDoc({ workspace: "personal" })).toBe(false);
  });

  test("any pinned workspace short-circuits the read even without team_id", () => {
    // Defensive: a 'team' pin with a missing team_id still must not fall through
    // to the user-doc read — it resolves to the no-team path instead.
    expect(webDocsNeedsUserDoc({ workspace: "team" })).toBe(false);
  });

  test("ONLY the unpinned caller reads the user doc", () => {
    expect(webDocsNeedsUserDoc({})).toBe(true);
    expect(webDocsNeedsUserDoc({ team_id: "tm_1" })).toBe(true);
  });
});

describe("resolveWebDocsTeamId — team resolution matches the read decision", () => {
  test("pinned team view uses the pinned team_id, never the user doc value", () => {
    expect(resolveWebDocsTeamId({ workspace: "team", team_id: "tm_pinned" }, "tm_user")).toBe(
      "tm_pinned"
    );
  });

  test("pinned personal view resolves to no team", () => {
    expect(resolveWebDocsTeamId({ workspace: "personal" }, "tm_user")).toBeUndefined();
  });

  test("unpinned caller falls back to the user doc's active_team_id", () => {
    expect(resolveWebDocsTeamId({}, "tm_user")).toBe("tm_user");
    expect(resolveWebDocsTeamId({}, undefined)).toBeUndefined();
  });
});

describe("clampWebDocsPageSize — page is capped at WEB_DOCS_MAX_PAGE", () => {
  test("the cap is 12", () => {
    expect(WEB_DOCS_MAX_PAGE).toBe(12);
  });

  test("a request larger than the cap is clamped down", () => {
    expect(clampWebDocsPageSize(100)).toBe(12);
    expect(clampWebDocsPageSize(13)).toBe(12);
  });

  test("a request at or below the cap is unchanged", () => {
    expect(clampWebDocsPageSize(12)).toBe(12);
    expect(clampWebDocsPageSize(5)).toBe(5);
    expect(clampWebDocsPageSize(1)).toBe(1);
  });
});
