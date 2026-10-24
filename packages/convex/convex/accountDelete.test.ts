import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { purgeAccountPass } from "./accountDelete";

const ME = "u".repeat(31) + "m";
const MATE = "u".repeat(31) + "t";

describe("purgeAccountPass", () => {
  test("an account too big for one pass is deleted over several, access first and the user row last", async () => {
    const conversations = Array.from({ length: 250 }, (_, i) => ({ _id: `conv${i}`, user_id: ME }));
    const db = makeFakeDb({
      users: [{ _id: ME, email: "me@x.org" }, { _id: MATE, email: "mate@x.org" }],
      authSessions: [{ _id: "as1", userId: ME }],
      authAccounts: [{ _id: "aa1", userId: ME }],
      api_tokens: [{ _id: "tok1", user_id: ME }, { _id: "tok2", user_id: MATE }],
      conversations: [...conversations, { _id: "mateconv", user_id: MATE }],
      notifications: [{ _id: "n1", recipient_user_id: ME }],
      team_memberships: [{ _id: "tm1", user_id: ME }],
    });
    const purged: string[] = [];
    const ctx: any = { db, scheduler: { runAfter: async (_ms: number, _fn: any, a: any) => { if (a.conversation_id) purged.push(a.conversation_id); } } };
    const rows = (t: string) => (db as any)._tables[t] ?? [];

    expect(await purgeAccountPass(ctx, ME as any)).toBe(true);
    expect(rows("authSessions")).toEqual([]);
    expect(rows("api_tokens").map((r: any) => r._id)).toEqual(["tok2"]);
    expect(rows("users").length).toBe(2);

    let passes = 1;
    while (await purgeAccountPass(ctx, ME as any).then((more) => (passes++, more)));
    expect(passes).toBe(3);
    expect(purged.length).toBe(250);
    expect(rows("conversations").map((r: any) => r._id)).toEqual(["mateconv"]);
    expect(rows("notifications")).toEqual([]);
    expect(rows("team_memberships")).toEqual([]);
    expect(rows("authAccounts")).toEqual([]);
    expect(rows("users").map((r: any) => r._id)).toEqual([MATE]);
  });
});
