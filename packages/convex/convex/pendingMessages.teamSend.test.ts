import { describe, expect, test } from "bun:test";
import {
  performSessionSend,
  collectDeliverableForOwner,
  claimPendingMessageForDaemon,
  markPendingDelivered,
  updatePendingMessageStatusForDaemon,
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
    users: [
      { _id: "uAlice" },
      { _id: "uBob" },
      { _id: "uCarol" },
      { _id: "uBot", name: "Mr Bot", is_bot: true },
      { _id: "uBot2", name: "Other Bot", is_bot: true },
    ],
    teams: [{ _id: "tA" }],
    team_memberships: [
      { _id: "mAlice", user_id: "uAlice", team_id: "tA", visibility: "summary" },
      { _id: "mBob", user_id: "uBob", team_id: "tA", visibility: "summary" },
      { _id: "mBot", user_id: "uBot", team_id: "tA", visibility: "summary" },
      { _id: "mBot2", user_id: "uBot2", team_id: "tA", visibility: "summary" },
    ],
    conversations: [
      { _id: "convAlice", user_id: "uAlice", short_id: "jxalice", session_id: "sess-alice", is_private: true, status: "active" },
      { _id: "convBob", user_id: "uBob", team_id: "tA", short_id: "jxbob01", session_id: "sess-bob", is_private: false, status: "active" },
      { _id: "convBobPriv", user_id: "uBob", team_id: "tA", short_id: "jxbobpv", session_id: "sess-bobpv", is_private: true, status: "active" },
      { _id: "convCarol", user_id: "uCarol", short_id: "jxcarol", session_id: "sess-carol", is_private: true, status: "active" },
      // Bot-run, no human starter — the only shape a teammate send may auto-claim.
      { _id: "convBotRun", user_id: "uBot", team_id: "tA", short_id: "jxbotrn", session_id: "sess-botrun", is_private: false, status: "active" },
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

describe("direct send — a person typing into a session", () => {
  test("wraps as <user-message from=Name>, never an unknown-session wrapper", async () => {
    const { ctx, tables } = world({ now: Date.now() });
    await ctx.db.patch("uAlice", { name: "Alice" });
    const res = await performSessionSend(ctx as any, "uAlice" as any, {
      to: "jxbob01",
      body: "its me - you can proceed",
      direct: true,
    });

    expect(res.cross_user).toBe(true);
    const row = tables.pending_messages[0];
    expect(row.from_user_id).toBe("uAlice");
    expect(row.owner_user_id).toBe("uBob");
    expect(row.content).toBe('<user-message from="Alice">\nits me - you can proceed\n</user-message>');
    expect(row.content).not.toContain("<session-message");
    expect(row.content).not.toContain("unknown");
  });

  test("a direct send into your own session still names you", async () => {
    const { ctx, tables } = world({ now: Date.now() });
    await ctx.db.patch("uAlice", { name: "Alice" });
    await performSessionSend(ctx as any, "uAlice" as any, { to: "jxalice", body: "hi", direct: true });
    expect(tables.pending_messages[0].content).toBe('<user-message from="Alice">\nhi\n</user-message>');
  });
});

describe("send with a sender that resolves to nothing", () => {
  test("is rejected before enqueue — never delivered as from=unknown", async () => {
    const { ctx, tables } = world({ now: Date.now() });
    await expect(
      performSessionSend(ctx as any, "uAlice" as any, { to: "jxbob01", from: "0199c3ab-1234-4d8f-9c1e-not-a-session", body: "ship it" })
    ).rejects.toThrow(/not found/);
    expect(tables.pending_messages.length).toBe(0);
  });

  test("an explicit jx short id still attributes without a row, and no sender still delivers", async () => {
    const { ctx, tables } = world({ now: Date.now() });
    await performSessionSend(ctx as any, "uAlice" as any, { to: "jxbob01", from: "jxghost", body: "a" });
    await performSessionSend(ctx as any, "uAlice" as any, { to: "jxbob01", body: "b" });
    expect(tables.pending_messages[0].content).toContain('<session-message from="jxghost"');
    expect(tables.pending_messages[1].content).toContain('<session-message from="unknown"');
  });
});

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

  test("preserves an exact multi-line body instead of trimming code or blank lines", async () => {
    const { ctx, tables } = world({ now: Date.now() });
    const body = "    const answer = 42;\n\n";
    await performSessionSend(ctx as any, "uAlice" as any, {
      to: "jxbob01",
      from: "jxalice",
      body,
    });

    expect(tables.pending_messages[0].content).toBe(
      `<session-message from="jxalice">\n${body}\n</session-message>`,
    );
  });

  test("raw slash commands stay unwrapped; a report body is refused", async () => {
    const { ctx, tables } = world({ now: Date.now() });
    await performSessionSend(ctx as any, "uAlice" as any, {
      to: "jxalice",
      body: "/model opus",
      raw: true,
    });
    expect(tables.pending_messages[0].content).toBe("/model opus");
    await expect(
      performSessionSend(ctx as any, "uAlice" as any, {
        to: "jxalice",
        from: "jxalice",
        body: "Backend B (ct-51438) review fixes: all five of mine fixed.",
        raw: true,
      }),
    ).rejects.toThrow(/only for slash commands/);
  });

  test("rejects a whitespace-only body without normalizing valid bodies", async () => {
    const { ctx } = world({ now: Date.now() });
    await expect(
      performSessionSend(ctx as any, "uAlice" as any, {
        to: "jxbob01",
        from: "jxalice",
        body: " \n\t ",
      }),
    ).rejects.toThrow("Message body is empty");
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

  test("a cross-user send into a human-run session does not claim it — the starter stays responsible", async () => {
    const { ctx, tables } = world({ now: Date.now() });
    const res = await performSessionSend(ctx as any, "uAlice" as any, {
      to: "jxbob01",
      from: "jxalice",
      body: "picking this up",
    });
    expect(res.auto_owned).toBe(false);
    const conv = tables.conversations.find((c) => c._id === "convBob")!;
    expect(conv.owner_user_id).toBeUndefined();
    expect(tables.session_owners ?? []).toEqual([]);
    // Delivery routing is untouched: the pending row still routes to Bob's daemon.
    expect(tables.pending_messages[0].owner_user_id).toBe("uBob");
  });

  test("a cross-user send into a BOT-run unowned session auto-owns it onto the sender", async () => {
    const { ctx, tables } = world({ now: Date.now() });
    const res = await performSessionSend(ctx as any, "uAlice" as any, {
      to: "jxbotrn",
      from: "jxalice",
      body: "picking this up",
    });
    expect(res.auto_owned).toBe(true);
    const conv = tables.conversations.find((c) => c._id === "convBotRun")!;
    expect(conv.owner_user_id).toBe("uAlice");
    expect(tables.pending_messages[0].owner_user_id).toBe("uBot");
  });

  test("a bot-run session a human originally started is not auto-claimed", async () => {
    const { ctx, tables } = world({ now: Date.now() });
    tables.conversations.find((c) => c._id === "convBotRun")!.author_user_id = "uBob";
    const res = await performSessionSend(ctx as any, "uAlice" as any, {
      to: "jxbotrn",
      from: "jxalice",
      body: "fyi",
    });
    expect(res.auto_owned).toBe(false);
    expect(tables.conversations.find((c) => c._id === "convBotRun")!.owner_user_id).toBeUndefined();
  });

  test("a BOT sender never auto-owns — a bot-run thread stays claimable by the first human", async () => {
    const { ctx, tables } = world({ now: Date.now() });
    const botRes = await performSessionSend(ctx as any, "uBot2" as any, { to: "jxbotrn", body: "status ping" });
    expect(botRes.auto_owned).toBe(false);
    expect(tables.conversations.find((c) => c._id === "convBotRun")!.owner_user_id).toBeUndefined();
    // The message itself still delivers normally.
    expect(tables.pending_messages[0].content).toContain("status ping");
    // A human engaging afterwards still claims a bot-run unowned thread.
    const humanRes = await performSessionSend(ctx as any, "uAlice" as any, { to: "jxbotrn", from: "jxalice", body: "on it" });
    expect(humanRes.auto_owned).toBe(true);
    expect(tables.conversations.find((c) => c._id === "convBotRun")!.owner_user_id).toBe("uAlice");
  });

  test("a cross-user send NEVER steals an existing owner", async () => {
    const { ctx, tables } = world({ now: Date.now() });
    tables.conversations.find((c) => c._id === "convBob")!.owner_user_id = "uCarol";
    const res = await performSessionSend(ctx as any, "uAlice" as any, { to: "jxbob01", from: "jxalice", body: "fyi" });
    expect(res.auto_owned).toBe(false);
    expect(tables.conversations.find((c) => c._id === "convBob")!.owner_user_id).toBe("uCarol");
  });

  // session_owners is the canonical owner store; owner_user_id is only a cache
  // of the primary. An owner recorded ONLY in the table (no cache yet) must still
  // block a steal — otherwise a secondary owner could be silently displaced.
  test("the owner SET is authoritative — a join-table owner with no cached primary blocks auto-claim", async () => {
    const { ctx, tables } = world({ now: Date.now() });
    tables.session_owners = [
      { _id: "so1", conversation_id: "convBob", user_id: "uCarol", added_by: "uCarol", added_at: 1 },
    ];
    const res = await performSessionSend(ctx as any, "uAlice" as any, { to: "jxbob01", from: "jxalice", body: "fyi" });
    expect(res.auto_owned).toBe(false);
    expect(tables.session_owners.map((r: any) => r.user_id)).toEqual(["uCarol"]);
  });

  // The reverse guard: a legacy row with a cached owner but no join row (written
  // before the session_owners backfill) must not be auto-claimed either.
  test("auto-claim writes the canonical join row, not just the owner_user_id cache", async () => {
    const { ctx, tables } = world({ now: Date.now() });
    const res = await performSessionSend(ctx as any, "uAlice" as any, { to: "jxbotrn", from: "jxalice", body: "on it" });
    expect(res.auto_owned).toBe(true);
    expect((tables.session_owners ?? []).map((r: any) => r.user_id)).toEqual(["uAlice"]);
    // …and the cache is resynced from the set.
    expect(tables.conversations.find((c) => c._id === "convBotRun")!.owner_user_id).toBe("uAlice");
  });

  test("a self-send (Bob → his own session) sets no failure channel and keeps owner == sender", async () => {
    const { ctx, db, tables } = world({ now: 1_000_000_000_000 });
    const res = await performSessionSend(ctx as any, "uBob" as any, { to: "jxbob01", from: "jxbob01", body: "note to self" });
    expect(res.cross_user).toBe(false);
    expect(res.auto_owned).toBe(false); // self-sends never assign second-party ownership
    expect(tables.conversations.find((c) => c._id === "convBob")!.owner_user_id).toBeUndefined();
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

describe("settled recipient recovery end to end", () => {
  test.each(["starting", "resuming", "connected"])("recovers an exhausted send after %s stops progressing", async agentStatus => {
    const now = Date.now();
    const { ctx, db, tables } = world({ now });
    await performSessionSend(ctx as any, "uBob" as any, { to: "jxbob01", body: "The release is ready" });
    const msg = tables.pending_messages[0];
    await db.patch(msg._id, { status: "undeliverable", retry_count: 10, created_at: now - 600000 });
    await db.patch("msBob", { agent_status: agentStatus, agent_status_updated_at: now - 60000 });
    expect(await healAndNotifyStuckMessages(ctx as any, now)).toMatchObject({ revived: 0, waiting: 1 });
    await db.patch("msBob", { agent_status_updated_at: now - 300000 });
    expect(await healAndNotifyStuckMessages(ctx as any, now)).toMatchObject({ revived: 1, waiting: 0 });
    expect(await claimPendingMessageForDaemon(ctx as any, msg._id, "uBob" as any, "devBob"))
      .toMatchObject({ content: msg.content, status: "pending", retry_count: 0 });
    await markPendingDelivered(ctx as any, msg);
    expect(await healAndNotifyStuckMessages(ctx as any, now)).toMatchObject({ revived: 0 });
    expect((await db.get("convBob"))?.has_pending_messages).toBe(false);
  });

  test.each(["idle", "waiting", "dormant", "done"])("recovers an unacknowledged send to a %s recipient", async agentStatus => {
    const now = Date.now();
    const { ctx, db, tables } = world({ now });
    await performSessionSend(ctx as any, "uAlice" as any, { to: "jxbob01", from: "jxalice", body: "The release is ready" });
    const msg = tables.pending_messages[0];
    const originalContent = msg.content;
    await claimPendingMessageForDaemon(ctx as any, msg._id, "uBob" as any, "devBob");
    await updatePendingMessageStatusForDaemon(ctx as any, msg._id, "uBob" as any, "devBob", { status: "injected" });
    await db.patch(msg._id, { created_at: now - 6 * 60 * 60_000, retry_count: 6 });
    await db.patch("msBob", { agent_status: agentStatus });

    expect(await collectDeliverableForOwner(ctx as any, "uBob" as any, "devBob")).toHaveLength(0);
    expect(await healAndNotifyStuckMessages(ctx as any, now)).toMatchObject({ revived: 1, waiting: 0 });
    const deliverable = await collectDeliverableForOwner(ctx as any, "uBob" as any, "devBob");
    expect(deliverable.map(row => row._id)).toEqual([msg._id]);
    expect(await claimPendingMessageForDaemon(ctx as any, msg._id, "uBob" as any, "devBob")).toMatchObject({ content: originalContent, status: "pending", retry_count: 0 });
    await markPendingDelivered(ctx as any, await db.get(msg._id) as any);
    expect(await healAndNotifyStuckMessages(ctx as any, now)).toMatchObject({ revived: 0 });
    expect((await db.get(msg._id))?.status).toBe("delivered");
    expect((await db.get("convBob"))?.has_pending_messages).toBe(false);
  });

  test.each(["working", "thinking", "compacting", "permission_blocked", "starting", "resuming", "stopped"])("preserves unacknowledged input while recipient is %s", async agentStatus => {
    const now = Date.now();
    const { ctx, db, tables } = world({ now });
    await performSessionSend(ctx as any, "uBob" as any, { to: "jxbob01", body: "Preserve this" });
    const msg = tables.pending_messages[0];
    await db.patch(msg._id, { status: "injected", created_at: now - 600_000, retry_count: 6 });
    await db.patch("msBob", { agent_status: agentStatus });
    expect(await healAndNotifyStuckMessages(ctx as any, now)).toMatchObject({ revived: 0, waiting: 1 });
    expect(msg).toMatchObject({ status: "injected", retry_count: 6 });
  });

  test("a dormant recipient without a live daemon stays pending recovery", async () => {
    const now = Date.now();
    const { ctx, db, tables } = world({ bobLive: false, now });
    await performSessionSend(ctx as any, "uBob" as any, { to: "jxbob01", body: "Preserve this" });
    await db.patch(tables.pending_messages[0]._id, { status: "injected", created_at: now - 600_000 });
    await db.patch("msBob", { agent_status: "dormant" });
    expect(await healAndNotifyStuckMessages(ctx as any, now)).toMatchObject({ revived: 0, waiting: 1 });
  });
});

describe("remote not responding — feedback to the sending session", () => {
  test("a deleted target with a live managed row cannot abort recovery for other sessions", async () => {
    const now = 1_000_000_000_000;
    const { ctx, tables } = world({ now });
    const orphan = {
      _id: "orphan", conversation_id: "convBob", from_user_id: "uBob", owner_user_id: "uBob",
      status: "failed", retry_count: 3, content: "Keep this message", created_at: now - 600_000,
    };
    const healthy = {
      ...orphan, _id: "healthy", conversation_id: "convAlice", from_user_id: "uAlice", owner_user_id: "uAlice",
    };
    tables.pending_messages.push(orphan, healthy);
    tables.conversations = tables.conversations.filter((row) => row._id !== "convBob");
    tables.managed_sessions.push({
      _id: "msAlice", conversation_id: "convAlice", agent_status: "idle", last_heartbeat: now,
    });

    expect(await healAndNotifyStuckMessages(ctx as any, now)).toMatchObject({ revived: 1, waiting: 1 });
    expect(orphan).toMatchObject({ status: "failed", retry_count: 3, content: "Keep this message" });
    expect(healthy.status).toBe("pending");
    expect(await ctx.db.get("convAlice")).toMatchObject({ has_pending_messages: true });
  });

  test("a deleted cross-user target is reported offline despite a fresh managed heartbeat", async () => {
    const now = 1_000_000_000_000;
    const { ctx, tables } = world({ now });
    await performSessionSend(ctx as any, "uAlice" as any, { to: "jxbob01", from: "jxalice", body: "urgent" });
    const msg = tables.pending_messages[0];
    msg.created_at = now - CROSS_USER_NOTIFY_DEADLINE_MS - 60_000;
    tables.conversations = tables.conversations.filter((row) => row._id !== "convBob");

    expect(await healAndNotifyStuckMessages(ctx as any, now)).toMatchObject({ revived: 0, notified: 1 });
    expect(msg.status).toBe("cancelled");
    expect(tables.pending_messages.find((row) => row.conversation_id === "convAlice")?.content)
      .toContain("could not be delivered");
  });

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

describe("stale target — the send that would rebuild a whole context", () => {
  const HOUR = 60 * 60 * 1000;
  function staleWorld(bob: Record<string, unknown>, alice: Record<string, unknown> = {}) {
    const w = world({ now: Date.now() });
    Object.assign(w.tables.conversations.find((c) => c._id === "convBob")!, bob);
    Object.assign(w.tables.conversations.find((c) => c._id === "convAlice")!, alice);
    return w;
  }
  const idle = { usage_totals: { input: 1, output: 1, cache_read: 1, cache_write: 1, updated_at: Date.now() - 3 * HOUR, context_tokens: 480_000 } };
  const fresh = { usage_totals: { input: 1, output: 1, cache_read: 1, cache_write: 1, updated_at: Date.now() - 5 * 60_000, context_tokens: 480_000 } };

  test("holds a send into a session idle past the cache lifetime, naming the cost, and queues nothing", async () => {
    const { ctx, tables } = staleWorld(idle);
    await expect(
      performSessionSend(ctx as any, "uAlice" as any, { to: "jxbob01", from: "jxalice", body: "any update?", wake: false }),
    ).rejects.toThrow(/Not sent\. jxbob01 has not run for 3h.*480k tokens.*cast read jxbob01.*--wake/);
    expect(tables.pending_messages).toHaveLength(0);
  });

  test("delivers into a session that ran recently", async () => {
    const { ctx, tables } = staleWorld(fresh);
    await performSessionSend(ctx as any, "uAlice" as any, { to: "jxbob01", from: "jxalice", body: "hi", wake: false });
    expect(tables.pending_messages).toHaveLength(1);
  });

  test("holds a send into a killed session even when it ran recently", async () => {
    const { ctx, tables } = staleWorld({ ...fresh, inbox_killed_at: Date.now() - 60_000 });
    await expect(
      performSessionSend(ctx as any, "uAlice" as any, { to: "jxbob01", from: "jxalice", body: "hi", wake: false }),
    ).rejects.toThrow(/jxbob01 was killed/);
    expect(tables.pending_messages).toHaveLength(0);
  });

  test("--wake, a worker reporting back, a dormant session, and a caller that never asked all deliver", async () => {
    const woken = staleWorld(idle);
    await performSessionSend(woken.ctx as any, "uAlice" as any, { to: "jxbob01", from: "jxalice", body: "go", wake: true });
    expect(woken.tables.pending_messages).toHaveLength(1);

    const reporting = staleWorld(idle, { spawned_by_conversation_id: "convBob" });
    await performSessionSend(reporting.ctx as any, "uAlice" as any, { to: "jxbob01", from: "jxalice", body: "done: abc123", wake: false });
    expect(reporting.tables.pending_messages).toHaveLength(1);

    const dormant = staleWorld({ ...idle, thread_state_status: "dormant" });
    await performSessionSend(dormant.ctx as any, "uAlice" as any, { to: "jxbob01", from: "jxalice", body: "your review is ready", wake: false });
    expect(dormant.tables.pending_messages).toHaveLength(1);

    const legacy = staleWorld(idle);
    await performSessionSend(legacy.ctx as any, "uAlice" as any, { to: "jxbob01", from: "jxalice", body: "old cli" });
    expect(legacy.tables.pending_messages).toHaveLength(1);
  });

  test("a killed session stays held even for the worker it started", async () => {
    const { ctx, tables } = staleWorld({ ...idle, inbox_killed_at: Date.now() - HOUR }, { spawned_by_conversation_id: "convBob" });
    await expect(
      performSessionSend(ctx as any, "uAlice" as any, { to: "jxbob01", from: "jxalice", body: "done", wake: false }),
    ).rejects.toThrow(/was killed/);
    expect(tables.pending_messages).toHaveLength(0);
  });
});
