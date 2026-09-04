import { describe, expect, test } from "bun:test";
import { requireSessionCommandTarget, getConversationLifecycle, killSession, cliSetSessionVisibility } from "./conversations";
import { applyHideTransition } from "./cleanup";
import { shouldShowInInbox } from "./inboxFilters";
import { makeFakeDb } from "./testDb";

// Session commands (send keys/escape, rewind, model switch, project/agent
// switch) follow one rule: the RUNNER (conv.user_id) or the second-party
// owner (conv.owner_user_id) may command the session, and every daemon
// command row is stamped with the runner's user_id so the daemon that
// actually runs the session picks it up. Root of the 2026-07-13 loop: a
// second-party owner's model switch was refused, parked in the client
// outbox, and re-fired forever (ct-38463). This pins the auth half; call
// sites stamp `user_id: conv.user_id` by construction.

const RUNNER = "users_runner" as any;
const OWNER = "users_owner" as any;
const STRANGER = "users_stranger" as any;

function ctxWith(tables: Record<string, any[]>) {
  return { db: makeFakeDb(tables) } as any;
}

describe("requireSessionCommandTarget", () => {
  const conv = { _id: "conversations_1", user_id: RUNNER, owner_user_id: OWNER, session_id: "s1" };

  test("the runner may command the session", async () => {
    const ctx = ctxWith({ conversations: [conv] });
    const got = await requireSessionCommandTarget(ctx, RUNNER, "conversations_1" as any);
    expect(String(got._id)).toBe("conversations_1");
    expect(got.user_id).toBe(RUNNER);
  });

  test("the second-party owner may command the session (Mr-Bot-run, assigned)", async () => {
    const ctx = ctxWith({ conversations: [conv] });
    const got = await requireSessionCommandTarget(ctx, OWNER, "conversations_1" as any);
    // Callers stamp daemon_commands with this — the runner's account, not the caller's.
    expect(got.user_id).toBe(RUNNER);
  });

  test("anyone else is refused", async () => {
    const ctx = ctxWith({ conversations: [conv] });
    await expect(requireSessionCommandTarget(ctx, STRANGER, "conversations_1" as any)).rejects.toThrow("Not authorized");
  });

  test("a session with no second-party owner admits only the runner", async () => {
    const ctx = ctxWith({
      conversations: [{ _id: "conversations_2", user_id: RUNNER, session_id: "s2" }],
    });
    const got = await requireSessionCommandTarget(ctx, RUNNER, "conversations_2" as any);
    expect(got.user_id).toBe(RUNNER);
    await expect(requireSessionCommandTarget(ctx, OWNER, "conversations_2" as any)).rejects.toThrow("Not authorized");
  });

  test("a deleted/ghost conversation is refused as not found (kill/restart keep their own recovery; the web resume path escalates this to restore)", async () => {
    const ctx = ctxWith({ conversations: [] });
    await expect(requireSessionCommandTarget(ctx, RUNNER, "conversations_gone" as any)).rejects.toThrow("Conversation not found");
  });
});

