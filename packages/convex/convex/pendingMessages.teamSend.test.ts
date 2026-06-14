import { describe, expect, test } from "bun:test";
import {
  performSessionSend,
  collectDeliverableForOwner,
  claimPendingMessageForDaemon,
  markPendingDelivered,
  healAndNotifyStuckMessages,
  planCrossUserNotify,
  CROSS_USER_NOTIFY_DEADLINE_MS,
} from "./pendingMessages";

// ── In-memory Convex-ish DB ──────────────────────────────────────────────────
// A small fake `ctx.db` that's faithful enough to run the REAL send / poll / claim / heal code
// end-to-end across two users and a team. withIndex ignores the index NAME and matches on the
// eq/gt constraints the query builder declares — equivalent to the real index for these queries.
// We deliberately never pass client_id, so enqueue's `.filter()` dedup branch is never taken
// (the fake's query chain doesn't implement .filter).

type Rec = Record<string, any>;

function createDb(seed: Record<string, Rec[]>) {
  const tables: Record<string, Rec[]> = {};
  const counters: Record<string, number> = {};
  for (const [table, rows] of Object.entries(seed)) {
    tables[table] = rows.map((r) => ({ ...r }));
  }

  const allRows = () => Object.values(tables).flat();

  const db = {
    async get(id: string) {
      return allRows().find((r) => r._id === id) ?? null;
    },
    async insert(table: string, doc: Rec) {
      counters[table] = (counters[table] ?? 0) + 1;
      const _id = `${table}_${counters[table]}`;
      const row = { _id, ...doc };
      (tables[table] ??= []).push(row);
      return _id;
    },
    async patch(id: string, patch: Rec) {
      const row = allRows().find((r) => r._id === id);
      if (!row) throw new Error(`patch: no row ${id}`);
      Object.assign(row, patch);
    },
    query(table: string) {
      const constraints: Array<{ field: string; op: "eq" | "gt"; val: any }> = [];
      const q: any = {
        eq(field: string, val: any) {
          constraints.push({ field, op: "eq", val });
          return q;
        },
        gt(field: string, val: any) {
          constraints.push({ field, op: "gt", val });
          return q;
        },
      };
      const run = () =>
        (tables[table] ?? []).filter((r) =>
          constraints.every((c) =>
            c.op === "eq"
              ? String(r[c.field]) === String(c.val)
              : (r[c.field] ?? -Infinity) > c.val
          )
        );
      const chain = {
        withIndex(_name: string, builder: (q: any) => unknown) {
          builder(q);
          return chain;
        },
        async collect() {
          return run();
        },
        async first() {
          return run()[0] ?? null;
        },
        async take(n: number) {
          return run().slice(0, n);
        },
      };
      return chain;
    },
  };
  return { ctx: { db }, db, tables };
}

// Shared world: Alice and Bob are on team T. Bob has a shared session (convBob) and a private one
// (convBobPriv). Alice has her own session (convAlice) that she sends FROM. Carol is a stranger.
function world(opts: { bobLive?: boolean; bobIdle?: boolean; now: number } = { now: 1_000_000_000_000 }) {
  const now = opts.now;
  const heartbeat = opts.bobLive === false ? now - 10 * 60_000 : now - 5_000;
  return createDb({
    users: [{ _id: "uAlice" }, { _id: "uBob" }, { _id: "uCarol" }],
    teams: [{ _id: "tA" }],
    team_memberships: [
      { _id: "mAlice", user_id: "uAlice", team_id: "tA", visibility: "summary" },
      { _id: "mBob", user_id: "uBob", team_id: "tA", visibility: "summary" },
    ],
    conversations: [
      { _id: "convAlice", user_id: "uAlice", short_id: "jxalice", session_id: "sess-alice", is_private: true, status: "active" },
      { _id: "convBob", user_id: "uBob", team_id: "tA", short_id: "jxbob01", session_id: "sess-bob", is_private: false, status: "active" },
      { _id: "convBobPriv", user_id: "uBob", team_id: "tA", short_id: "jxbobpv", session_id: "sess-bobpv", is_private: true, status: "active" },
      { _id: "convCarol", user_id: "uCarol", short_id: "jxcarol", session_id: "sess-carol", is_private: true, status: "active" },
    ],
    managed_sessions: [
      {
        _id: "msBob",
        user_id: "uBob",
        conversation_id: "convBob",
        session_id: "sess-bob",
        last_heartbeat: heartbeat,
        agent_status: opts.bobIdle === false ? "busy" : "idle",
      },
    ],
    pending_messages: [],
  });
}

