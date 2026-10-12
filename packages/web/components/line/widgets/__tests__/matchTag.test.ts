import { describe, expect, test } from "bun:test";
import { matchTag } from "../MomentView";

describe("matchTag", () => {
  test("lifts the match a message is about out of its body", () => {
    expect(matchTag("[About the match with Gustavo Arancibia (match 1ec8198d)]\nHi Carlos, ...")).toEqual({ match: "Gustavo Arancibia", id: "1ec8198d", rest: "Hi Carlos, ..." });
  });
  test("leaves a message about no match as it is", () => {
    expect(matchTag("Hi Carlos")).toEqual({ match: null, id: null, rest: "Hi Carlos" });
  });
});