// The daemon's LIFECYCLE read (api_token auth — no session cookie on a CLI/daemon
// caller). It gates the daemon's reap on the user's intent: a session the human
// killed or stashed must not be resurrected by a recovery path. No other
// daemon-facing query exposes the hide stamps, so this is the whole contract:
// five fields, or null when the caller doesn't run the conversation.
describe("getConversationLifecycle", () => {
  const CONV = "conversations_1";
  const call = (tables: Record<string, any[]>, subjectUser: string | null, args: any) =>
    (getConversationLifecycle as any)._handler(
      {
        db: makeFakeDb(tables),
        auth: { getUserIdentity: async () => (subjectUser ? { subject: `${subjectUser}|session` } : null) },
      },
      args,
    );

  const killedRow = {
    _id: CONV,
    user_id: RUNNER,
    session_id: "s1",
    status: "completed",
    inbox_killed_at: 222,
    inbox_dismissed_at: 222,
    inbox_stashed_at: 111,
    inbox_pinned_at: undefined,
  };

  test("returns lifecycle and pending-work state for a conversation the caller runs", async () => {
    expect(await call({ conversations: [killedRow] }, RUNNER, { conversation_id: CONV })).toEqual({
      status: "completed",
      inbox_killed_at: 222,
      inbox_dismissed_at: 222,
      inbox_stashed_at: 111,
      inbox_pinned_at: null, // absent stamps normalize to null, never undefined
      has_pending_messages: false,
    });
  });

  test("a live, never-hidden session reports every stamp as null", async () => {
    const tables = { conversations: [{ _id: CONV, user_id: RUNNER, status: "active" }] };
    expect(await call(tables, RUNNER, { conversation_id: CONV })).toEqual({
      status: "active",
      inbox_killed_at: null,
      inbox_dismissed_at: null,
      inbox_stashed_at: null,
      inbox_pinned_at: null,
      has_pending_messages: false,
    });
  });

  test("pending work is reported through both conversation and session selectors", async () => {
    const tables = { conversations: [{ ...killedRow, status: "active", has_pending_messages: true }] };
    expect((await call(tables, RUNNER, { conversation_id: CONV }))!.has_pending_messages).toBe(true);
    expect((await call(tables, RUNNER, { session_id: "s1" }))!.has_pending_messages).toBe(true);
  });

  test("someone else's conversation is null, not a leak", async () => {
    expect(await call({ conversations: [killedRow] }, STRANGER, { conversation_id: CONV })).toBeNull();
  });

  test("unauthenticated and missing conversations are null too", async () => {
    expect(await call({ conversations: [killedRow] }, null, { conversation_id: CONV })).toBeNull();
    expect(await call({ conversations: [] }, RUNNER, { conversation_id: CONV })).toBeNull();
  });

  test("exactly one selector — neither or both is null, never a guess", async () => {
    const tables = { conversations: [killedRow] };
    expect(await call(tables, RUNNER, {})).toBeNull();
    expect(await call(tables, RUNNER, { conversation_id: CONV, session_id: "s1" })).toBeNull();
  });

  // The session route resolves the NEWEST twin. .first() is creation order —
  // the OLDEST row bound to the session_id (the ct-36973 foot-gun) — which for
  // this query means handing the daemon a dead twin's stamps for a live session.
  describe("by session_id", () => {
    const twins = (extra: Record<string, any> = {}) => [
      { _id: "conversations_old", user_id: RUNNER, session_id: "s1", updated_at: 10, status: "completed", inbox_killed_at: 999 },
      { _id: "conversations_new", user_id: RUNNER, session_id: "s1", updated_at: 50, status: "active", ...extra },
    ];

    test("the newest twin wins — a dead older twin cannot speak for a live session", async () => {
      expect(await call({ conversations: twins() }, RUNNER, { session_id: "s1" })).toEqual({
        status: "active",
        inbox_killed_at: null,
        inbox_dismissed_at: null,
        inbox_stashed_at: null,
        inbox_pinned_at: null,
        has_pending_messages: false,
      });
    });

    test("newest-wins holds whatever order the rows come back in", async () => {
      const reversed = twins().reverse();
      expect((await call({ conversations: reversed }, RUNNER, { session_id: "s1" }))!.status).toBe("active");
    });

    test("the newest twin's own hide state is reported faithfully", async () => {
      const stashed = twins({ inbox_stashed_at: 777 });
      expect(await call({ conversations: stashed }, RUNNER, { session_id: "s1" })).toMatchObject({
        status: "active",
        inbox_stashed_at: 777,
        inbox_killed_at: null,
      });
    });

    test("a foreign twin on the same session_id is neither selected nor leaked", async () => {
      const mixed = [
        { _id: "conversations_mine", user_id: RUNNER, session_id: "s1", updated_at: 10, status: "active" },
        { _id: "conversations_theirs", user_id: STRANGER, session_id: "s1", updated_at: 99, status: "completed", inbox_killed_at: 5 },
      ];
      expect((await call({ conversations: mixed }, RUNNER, { session_id: "s1" }))!.status).toBe("active");
      expect(await call({ conversations: mixed }, "users_nobody", { session_id: "s1" })).toBeNull();
    });

    test("an unknown session is null", async () => {
      expect(await call({ conversations: twins() }, RUNNER, { session_id: "s-unknown" })).toBeNull();
    });
  });
});

