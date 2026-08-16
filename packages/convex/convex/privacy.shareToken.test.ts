import { describe, expect, test } from "bun:test";
import { checkConversationAccess } from "./privacy";

// Regression for issue #27: checkConversationAccess granted "shared" because a
// share_token EXISTED on the conversation — the viewer never presented it, so
// any authenticated user who knew a conversation id could read any
// conversation that had ever minted a share link. "shared" now requires
// presenting the token (guests) or holding a redemption of the CURRENT token
// (signed-in viewers who opened the share link).

type Rec = Record<string, any>;

// Minimal Convex-ish db: withIndex ignores the index name and matches on the
// eq constraints the builder declares (same shape as the pendingMessages tests).
function createDb(seed: Record<string, Rec[]>) {
  const tables: Record<string, Rec[]> = {};
  for (const [table, rows] of Object.entries(seed)) tables[table] = rows.map((r) => ({ ...r }));
  const db = {
    query(table: string) {
      const constraints: Array<{ field: string; val: any }> = [];
      const q: any = {
        eq(field: string, val: any) { constraints.push({ field, val }); return q; },
      };
      const run = () =>
        (tables[table] ?? []).filter((r) =>
          constraints.every((c) => String(r[c.field]) === String(c.val))
        );
      const chain = {
        withIndex(_name: string, builder: (q: any) => unknown) { builder(q); return chain; },
        async collect() { return run(); },
        async first() { return run()[0] ?? null; },
      };
      return chain;
    },
  };
  return { db };
}

const tokenedConv = {
  _id: "conv1",
  user_id: "uOwner",
  is_private: true,
  share_token: "tok-real",
} as any;

function ctxWith(redemptions: Rec[] = []) {
  return { db: createDb({ team_memberships: [], session_owners: [], share_redemptions: redemptions }).db } as any;
}

describe("checkConversationAccess — share token must be presented", () => {
  test("THE BUG: a signed-in stranger with only the conversation id is denied", async () => {
    expect(await checkConversationAccess(ctxWith(), "uStranger" as any, tokenedConv)).toBe("denied");
  });

  test("an anonymous viewer with only the conversation id is denied", async () => {
    expect(await checkConversationAccess(ctxWith(), null, tokenedConv)).toBe("denied");
  });

  test("an anonymous viewer presenting the token gets 'shared'", async () => {
    expect(await checkConversationAccess(ctxWith(), null, tokenedConv, "tok-real")).toBe("shared");
  });

  test("presenting a WRONG token is denied", async () => {
    expect(await checkConversationAccess(ctxWith(), null, tokenedConv, "tok-guess")).toBe("denied");
  });

  test("a signed-in viewer with a redemption of the current token gets 'shared'", async () => {
    const ctx = ctxWith([
      { _id: "r1", conversation_id: "conv1", user_id: "uStranger", token: "tok-real", created_at: 1 },
    ]);
    expect(await checkConversationAccess(ctx, "uStranger" as any, tokenedConv)).toBe("shared");
  });

  test("token rotation revokes past redeemers: stale redemption is denied", async () => {
    const ctx = ctxWith([
      { _id: "r1", conversation_id: "conv1", user_id: "uStranger", token: "tok-old", created_at: 1 },
    ]);
    expect(await checkConversationAccess(ctx, "uStranger" as any, tokenedConv)).toBe("denied");
  });

  test("an anonymous redemption row cannot exist, and null viewer never matches one", async () => {
    const ctx = ctxWith([
      { _id: "r1", conversation_id: "conv1", user_id: "uStranger", token: "tok-real", created_at: 1 },
    ]);
    expect(await checkConversationAccess(ctx, null, tokenedConv)).toBe("denied");
  });

  test("a conversation with NO share_token denies even a presented token", async () => {
    const conv = { ...tokenedConv, share_token: undefined };
    expect(await checkConversationAccess(ctxWith(), null, conv, "tok-real")).toBe("denied");
  });

  test("the owner needs no token", async () => {
    expect(await checkConversationAccess(ctxWith(), "uOwner" as any, tokenedConv)).toBe("owner");
  });
});
