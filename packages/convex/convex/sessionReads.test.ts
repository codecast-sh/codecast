import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { acknowledge, listMine, markUnread } from "./sessionReads";

// The server half of session unread. It stores two facts and one flag; what
// these tests pin is that it never stores a third — no derived "unread"
// boolean, no copy of the conversation's activity stamp that could go stale —
// and that a mark is only ever writable by, and readable to, its own owner.

const USER = "user_1" as any;
const OTHER = "user_2" as any;
const CONV = "conv_1" as any;
const PRIVATE = "conv_2" as any;

function context(user: string | null) {
  const db = makeFakeDb({
    users: [{ _id: USER, name: "Ashot" }, { _id: OTHER, name: "Sam" }],
    team_memberships: [],
    conversations: [
      { _id: CONV, user_id: USER, is_private: true, session_id: "sess-1", short_id: "jx70ntf", title: "Git backend", updated_at: 5_000 },
      { _id: PRIVATE, user_id: OTHER, is_private: true, session_id: "sess-2", title: "Not mine", updated_at: 5_000 },
    ],
    session_reads: [],
  });
  return {
    db,
    auth: { async getUserIdentity() { return user ? { subject: `${user}|session` } : null; } },
  } as any;
}

const rows = (ctx: any) => ctx.db._tables.session_reads;

describe("sessionReads.acknowledge", () => {
  test("inserts one mark for this viewer at the stamp they name", async () => {
    const ctx = context(USER);
    const out = await (acknowledge as any)._handler(ctx, { conversation_id: CONV, acknowledged_at: 4_000 });

    expect(rows(ctx)).toHaveLength(1);
    expect(rows(ctx)[0]).toMatchObject({ user_id: USER, conversation_id: CONV, acknowledged_at: 4_000 });
    expect(out.acknowledged_at).toBe(4_000);
    // No stored unread, and no copy of the conversation's own updated_at: the
    // comparison is the client's, against a live row, so it cannot go stale.
    expect(Object.keys(rows(ctx)[0]).sort()).toEqual(
      ["_id", "acknowledged_at", "conversation_id", "updated_at", "user_id"],
    );
  });

  test("a second ack moves the same row, never adds another", async () => {
    const ctx = context(USER);
    await (acknowledge as any)._handler(ctx, { conversation_id: CONV, acknowledged_at: 4_000 });
    await (acknowledge as any)._handler(ctx, { conversation_id: CONV, acknowledged_at: 6_000 });
    expect(rows(ctx)).toHaveLength(1);
    expect(rows(ctx)[0].acknowledged_at).toBe(6_000);
  });

  test("the mark only ever moves forward", async () => {
    // Two devices ack the same session seconds apart; the older stamp must not
    // re-unread what the viewer already saw.
    const ctx = context(USER);
    await (acknowledge as any)._handler(ctx, { conversation_id: CONV, acknowledged_at: 6_000 });
    await (acknowledge as any)._handler(ctx, { conversation_id: CONV, acknowledged_at: 4_000 });
    expect(rows(ctx)[0].acknowledged_at).toBe(6_000);
  });

  test("a stamp from the future is clamped to now", async () => {
    const ctx = context(USER);
    const out = await (acknowledge as any)._handler(ctx, {
      conversation_id: CONV,
      acknowledged_at: Date.now() + 3_600_000,
    });
    expect(out.acknowledged_at).toBeLessThanOrEqual(Date.now());
  });

  test("acknowledging clears the manual flag", async () => {
    const ctx = context(USER);
    await (markUnread as any)._handler(ctx, { conversation_id: CONV });
    expect(rows(ctx)[0].manual_unread).toBe(true);

    const out = await (acknowledge as any)._handler(ctx, { conversation_id: CONV, acknowledged_at: 6_000 });
    expect(rows(ctx)[0].manual_unread).toBe(false);
    // The projection omits a false flag, so the client's optimistic delete of
    // the field reconciles by === against what comes back.
    expect("manual_unread" in out).toBe(false);
  });

  test("a short id names the session as well as its full id", async () => {
    const ctx = context(USER);
    await (acknowledge as any)._handler(ctx, { conversation_id: "jx70ntf" });
    expect(rows(ctx)[0].conversation_id).toBe(CONV);
  });

  test("a session the caller cannot read cannot be marked", async () => {
    const ctx = context(USER);
    await expect((acknowledge as any)._handler(ctx, { conversation_id: PRIVATE }))
      .rejects.toThrow("Conversation not found");
    expect(rows(ctx)).toHaveLength(0);
  });

  test("an unauthenticated caller writes nothing", async () => {
    const ctx = context(null);
    await expect((acknowledge as any)._handler(ctx, { conversation_id: CONV }))
      .rejects.toThrow("Unauthorized");
    expect(rows(ctx)).toHaveLength(0);
  });
});

describe("sessionReads.markUnread", () => {
  test("lights a session that has no mark yet", async () => {
    const ctx = context(USER);
    const out = await (markUnread as any)._handler(ctx, { conversation_id: CONV });
    expect(out.manual_unread).toBe(true);
    expect(rows(ctx)[0].acknowledged_at).toBe(0);
  });

  test("lights a session the viewer had already acknowledged, without moving the mark", async () => {
    const ctx = context(USER);
    await (acknowledge as any)._handler(ctx, { conversation_id: CONV, acknowledged_at: 6_000 });
    await (markUnread as any)._handler(ctx, { conversation_id: CONV });
    expect(rows(ctx)[0]).toMatchObject({ acknowledged_at: 6_000, manual_unread: true });
  });
});

describe("sessionReads.listMine", () => {
  test("returns only the caller's own marks", async () => {
    const ctx = context(USER);
    await (acknowledge as any)._handler(ctx, { conversation_id: CONV, acknowledged_at: 6_000 });
    // A mark belonging to someone else, in the same table.
    ctx.db._tables.session_reads.push({
      _id: "other_read", user_id: OTHER, conversation_id: PRIVATE, acknowledged_at: 1, updated_at: 1,
    });

    const out = await (listMine as any)._handler(ctx, {});
    expect(out.map((r: any) => r.conversation_id)).toEqual([String(CONV)]);
  });

  test("an unauthenticated caller gets an empty list, never everyone's marks", async () => {
    const ctx = context(null);
    expect(await (listMine as any)._handler(ctx, {})).toEqual([]);
  });
});