describe("team send — authorization", () => {
  test("Alice can send to Bob's team-shared session; row is owned by Bob, attributed to Alice", async () => {
    // target_live is computed against real Date.now() in the send path, so seed near real time.
    const { ctx, db, tables } = world({ now: Date.now() });
    const res = await performSessionSend(ctx as any, "uAlice" as any, {
      to: "jxbob01",
      from: "jxalice",
      body: "can you take the auth half?",
    });

    expect(res.cross_user).toBe(true);
    expect(res.to_short_id).toBe("jxbob01");
    expect(res.from_short_id).toBe("jxalice");
    expect(res.target_live).toBe(true);

    const row = tables.pending_messages[0];
    expect(row.from_user_id).toBe("uAlice");
    expect(row.owner_user_id).toBe("uBob"); // delivery routes to Bob's daemon
    expect(row.from_conversation_id).toBe("convAlice"); // failure feedback channel set
    expect(row.content).toContain('<session-message from="jxalice">');
    expect(row.content).toContain("can you take the auth half?");
  });

  test("Alice CANNOT send to Bob's PRIVATE session (not team-visible)", async () => {
    const { ctx } = world({ now: 1_000_000_000_000 });
    await expect(
      performSessionSend(ctx as any, "uAlice" as any, { to: "jxbobpv", from: "jxalice", body: "hi" })
    ).rejects.toThrow(/No session found/);
  });

  test("Alice CANNOT send to a stranger's session (no shared team)", async () => {
    const { ctx } = world({ now: 1_000_000_000_000 });
    await expect(
      performSessionSend(ctx as any, "uAlice" as any, { to: "jxcarol", from: "jxalice", body: "hi" })
    ).rejects.toThrow(/No session found/);
  });

  test("send to an OFFLINE teammate session still queues, but reports target_live=false (CLI warns)", async () => {
    const { ctx, tables } = world({ bobLive: false, now: Date.now() });
    const res = await performSessionSend(ctx as any, "uAlice" as any, { to: "jxbob01", from: "jxalice", body: "you there?" });
    expect(res.target_live).toBe(false); // CLI prints the "no live daemon" hint off this
    expect(tables.pending_messages[0].status).toBe("pending"); // never rejected — it's queued
  });

  test("a self-send (Bob → his own session) sets no failure channel and keeps owner == sender", async () => {
    const { ctx, db, tables } = world({ now: 1_000_000_000_000 });
    const res = await performSessionSend(ctx as any, "uBob" as any, { to: "jxbob01", from: "jxbob01", body: "note to self" });
    expect(res.cross_user).toBe(false);
    const row = tables.pending_messages[0];
    expect(row.owner_user_id).toBe("uBob");
    expect(row.from_user_id).toBe("uBob");
    expect(row.from_conversation_id).toBeUndefined(); // self-sends keep pure never-drop semantics
  });
});

