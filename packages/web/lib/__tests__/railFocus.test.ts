// The focused rail (lib/railFocus.ts): who is offered it, when it is on, and
// which rows it folds away. Pages themselves are never hidden: the palette
// and links still reach them.
import { describe, expect, test } from "bun:test";
import { RAIL_FOCUS_SINCE, focusHidesPage, railFocusOffered, railFocused } from "../railFocus";

const NEW = RAIL_FOCUS_SINCE + 1;
const facts = (over: Partial<Parameters<typeof railFocused>[0]> = {}) => ({ createdAt: NEW, teams: [], everything: undefined, ...over });

describe("who gets it", () => {
  test("a new solo developer account starts focused", () => {
    expect(railFocusOffered(facts())).toBe(true);
    expect(railFocused(facts())).toBe(true);
    // A one-person team is still solo.
    expect(railFocused(facts({ teams: [{ member_count: 1 }] }))).toBe(true);
  });

  test("More keeps everything, Fewer folds it again", () => {
    expect(railFocused(facts({ everything: true }))).toBe(false);
    expect(railFocusOffered(facts({ everything: true }))).toBe(true);
    expect(railFocused(facts({ everything: false }))).toBe(true);
  });

  test("a team with someone else, older accounts and an unknown creation time keep the full rail", () => {
    expect(railFocusOffered(facts({ teams: [{ member_count: 1 }, { member_count: 3 }] }))).toBe(false);
    expect(railFocusOffered(facts({ teams: [{ memberCount: 2 }] }))).toBe(false);
    expect(railFocusOffered(facts({ createdAt: RAIL_FOCUS_SINCE - 1 }))).toBe(false);
    expect(railFocusOffered(facts({ createdAt: undefined }))).toBe(false);
  });
});

describe("what it folds", () => {
  test("the team and fleet pages go to More", () => {
    for (const path of ["/threads", "/feed", "/goals", "/projects", "/projects/abc", "/org", "/repo", "/files", "/vault", "/pages", "/changes", "/triggers", "/flows"]) expect(focusHidesPage(path)).toBe(true);
  });

  test("the inbox, tasks and docs stay", () => {
    for (const path of ["/inbox", "/tasks", "/docs", "/decisions"]) expect(focusHidesPage(path)).toBe(false);
  });
});