// A persistent anchor going dormant keeps BOTH the schedules and the queue the
// human left for it. The two kill surfaces must agree about that: applyHideTransition
// (cast kill / the web inbox gesture) and the killSession mutation (the panel and
// /sessions buttons) hit the same session, so a guard on only one of them leaves
// the anchor in a different state depending on which button was pressed.
describe("killSession vs applyHideTransition: one anchor, one answer", () => {
  const ANCHOR = "conversations_anchor";
  const anchorTables = () => ({
    conversations: [{
      _id: ANCHOR, user_id: RUNNER, session_id: "s-anchor", persistent: true,
      status: "active", message_count: 20, has_pending_messages: true,
    }],
    agent_tasks: [{ _id: "t1", user_id: RUNNER, status: "scheduled", originating_conversation_id: ANCHOR }],
    pending_messages: [{ _id: "pm1", conversation_id: ANCHOR, status: "pending", retry_count: 0 }],
    daemon_commands: [], messages: [], managed_sessions: [], client_state: [], session_owners: [],
  });

  const expectAnchorIntact = (tables: any) => {
    expect(tables.agent_tasks[0].status).toBe("scheduled");
    expect(tables.pending_messages[0].status).toBe("pending");
    expect(tables.conversations[0].status).toBe("active");
    expect(tables.conversations[0].has_pending_messages).toBe(true);
    // …but it IS retired from the inbox and its agent IS torn down.
    expect(tables.conversations[0].inbox_killed_at).toBeGreaterThan(0);
    expect(tables.daemon_commands.some((c: any) => c.command === "kill_session")).toBe(true);
  };

  test("the killSession mutation leaves an anchor's schedules and queue alone", async () => {
    const tables = anchorTables();
    const db = makeFakeDb(tables);
    await (killSession as any)._handler(
      { db, auth: { getUserIdentity: async () => ({ subject: `${RUNNER}|session` }) } },
      { conversation_id: ANCHOR, mark_completed: true },
    );
    expectAnchorIntact(tables);
  });

  test("applyHideTransition agrees, given the same anchor", async () => {
    const tables = anchorTables();
    const db = makeFakeDb(tables);
    const doc = { ...tables.conversations[0] };
    const patch = { inbox_dismissed_at: Date.now() };
    await db.patch(ANCHOR, patch);
    await applyHideTransition({ db }, doc, patch, { forceKill: true });
    expectAnchorIntact(tables);
  });
});

// `cast kill` tells the user "cast undismiss <id> to resurface" — undismiss has
// to actually deliver that. shouldShowInInbox hides a row on inbox_killed_at
// ALONE, so clearing only the two hide stamps left the card invisible.
describe("undismiss un-kills", () => {
  const CONV = "conversations_killed";
  const killedTables = () => ({
    conversations: [{
      _id: CONV, user_id: RUNNER, short_id: "abc1234", session_id: "s1", message_count: 9,
      status: "completed", inbox_dismissed_at: 111, inbox_killed_at: 111,
    }],
    agent_tasks: [], daemon_commands: [], messages: [], pending_messages: [],
    managed_sessions: [], client_state: [], session_owners: [],
  });

  test("cast undismiss clears the kill stamp, so the card comes back", async () => {
    const tables = killedTables();
    const db = makeFakeDb(tables);
    // Pre-check: the killed row is invisible to the inbox on the kill stamp alone.
    expect(shouldShowInInbox(tables.conversations[0] as any)).toBe(false);

    const res = await (cliSetSessionVisibility as any)._handler(
      { db, auth: { getUserIdentity: async () => ({ subject: `${RUNNER}|session` }) } },
      { session: "abc1234", action: "undismiss" },
    );
    expect(res.was_hidden).toBe(true);
    const row = tables.conversations[0] as any;
    expect(row.inbox_killed_at).toBeUndefined();
    expect(row.inbox_dismissed_at).toBeUndefined();
    expect(shouldShowInInbox(row)).toBe(true); // visible with no pin required
    // Undismiss resurfaces the CARD; restarting the agent is Restart's job.
    expect(row.status).toBe("completed");
  });
});
