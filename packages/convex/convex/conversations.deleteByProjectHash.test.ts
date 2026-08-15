// deleteByProjectHash ownership.
//
// The mutation has two branches. The hash branch was always scoped to the
// caller (by_user_id index). The conv_id continuation branch trusted the
// client-supplied id outright: any authenticated caller could delete any
// user's conversation and its messages. It must verify the conversation
// belongs to the caller before deleting anything.
import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { deleteByProjectHash } from "./conversations";

const VICTIM = "u_victim";
const ATTACKER = "u_attacker";

function tables(): Record<string, any[]> {
  return {
    users: [
      { _id: VICTIM, name: "Victim" },
      { _id: ATTACKER, name: "Attacker" },
    ],
    conversations: [
      {
        _id: "conv_victim",
        user_id: VICTIM,
        project_hash: "hash_v",
        is_private: true,
        title: "Victim session",
      },
      {
        _id: "conv_attacker",
        user_id: ATTACKER,
        project_hash: "hash_a",
        is_private: true,
        title: "Attacker session",
      },
    ],
    messages: [
      { _id: "msg_v1", conversation_id: "conv_victim", content: "private" },
      { _id: "msg_a1", conversation_id: "conv_attacker", content: "mine" },
    ],
  };
}

function ctx(userId: string | null, t: Record<string, any[]>) {
  return {
    auth: {
      async getUserIdentity() {
        return userId ? { subject: `${userId}|session` } : null;
      },
    },
    db: makeFakeDb(t),
    scheduler: { runAfter: async () => null },
    runMutation: async () => null,
  } as any;
}

const run = (userId: string | null, args: any, t: Record<string, any[]>) =>
  (deleteByProjectHash as any)._handler(ctx(userId, t), args);

describe("deleteByProjectHash conv_id branch", () => {
  test("cannot delete another user's conversation by id", async () => {
    const t = tables();
    await expect(
      run(ATTACKER, { project_hash: "whatever", conv_id: "conv_victim" }, t),
    ).rejects.toThrow();
    expect(t.conversations.some((c) => c._id === "conv_victim")).toBe(true);
    expect(t.messages.some((m) => m._id === "msg_v1")).toBe(true);
  });

  test("the owner still deletes their own conversation by id", async () => {
    const t = tables();
    const res = await run(VICTIM, { project_hash: "hash_v", conv_id: "conv_victim" }, t);
    expect(res.deleted).toBe(1);
    expect(t.conversations.some((c) => c._id === "conv_victim")).toBe(false);
    expect(t.messages.some((m) => m._id === "msg_v1")).toBe(false);
  });

  test("a nonexistent conv_id is a no-op, not a crash", async () => {
    const t = tables();
    const res = await run(ATTACKER, { project_hash: "x", conv_id: "conv_gone" }, t);
    expect(res).toEqual({ deleted: 0, hasMore: false, conv_id: null });
  });

  test("the hash branch stays scoped to the caller", async () => {
    const t = tables();
    const res = await run(ATTACKER, { project_hash: "hash_v" }, t);
    expect(res.deleted).toBe(0);
    expect(t.conversations.some((c) => c._id === "conv_victim")).toBe(true);
  });
});