describe("team send — delivery routing", () => {
  test("Bob's daemon (not Alice's) picks up the cross-user message and delivers it", async () => {
    const { ctx, db, tables } = world({ now: 1_000_000_000_000 });
    await performSessionSend(ctx as any, "uAlice" as any, { to: "jxbob01", from: "jxalice", body: "ping" });
    const msgId = tables.pending_messages[0]._id;

    // Alice's daemon polls by her own user — must NOT see Bob's message.
    expect(await collectDeliverableForOwner(ctx as any, "uAlice" as any, "devAlice")).toHaveLength(0);

    // Bob's daemon polls by owner == Bob — sees it.
    const forBob = await collectDeliverableForOwner(ctx as any, "uBob" as any, "devBob");
    expect(forBob.map((m) => m._id)).toEqual([msgId]);

    // Bob's daemon claims and delivers; Alice's daemon can't claim it.
    expect(await claimPendingMessageForDaemon(ctx as any, msgId as any, "uAlice" as any, "devAlice")).toBeNull();
    const claimed = await claimPendingMessageForDaemon(ctx as any, msgId as any, "uBob" as any, "devBob");
    expect(claimed?._id).toBe(msgId);

    await markPendingDelivered(ctx as any, await db.get(msgId) as any);
    expect((await db.get(msgId))?.status).toBe("delivered");
  });
});

describe("delivery routing — backfill independence", () => {
  test("a legacy self-send with NO owner_user_id is still delivered (by_user_status safety net)", async () => {
    const { ctx, tables } = world({ now: 1_000_000_000_000 });
    // Simulate a row written before owner_user_id existed: only from_user_id is set.
    tables.pending_messages.push({
      _id: "legacy1",
      conversation_id: "convBob",
      from_user_id: "uBob",
      status: "pending",
      retry_count: 0,
      content: "legacy",
    });
    const forBob = await collectDeliverableForOwner(ctx as any, "uBob" as any, "devBob");
    expect(forBob.map((m) => m._id)).toContain("legacy1");
  });

  test("a cross-user row never surfaces to the SENDER's daemon even via the sender index", async () => {
    const { ctx, tables } = world({ now: 1_000_000_000_000 });
    await performSessionSend(ctx as any, "uAlice" as any, { to: "jxbob01", from: "jxalice", body: "x" });
    // Alice is the sender; the by_user_status arm finds the row, but canDaemonSee rejects it
    // because Alice doesn't own the target conversation.
    const forAlice = await collectDeliverableForOwner(ctx as any, "uAlice" as any, "devAlice");
    expect(forAlice).toHaveLength(0);
    void tables;
  });
});

