import { describe, expect, test } from "bun:test";
import { buildConversationMessageMetadata } from "../useConversationMessageMetadata";

describe("buildConversationMessageMetadata", () => {
  test("counts comments per message and ignores conversation-level comments", () => {
    const metadata = buildConversationMessageMetadata({
      commentSummary: [
        { message_id: "m1" },
        { message_id: "m1" },
        { message_id: "m2" },
        {},
      ],
      bookmarkedMessageIds: [],
    });

    expect(metadata.commentCountsByMessageId.get("m1")).toBe(2);
    expect(metadata.commentCountsByMessageId.get("m2")).toBe(1);
    expect(metadata.commentCountsByMessageId.has("undefined")).toBe(false);
    expect(metadata.commentsLoaded).toBe(true);
  });

  test("normalizes bookmarked message ids into a string set", () => {
    const metadata = buildConversationMessageMetadata({
      commentSummary: [],
      bookmarkedMessageIds: ["m1", 42],
    });

    expect(metadata.bookmarkedMessageIdSet.has("m1")).toBe(true);
    expect(metadata.bookmarkedMessageIdSet.has("42")).toBe(true);
    expect(metadata.bookmarksLoaded).toBe(true);
  });

  test("keeps loading state distinct from loaded empty state", () => {
    const loading = buildConversationMessageMetadata({});
    const loadedEmpty = buildConversationMessageMetadata({
      commentSummary: [],
      bookmarkedMessageIds: [],
    });

    expect(loading.commentsLoaded).toBe(false);
    expect(loading.bookmarksLoaded).toBe(false);
    expect(loadedEmpty.commentsLoaded).toBe(true);
    expect(loadedEmpty.bookmarksLoaded).toBe(true);
  });
});
