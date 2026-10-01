import { describe, expect, test } from "bun:test";
import { nextSlackMembers, slackMemberWriter } from "./slackMirror";

describe("slackMemberWriter", () => {
  test("the app writes once it holds the manage scope for that kind of channel", () => {
    expect(slackMemberWriter({ isPrivate: false, botScopes: "chat:write,channels:manage" })).toBe("bot");
    expect(slackMemberWriter({ isPrivate: true, botScopes: "channels:manage" })).toBe(null);
    expect(slackMemberWriter({ isPrivate: true, botScopes: "groups:write" })).toBe("bot");
  });
  test("a person's own groups:write covers private channels only", () => {
    expect(slackMemberWriter({ isPrivate: true, botScopes: "chat:write", userScopes: "groups:read,groups:write" })).toBe("user");
    expect(slackMemberWriter({ isPrivate: false, botScopes: "chat:write", userScopes: "groups:write" })).toBe(null);
  });
});

describe("nextSlackMembers", () => {
  test("returns the same array when nothing changes", () => {
    const ids = ["A", "B"];
    expect(nextSlackMembers(ids, { add: "A" }, 10)).toBe(ids);
    expect(nextSlackMembers(ids, { remove: "Z" }, 10)).toBe(ids);
    expect(nextSlackMembers(ids, { add: "C" }, 2)).toBe(ids);
  });
  test("adds, removes, and dedupes a whole read under the cap", () => {
    expect(nextSlackMembers(["A"], { add: "B" }, 10)).toEqual(["A", "B"]);
    expect(nextSlackMembers(["A", "B"], { remove: "A" }, 10)).toEqual(["B"]);
    expect(nextSlackMembers([], { set: ["A", "A", "B", "C"] }, 2)).toEqual(["A", "B"]);
  });
});