describe("remote not responding — feedback to the sending session", () => {
  test("target OFFLINE past the deadline: Alice's session gets a failure receipt and the message is cancelled", async () => {
    const now = 1_000_000_000_000;
    const { ctx, db, tables } = world({ bobLive: false, now });
    // Send at t0, evaluate well past the deadline.
    await performSessionSend(ctx as any, "uAlice" as any, { to: "jxbob01", from: "jxalice", body: "urgent" });
    const msg = tables.pending_messages[0];
    msg.created_at = now - (CROSS_USER_NOTIFY_DEADLINE_MS + 60_000);

    const summary = await healAndNotifyStuckMessages(ctx as any, now);
    expect(summary.notified).toBe(1);

    // Original cancelled (remote has no live daemon).
    expect(msg.status).toBe("cancelled");
    expect(typeof msg.sender_notified_at).toBe("number");

    // A receipt was injected back into Alice's OWN session (owner == Alice, so her daemon delivers it).
    const receipt = tables.pending_messages.find(
      (m) => m.conversation_id === "convAlice" && m.owner_user_id === "uAlice"
    );
    expect(receipt).toBeTruthy();
    expect(receipt!.content).toContain("could not be delivered");
    expect(receipt!.content).toContain("jxbob01");
    // The receipt is a self-scoped message (from == owner) so it can never itself trigger a notify.
    expect(receipt!.from_conversation_id).toBeUndefined();
  });

  test("target BUSY (alive but not idle) past the deadline: Alice is told it's delayed, message KEPT", async () => {
    const now = 1_000_000_000_000;
    const { ctx, db, tables } = world({ bobLive: true, bobIdle: false, now });
    await performSessionSend(ctx as any, "uAlice" as any, { to: "jxbob01", from: "jxalice", body: "later" });
    const msg = tables.pending_messages[0];
    msg.created_at = now - (CROSS_USER_NOTIFY_DEADLINE_MS + 60_000);

    const summary = await healAndNotifyStuckMessages(ctx as any, now);
    expect(summary.notified).toBe(1);

    // NOT cancelled — a busy session will still get it when idle.
    expect(msg.status).toBe("pending");
    const receipt = tables.pending_messages.find((m) => m.conversation_id === "convAlice");
    expect(receipt!.content).toContain("hasn't been delivered yet");
    expect(receipt!.content).toContain("busy");
  });

  test("the sender is notified at most once (sender_notified_at gates re-runs)", async () => {
    const now = 1_000_000_000_000;
    const { ctx, db, tables } = world({ bobLive: true, bobIdle: false, now });
    await performSessionSend(ctx as any, "uAlice" as any, { to: "jxbob01", from: "jxalice", body: "later" });
    tables.pending_messages[0].created_at = now - (CROSS_USER_NOTIFY_DEADLINE_MS + 60_000);

    const first = await healAndNotifyStuckMessages(ctx as any, now);
    const second = await healAndNotifyStuckMessages(ctx as any, now + 60_000);
    expect(first.notified).toBe(1);
    expect(second.notified).toBe(0);
    // Exactly one receipt was ever produced.
    expect(tables.pending_messages.filter((m) => m.conversation_id === "convAlice")).toHaveLength(1);
  });

  test("before the deadline, nothing is sent to Alice", async () => {
    const now = 1_000_000_000_000;
    const { ctx, db, tables } = world({ bobLive: false, now });
    await performSessionSend(ctx as any, "uAlice" as any, { to: "jxbob01", from: "jxalice", body: "fresh" });
    tables.pending_messages[0].created_at = now - 30_000; // young

    const summary = await healAndNotifyStuckMessages(ctx as any, now);
    expect(summary.notified).toBe(0);
    expect(tables.pending_messages[0].status).toBe("pending");
    expect(tables.pending_messages.filter((m) => m.conversation_id === "convAlice")).toHaveLength(0);
  });
});

describe("planCrossUserNotify — pure decision", () => {
  const now = 5_000_000;
  const base = {
    status: "pending",
    created_at: now - (CROSS_USER_NOTIFY_DEADLINE_MS + 1),
    from_conversation_id: "convAlice" as any,
    from_user_id: "uAlice" as any,
    owner_user_id: "uBob" as any,
  };

  test("offline target → notify + giveUp", () => {
    expect(planCrossUserNotify(base, false, now)).toEqual({ kind: "notify", giveUp: true });
  });
  test("busy (live) target → notify, no giveUp", () => {
    expect(planCrossUserNotify(base, true, now)).toEqual({ kind: "notify", giveUp: false });
  });
  test("self-send (from == owner) → skip", () => {
    expect(planCrossUserNotify({ ...base, owner_user_id: "uAlice" as any }, false, now).kind).toBe("skip");
  });
  test("no sender conversation → skip", () => {
    expect(planCrossUserNotify({ ...base, from_conversation_id: undefined }, false, now).kind).toBe("skip");
  });
  test("already notified → skip", () => {
    expect(planCrossUserNotify({ ...base, sender_notified_at: now - 1 } as any, false, now).kind).toBe("skip");
  });
  test("before deadline → skip", () => {
    expect(planCrossUserNotify({ ...base, created_at: now - 1_000 }, false, now).kind).toBe("skip");
  });
  test("terminal (delivered) → skip", () => {
    expect(planCrossUserNotify({ ...base, status: "delivered" }, false, now).kind).toBe("skip");
  });
  test("legacy row without owner_user_id → skip", () => {
    expect(planCrossUserNotify({ ...base, owner_user_id: undefined }, false, now).kind).toBe("skip");
  });
});
