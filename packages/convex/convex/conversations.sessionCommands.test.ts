import { describe, expect, test } from "bun:test";
import { requireSessionCommandTarget, getConversationLifecycle } from "./conversations";
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

  test("a deleted/ghost conversation is refused (kill/restart keep their own recovery)", async () => {
    const ctx = ctxWith({ conversations: [] });
    await expect(requireSessionCommandTarget(ctx, RUNNER, "conversations_gone" as any)).rejects.toThrow("Not authorized");
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

  test("returns the five lifecycle fields for a conversation the caller runs", async () => {
    expect(await call({ conversations: [killedRow] }, RUNNER, { conversation_id: CONV })).toEqual({
      status: "completed",
      inbox_killed_at: 222,
      inbox_dismissed_at: 222,
      inbox_stashed_at: 111,
      inbox_pinned_at: null, // absent stamps normalize to null, never undefined
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
    });
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
