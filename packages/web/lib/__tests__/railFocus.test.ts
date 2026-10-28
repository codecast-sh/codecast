// The focused rail (lib/railFocus.ts): who is offered it, when it is on, and
// which rows it folds away. Pages themselves are never hidden: the palette
// and links still reach them.
import { describe, expect, test } from "bun:test";
import { RAIL_FOCUS_SINCE, focusRailMode, railFocusOffered, railFocused } from "../railFocus";
import { DEVELOPER_MODE } from "../surfaceRules";

const NEW = RAIL_FOCUS_SINCE + 1;
const facts = (over: Partial<Parameters<typeof railFocused>[0]> = {}) => ({ hosted: false, createdAt: NEW, teams: [], everything: undefined, ...over });

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

  test("a team with someone else, hosted mode, older accounts and an unknown creation time keep the full rail", () => {
    expect(railFocusOffered(facts({ teams: [{ member_count: 1 }, { member_count: 3 }] }))).toBe(false);
    expect(railFocusOffered(facts({ teams: [{ memberCount: 2 }] }))).toBe(false);
    expect(railFocusOffered(facts({ hosted: true }))).toBe(false);
    expect(railFocusOffered(facts({ createdAt: RAIL_FOCUS_SINCE - 1 }))).toBe(false);
    expect(railFocusOffered(facts({ createdAt: undefined }))).toBe(false);
  });
});

describe("what it folds", () => {
  const mode = focusRailMode(DEVELOPER_MODE);
  test("the team and fleet rows go to More", () => {
    for (const name of ["nav.threads", "nav.feed", "nav.org", "nav.agentsGroup"] as const) expect(mode.shows(name)).toBe(false);
    for (const path of ["/goals", "/projects", "/projects/abc", "/org", "/repo", "/files", "/vault", "/pages", "/changes", "/triggers", "/flows"]) expect(mode.showsPage(path)).toBe(false);
  });

  test("the inbox, tasks and docs stay, and other surfaces follow the base mode", () => {
    for (const path of ["/inbox", "/tasks", "/docs", "/questions"]) expect(mode.showsPage(path)).toBe(true);
    expect(mode.shows("terminal")).toBe(true);
    expect(mode.hosted).toBe(false);
  });
});
