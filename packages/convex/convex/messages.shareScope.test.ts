import { describe, expect, test } from "bun:test";
import { generateMessageShareLink, getSharedMessage } from "./messages";
import { makeFakeDb } from "./testDb";

// A message share is a window onto one conversation. The listed ids used to be
// stored unchecked and read back by the unauthenticated getSharedMessage, so
// any signed-in user could publish another tenant's messages.

const OWNER = "u_owner";
const VICTIM = "u_victim";

function fixture() {
  const db = makeFakeDb({
    users: [{ _id: OWNER, name: "Owner" }, { _id: VICTIM, name: "Victim" }],
    team_memberships: [],
    conversations: [
      { _id: "mine", user_id: OWNER, is_private: true, title: "Mine" },
      { _id: "theirs", user_id: VICTIM, is_private: true, title: "Theirs" },
    ],
    messages: [
      ...Array.from({ length: 120 }, (_, i) => ({ _id: `m${i}`, conversation_id: "mine", role: "user", content: `mine ${i}`, timestamp: i })),
      { _id: "secret", conversation_id: "theirs", role: "user", content: "their secret", timestamp: 5 },
    ],
    message_shares: [] as any[],
  });
  return { db, auth: { getUserIdentity: async () => ({ subject: `${OWNER}|session` }) } } as any;
}
const anon = (ctx: any) => ({ db: ctx.db, auth: { getUserIdentity: async () => null } });
const gen = (ctx: any, args: any) => (generateMessageShareLink as any)._handler(ctx, args);
const read = (ctx: any, share_token: string) => (getSharedMessage as any)._handler(anon(ctx), { share_token });

describe("message share stays inside the anchor conversation", () => {
  test("a share listing another conversation's message is refused and nothing is stored", async () => {
    const ctx = fixture();
    await expect(gen(ctx, { message_id: "m1", message_ids: ["m1", "secret"] })).rejects.toThrow("one conversation");
    expect(ctx.db._tables.message_shares).toHaveLength(0);
  });

  test("the owner shares their own selection and it reads back", async () => {
    const ctx = fixture();
    const token = await gen(ctx, { message_id: "m1", message_ids: ["m2", "m1"] });
    const shared = await read(ctx, token);
    expect(shared.contextMessages.map((m: any) => m._id)).toEqual(["m1", "m2"]);
  });

  test("a stored row that lists a foreign message serves only the anchor conversation's", async () => {
    const ctx = fixture();
    ctx.db._tables.message_shares.push({ _id: "s1", share_token: "old", message_id: "m1", user_id: OWNER, message_ids: ["m1", "secret"], created_at: 1 });
    const shared = await read(ctx, "old");
    expect(shared.contextMessages.map((m: any) => m._id)).toEqual(["m1"]);
  });

  test("context is clamped at write and at read", async () => {
    const ctx = fixture();
    const token = await gen(ctx, { message_id: "m60", context_before: 1e9, context_after: 2 });
    expect(ctx.db._tables.message_shares[0].context_before).toBe(50);
    const shared = await read(ctx, token);
    expect(shared.contextMessages).toHaveLength(53);
    ctx.db._tables.message_shares.push({ _id: "s2", share_token: "wide", message_id: "m60", user_id: OWNER, context_before: 1e9, context_after: 1e9, created_at: 1 });
    expect((await read(ctx, "wide")).contextMessages).toHaveLength(101);
  });
});
