import { describe, expect, test } from "bun:test";
import { InvalidArgumentError } from "commander";
import { countOption, nonNegativeCountOption, stateOption, unknownActionError, withSessionIdHint, SESSION_ID_HINT } from "./argChecks";

describe("countOption", () => {
  test("takes a whole number of 1 or more", () => {
    expect(countOption("5")).toBe(5);
    expect(countOption("200")).toBe(200);
  });
  test("refuses what the server would reject with a validator dump", () => {
    for (const bad of ["abc", "0", "-3", "2.5", "", "5x"]) {
      expect(() => countOption(bad)).toThrow(InvalidArgumentError);
    }
  });
});

describe("nonNegativeCountOption", () => {
  test("allows 0 for context windows", () => {
    expect(nonNegativeCountOption("0")).toBe(0);
    expect(() => nonNegativeCountOption("x")).toThrow(InvalidArgumentError);
  });
});

describe("stateOption", () => {
  test("passes every value the server's filter knows, aliases included", () => {
    for (const ok of ["needs-input", "needs_input", "done", "working", "dormant", "hibernated", "idle", "pinned", "live", "blocked", "parked"]) {
      expect(stateOption(ok)).toBe(ok);
    }
  });
  test("all clears the filter", () => {
    expect(stateOption("all")).toBeUndefined();
    expect(stateOption("ALL")).toBeUndefined();
  });
  test("refuses a value the server would read as no filter, naming the valid ones", () => {
    expect(() => stateOption("bogus")).toThrow(/needs-input, done, working, dormant/);
  });
});

describe("unknownActionError", () => {
  test("is null for a known or absent action", () => {
    expect(unknownActionError("decisions", undefined, ["add", "delete"])).toBeNull();
    expect(unknownActionError("decisions", "add", ["add", "delete"])).toBeNull();
  });
  test("names the actions and suggests the near one", () => {
    const msg = unknownActionError("decisions", "ad", ["add", "delete"])!;
    expect(msg.split("\n")).toEqual([
      "error: unknown command 'ad'",
      "Next step: did you mean 'cast decisions add'?",
      "Commands: add, delete (omit it to list). Run 'cast decisions --help' for each.",
    ]);
  });
  test("offers no suggestion for a word near nothing", () => {
    expect(unknownActionError("learn", "zzzzzzzz", ["add", "show"])).not.toContain("did you mean");
  });
});

describe("withSessionIdHint", () => {
  test("adds where to find ids to a not-found error only", () => {
    expect(withSessionIdHint("Conversation not found")).toBe(`Conversation not found. ${SESSION_ID_HINT}`);
    expect(withSessionIdHint("Unauthorized")).toBe("Unauthorized");
  });

  // `cast read jx77txf 1:2` printed a bare "Error: Access denied".
  test("says why access is denied and what to do", () => {
    expect(withSessionIdHint("Access denied")).toContain("private to its owner, or in a team you are not a member of");
  });
});
