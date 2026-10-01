import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { deleteSessionAsOwner } from "./sessionDelete";
import { isDeletedSession } from "./lib/deletedSessions";

const ME = "u".repeat(31) + "m";
const MATE = "u".repeat(31) + "t";

function setup(convOverrides: Record<string, any> = {}) {
  const db = makeFakeDb({
    users: [{ _id: ME, name: "Me" }, { _id: MATE, name: "Mate" }],
    conversations: [
      { _id: "conv1", session_id: "sess1", user_id: ME, status: "active", ...convOverrides },
      { _id: "sub1", session_id: "sess-sub", user_id: ME, parent_conversation_id: "conv1", is_subagent: true },
      { _id: "worker1", session_id: "sess-worker", user_id: ME, parent_conversation_id: "conv1" },
    ],
    messages: [{ _id: "m1", conversation_id: "conv1" }],
  });
  const scheduled: any[] = [];
  const ctx = { db, scheduler: { runAfter: async (_ms: number, fn: any, args: any) => { scheduled.push(args); } } };
  return { db, ctx, scheduled };
}

const ids = (db: any) => db._tables.conversations.map((c: any) => c._id);

describe("deleteSessionAsOwner", () => {
  test("removes the session and its subagent transcripts, tombstones them, schedules the purge, and tears the agent down", async () => {
    const { db, ctx, scheduled } = setup();
    const res = await deleteSessionAsOwner(ctx, ME as any, "conv1" as any);

    expect(res.deleted).toBe(2);
    expect(ids(db)).toEqual(["worker1"]);
    expect(await isDeletedSession(ctx, ME, "sess1")).toBe(true);
    expect(await isDeletedSession(ctx, ME, "sess-sub")).toBe(true);
    expect(await isDeletedSession(ctx, ME, "sess-worker")).toBe(false);
    expect(scheduled.map((a) => a.conversation_id)).toEqual(expect.arrayContaining(["conv1", "sub1"]));
    const kills = (db._tables.daemon_commands ?? []).filter((c: any) => c.command === "kill_session");
    expect(kills.length).toBeGreaterThan(0);
  });

  test("refuses anyone but the account that runs it", async () => {
    const { db, ctx } = setup();
    await expect(deleteSessionAsOwner(ctx, MATE as any, "conv1" as any)).rejects.toThrow();
    expect(ids(db)).toContain("conv1");
  });

  test("refuses a role's standing session", async () => {
    const { db, ctx } = setup({ persistent: true });
    await expect(deleteSessionAsOwner(ctx, ME as any, "conv1" as any)).rejects.toThrow();
    expect(ids(db)).toContain("conv1");
  });
});
