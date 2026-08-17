import { describe, expect, test } from "bun:test";
import { linkedSessionsFor } from "./tasks";
import { makeFakeDb } from "./testDb";

// `cast task show/context` list a task's sessions by short id. The set is the
// union of the task's own `conversation_ids` (sessions that claimed it) and
// the `conversation_id` on each comment (sessions that only reported on it):
// a task filed from the web and worked by agents has an empty
// `conversation_ids` and a comment trail full of sessions, and before this
// the only way to find them was to regex `jx…` ids out of comment text.

const ME = "users_me";
const OTHER = "users_other";

const conv = (id: string, over: any = {}) => ({
  _id: id,
  user_id: ME,
  is_private: true,
  title: `Session ${id}`,
  short_id: id.slice(0, 7),
  ...over,
});
const task = (over: any = {}) => ({ _id: "tasks_x", user_id: ME, short_id: "ct-x", ...over });
const comment = (conversation_id: string | null, created_at: number) => ({ conversation_id, created_at }) as any;

function ctx(conversations: any[]) {
  return { db: makeFakeDb({ conversations, team_memberships: [] }) };
}

describe("linkedSessionsFor", () => {
  test("a task with no conversation_ids still lists the sessions that commented on it", async () => {
    const c = ctx([conv("jx7aaaa000"), conv("jx7bbbb000")]);
    const out = await linkedSessionsFor(c as any, ME as any, task(), [
      comment("jx7bbbb000", 200),
      comment(null, 150),
      comment("jx7aaaa000", 100),
    ], 10);
    expect(out.map((s) => s.short_id)).toEqual(["jx7aaaa", "jx7bbbb"]);
    expect(out[0].title).toBe("Session jx7aaaa000");
  });

  test("claimed sessions come first and a session is listed once however many comments it left", async () => {
    const c = ctx([conv("jx7aaaa000"), conv("jx7bbbb000")]);
    const out = await linkedSessionsFor(
      c as any,
      ME as any,
      task({ conversation_ids: ["jx7bbbb000"] }),
      [comment("jx7aaaa000", 1), comment("jx7bbbb000", 2), comment("jx7aaaa000", 3)],
      10,
    );
    expect(out.map((s) => s.short_id)).toEqual(["jx7bbbb", "jx7aaaa"]);
  });

  test("keeps only the newest `limit` sessions", async () => {
    const c = ctx([conv("jx7aaaa000"), conv("jx7bbbb000"), conv("jx7cccc000")]);
    const out = await linkedSessionsFor(c as any, ME as any, task(), [
      comment("jx7aaaa000", 1), comment("jx7bbbb000", 2), comment("jx7cccc000", 3),
    ], 2);
    expect(out.map((s) => s.short_id)).toEqual(["jx7bbbb", "jx7cccc"]);
  });

  test("a session the caller cannot see is left out", async () => {
    const c = ctx([conv("jx7aaaa000"), conv("jx7bbbb000", { user_id: OTHER })]);
    const out = await linkedSessionsFor(c as any, ME as any, task(), [
      comment("jx7aaaa000", 1), comment("jx7bbbb000", 2),
    ], 10);
    expect(out.map((s) => s.short_id)).toEqual(["jx7aaaa"]);
  });

  test("falls back to the first seven characters when a conversation has no short_id", async () => {
    const c = ctx([conv("jx7aaaa000", { short_id: undefined })]);
    const out = await linkedSessionsFor(c as any, ME as any, task(), [comment("jx7aaaa000", 1)], 10);
    expect(out[0].short_id).toBe("jx7aaaa");
  });
});
