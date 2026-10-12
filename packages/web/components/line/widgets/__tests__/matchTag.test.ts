import { describe, expect, test } from "bun:test";
import { matchTag } from "../MomentView";

describe("matchTag", () => {
  test("lifts the match a message is about out of its body", () => {
    expect(matchTag("[About the match with Gustavo Arancibia (match 1ec8198d)]\nHi Carlos, ...")).toEqual({ match: "Gustavo Arancibia", id: "1ec8198d", tie: "about", rest: "Hi Carlos, ..." });
  });
  test("leaves a message about no match as it is", () => {
    expect(matchTag("Hi Carlos")).toEqual({ match: null, id: null, tie: null, rest: "Hi Carlos" });
  });
  test("tells a thread that only inherits the link, and the introduction thread, from the message that set it", () => {
    expect(matchTag("[On a thread linked on 2026-10-01 to the match with Ana Ruiz (match 4dc6f42f); this message only inherits the link]\nThanks")).toMatchObject({ match: "Ana Ruiz", tie: "thread", rest: "Thanks" });
    expect(matchTag("[On the introduction thread of the match with Ana Ruiz (match 4dc6f42f), introduced 2026-10-02]\nGreat to meet")).toMatchObject({ match: "Ana Ruiz", tie: "intro", rest: "Great to meet" });
  });
});
