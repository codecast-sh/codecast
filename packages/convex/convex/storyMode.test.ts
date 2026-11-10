import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { STALE_AFTER, getCachedStory } from "./storyMode";

// A summary is built from the story's beats, so it is stamped with the message
// count those beats were built at, never the session's count at summary time.

const ME = "users_me";
const beats = JSON.stringify([{ heading: "h", body: "b" }]);

function ctx(messageCount: number, builtAt: number | undefined) {
  return {
    db: makeFakeDb({
      users: [{ _id: ME }],
      conversations: [{ _id: "conv_1", user_id: ME, is_private: true, message_count: messageCount }],
      conversation_summaries: builtAt === undefined ? [] : [{ _id: "sum_1", conversation_id: "conv_1", story: beats, story_message_count: builtAt }],
      session_owners: [],
      team_memberships: [],
    }),
  } as any;
}
const read = (c: any, user = ME) => (getCachedStory as any)._handler(c, { conversation_id: "conv_1", user_id: user });

describe("storyMode.getCachedStory", () => {
  test("reports the count the beats were built at and that they are behind", async () => {
    const r = await read(ctx(100 + STALE_AFTER, 100));
    expect(r.message_count).toBe(100);
    expect(r.stale).toBe(true);
  });

  test("beats that cover the session are not stale", async () => {
    const r = await read(ctx(103, 100));
    expect(r).toMatchObject({ message_count: 100, stale: false });
    expect(r.beats).toHaveLength(1);
  });

  test("no story yet is stale, and another user reads nothing", async () => {
    expect(await read(ctx(5, undefined))).toMatchObject({ beats: [], stale: true });
    expect(await read(ctx(5, 5), "users_other")).toBeNull();
  });
});
