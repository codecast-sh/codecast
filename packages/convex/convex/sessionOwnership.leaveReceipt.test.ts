import { describe, expect, test } from "bun:test";
import { mutation, syncAckReceipts } from "./functions";
import { makeFakeDb, schemaIndexes } from "./testDb";
import schema from "./schema";
import { drainSyncOutbox } from "./syncOutbox";
import { readRangePage } from "./syncLog";
import { performLeaveSession } from "./sessionOwnership";

// A leave takes the leaver's owner row, and with it the leaver's user scope
// out of the conversation's fan-out. The leave still lands a receipt there,
// so the leaving window's locks retire on a position like any other write.

const ME = "u".repeat(31) + "m";
const MATE = "u".repeat(31) + "p";
const TEAM = "teams_acme";

function fixture() {
  const db = makeFakeDb({
    users: [{ _id: ME, name: "Me" }, { _id: MATE, name: "Mate" }],
    teams: [{ _id: TEAM, name: "Acme" }],
    team_memberships: [
      { _id: "m1", user_id: ME, team_id: TEAM, role: "admin", joined_at: 1 },
      { _id: "m2", user_id: MATE, team_id: TEAM, role: "member", joined_at: 1 },
    ],
    // Mate's session, which Mate and I own.
    conversations: [{ _id: "conversations_s", user_id: MATE, team_id: TEAM, session_id: "s", short_id: "jxs", status: "active", updated_at: 1, owner_user_id: MATE }],
    session_owners: [
      { _id: "o1", conversation_id: "conversations_s", user_id: MATE, added_by: MATE, added_at: 1 },
      { _id: "o2", conversation_id: "conversations_s", user_id: ME, added_by: MATE, added_at: 2 },
    ],
  }, { indexes: schemaIndexes(schema), mintId: (table, n) => `${table}_${n}`, creationTime: () => Date.now() });
  const ctx: any = { db, scheduler: { runAfter: async () => "job" } };
  return { db, ctx };
}

const leave = (mutation({
  args: {},
  handler: async (ctx: any, args: any) => {
    await performLeaveSession(ctx, args.user, { session_id: "conversations_s" });
    return syncAckReceipts(ctx);
  },
}) as any)._handler;

describe("a leave's receipt", () => {
  test("lands in the leaver's own scope, and their range reads it as an upsert, never a revocation", async () => {
    const { db, ctx } = fixture();
    const receipts = await leave(ctx, { user: ME });
    expect(db._tables.session_owners.map((r: any) => r.user_id)).toEqual([MATE]);
    expect(receipts.some((r: any) => r.scope_key === `user:${ME}` && r.entity_id === "conversations_s")).toBe(true);
    for (let i = 0; i < 20; i++) {
      const pending = (db._tables.sync_outbox ?? []).find((r: any) => r.pending);
      if (!pending) break;
      await drainSyncOutbox(ctx, pending._id);
    }
    const range = await readRangePage(db, `user:${ME}`, 0, undefined, { userId: ME, heldKeys: new Set([`user:${ME}`, `team:${TEAM}`]) });
    expect(range.actions.filter((a) => a.entity_id === "conversations_s").map((a) => a.op)).toEqual(["upsert"]);
  });
});
