import { describe, expect, test } from "bun:test";
import { findMessageByContentPublic } from "./messages";
import { makeFakeDb } from "./testDb";

function fixture(share_token: string | undefined = "current-token") {
  const db = makeFakeDb({
    conversations: [{ _id: "conv", user_id: "owner", is_private: true, share_token }],
    messages: [{ _id: "message", conversation_id: "conv", content: "needle", timestamp: 1 }],
  });
  return { db, auth: { getUserIdentity: async () => null } };
}
const run = (ctx: any, share_token?: string, search_term = "needle") => (findMessageByContentPublic as any)._handler(ctx, { conversation_id: "conv", search_term, share_token });

describe("public content search token possession", () => {
  for (const token of [undefined, "wrong", "revoked-token"]) {
    test(`missing or noncurrent token (${token}) does not search content`, async () => {
      const ctx = fixture();
      const query = ctx.db.query;
      ctx.db.query = (table: string) => {
        expect(table).not.toBe("messages");
        return query(table);
      };
      expect(await run(ctx, token)).toBeNull();
    });
  }
  test("removed sharing revokes the previous token", async () => {
    const ctx = fixture();
    delete ctx.db._tables.conversations[0].share_token;
    expect(await run(ctx, "current-token")).toBeNull();
  });
  test("the presented current token finds a matching message", async () => {
    expect(await run(fixture(), "current-token")).toEqual({ message_id: "message", timestamp: 1 });
  });
  test("authorized searches retain long substring matches", async () => {
    const ctx = fixture();
    const term = "a".repeat(1001);
    ctx.db._tables.messages[0].content = term;
    expect(await run(ctx, "current-token", term)).toEqual({ message_id: "message", timestamp: 1 });
  });
  test("valid share searches still find matches after the first 500 messages", async () => {
    const ctx = fixture();
    ctx.db._tables.messages = Array.from({ length: 501 }, (_, i) => ({ _id: `msg${i}`, conversation_id: "conv", timestamp: i, content: i === 500 ? "needle" : "hay" }));
    expect(await run(ctx, "current-token")).toEqual({ message_id: "msg500", timestamp: 500 });
  });
});
