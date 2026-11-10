import { describe, expect, test } from "bun:test";
import { bookmarkUrl } from "./bookmarks";

describe("a listed bookmark's link", () => {
  test("a shared conversation opens at its share link", () => {
    expect(bookmarkUrl({ _id: "conv_1", share_token: "tok" }, 4)).toBe("https://codecast.sh/share/tok#msg-4");
  });
  test("one with no share link opens at its own page, never /share/<session id>", () => {
    const url = bookmarkUrl({ _id: "conv_1", session_id: "sess-uuid" } as any, 2);
    expect(url).toBe("https://codecast.sh/conversation/conv_1#msg-2");
    expect(url).not.toContain("sess-uuid");
  });
});
