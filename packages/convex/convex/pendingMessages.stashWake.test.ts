import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { enqueuePendingMessage } from "./pendingMessages";

// The stash wake rules at the enqueue choke point. A plain stash pops back
// into the inbox on ANY send, a trigger wake (origin "scheduler") included —
// something happened to the session, so the human sees it. A HIDDEN stash
// (`cast stash --hide`, "Stash and hide") survives machine wakes and clears
// only on a human send. Dismissed and killed clear on every send regardless.

function world(conv: Record<string, any>) {
  const tables: Record<string, any[]> = {
    conversations: [{ _id: "conv1", user_id: "u1", short_id: "jx1", session_id: "s1", status: "active", ...conv }],
    pending_messages: [],
    session_owners: [],
    managed_sessions: [],
  };
  const db = makeFakeDb(tables);
  return { ctx: { db }, tables, conv: tables.conversations[0] };
}

describe("stash wake rules at enqueue", () => {
  test("a trigger wake clears a plain stash — the row pops back", async () => {
    const { ctx, conv } = world({ inbox_stashed_at: 100 });
    await enqueuePendingMessage(ctx as any, conv, "u1" as any, { content: "tick", origin: "scheduler" });
    expect(conv.inbox_stashed_at).toBeUndefined();
  });

  test("a trigger wake leaves a hidden stash in place", async () => {
    const { ctx, conv } = world({ inbox_stashed_at: 100, inbox_stash_hidden: true });
    await enqueuePendingMessage(ctx as any, conv, "u1" as any, { content: "tick", origin: "scheduler" });
    expect(conv.inbox_stashed_at).toBe(100);
    expect(conv.has_pending_messages).toBe(true);
  });

  test("a human send clears a hidden stash", async () => {
    const { ctx, conv } = world({ inbox_stashed_at: 100, inbox_stash_hidden: true });
    await enqueuePendingMessage(ctx as any, conv, "u1" as any, { content: "hey" });
    expect(conv.inbox_stashed_at).toBeUndefined();
  });

  test("a stale hidden flag on an unstashed row means nothing", async () => {
    // The flag is honored only while the stamp is set: a later plain stash of
    // this row would rewrite it, so a leftover `true` must not hide anything.
    const { ctx, conv } = world({ inbox_stash_hidden: true });
    await enqueuePendingMessage(ctx as any, conv, "u1" as any, { content: "tick", origin: "scheduler" });
    expect(conv.inbox_stashed_at).toBeUndefined();
  });

  test("dismissed and killed clear on a trigger wake even when the stash is hidden", async () => {
    const { ctx, conv } = world({ inbox_stashed_at: 100, inbox_stash_hidden: true, inbox_dismissed_at: 50, inbox_killed_at: 60, status: "completed" });
    await enqueuePendingMessage(ctx as any, conv, "u1" as any, { content: "tick", origin: "scheduler" });
    expect(conv.inbox_dismissed_at).toBeUndefined();
    expect(conv.inbox_killed_at).toBeUndefined();
    expect(conv.status).toBe("active");
    expect(conv.inbox_stashed_at).toBe(100);
  });
});
