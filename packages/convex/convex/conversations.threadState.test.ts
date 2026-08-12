import { describe, expect, test } from "bun:test";
import { setThreadState, getThreadState } from "./conversations";
import { makeFakeDb } from "./testDb";

// The pinned thread state (`cast state`). Two things must hold or the feature
// lies to the reader: a write stamps the message_count it was written at (that
// gap is the whole staleness signal), and an empty write CLEARS rather than
// pinning an empty line.

const RUNNER = "users_runner" as any;
const OWNER = "users_owner" as any;
const STRANGER = "users_stranger" as any;

const CONV = "conversations_1";

function tablesWith(extra: Record<string, unknown> = {}) {
  return {
    conversations: [{
      _id: CONV,
      user_id: RUNNER,
      owner_user_id: OWNER,
      short_id: "abc1234",
      session_id: "s1",
      title: "Auth fix",
      message_count: 42,
      ...extra,
    }],
    managed_sessions: [],
    session_owners: [],
  } as Record<string, any[]>;
}

function ctxAs(db: any, userId: string) {
  return { db, auth: { getUserIdentity: async () => ({ subject: `${userId}|session` }) } } as any;
}

describe("setThreadState", () => {
  test("a write pins the text and stamps when the thread stood there", async () => {
    const tables = tablesWith();
    const db = makeFakeDb(tables);
    const res = await (setThreadState as any)._handler(ctxAs(db, RUNNER), {
      session: "abc1234",
      text: "  Blocked: needs the prod key\n\n\n  Next: deploy  ",
    });

    expect(res.ok).toBe(true);
    expect(res.cleared).toBe(false);
    expect(res.short_id).toBe("abc1234");
    const row = tables.conversations[0] as any;
    // Normalized on the way in, so every reader gets the same text.
    expect(row.thread_state).toBe("Blocked: needs the prod key\n\nNext: deploy");
    expect(row.thread_state_msg_count).toBe(42);
    expect(typeof row.thread_state_at).toBe("number");
  });

  test("a second write replaces the first and reports what it replaced", async () => {
    const tables = tablesWith({ thread_state: "Waiting on CI", thread_state_at: 1, thread_state_msg_count: 3 });
    const db = makeFakeDb(tables);
    const res = await (setThreadState as any)._handler(ctxAs(db, RUNNER), {
      session: "abc1234",
      text: "CI green, deploying",
    });

    expect(res.previous_state).toBe("Waiting on CI");
    expect((tables.conversations[0] as any).thread_state).toBe("CI green, deploying");
    expect((tables.conversations[0] as any).thread_state_msg_count).toBe(42);
  });

  test("empty text clears the state rather than pinning a blank line", async () => {
    const tables = tablesWith({ thread_state: "Waiting on CI", thread_state_at: 1, thread_state_msg_count: 3 });
    const db = makeFakeDb(tables);
    const res = await (setThreadState as any)._handler(ctxAs(db, RUNNER), { session: "abc1234", text: "   \n " });

    expect(res.cleared).toBe(true);
    expect(res.previous_state).toBe("Waiting on CI");
    const row = tables.conversations[0] as any;
    expect(row.thread_state).toBeUndefined();
    // The provenance goes with it — a stamp without text would read as a state
    // written at message 3 that nobody can see.
    expect(row.thread_state_at).toBeUndefined();
    expect(row.thread_state_msg_count).toBeUndefined();
  });

  test("clearing a session that had none is a quiet no-op", async () => {
    const tables = tablesWith();
    const db = makeFakeDb(tables);
    const res = await (setThreadState as any)._handler(ctxAs(db, RUNNER), { session: "abc1234" });
    expect(res.cleared).toBe(true);
    expect(res.previous_state).toBeNull();
  });

  test("the second-party owner may write it; a stranger may not", async () => {
    const tables = tablesWith();
    const db = makeFakeDb(tables);
    const res = await (setThreadState as any)._handler(ctxAs(db, OWNER), { session: "abc1234", text: "owner wrote this" });
    expect(res.ok).toBe(true);

    await expect(
      (setThreadState as any)._handler(ctxAs(makeFakeDb(tablesWith()), STRANGER), {
        session: "abc1234",
        text: "stranger",
      }),
    ).rejects.toThrow("No session found");
  });

  test("an overlong state is truncated, not rejected", async () => {
    const tables = tablesWith();
    const db = makeFakeDb(tables);
    await (setThreadState as any)._handler(ctxAs(db, RUNNER), { session: "abc1234", text: "x".repeat(5000) });
    const row = tables.conversations[0] as any;
    expect(row.thread_state.length).toBe(1200);
    expect(row.thread_state.endsWith("…")).toBe(true);
  });
});

describe("getThreadState", () => {
  test("returns the state with both counts, so a reader can judge staleness", async () => {
    const tables = tablesWith({ thread_state: "Waiting on CI", thread_state_at: 5, thread_state_msg_count: 3 });
    const db = makeFakeDb(tables);
    const res = await (getThreadState as any)._handler(ctxAs(db, RUNNER), { session: "abc1234" });

    expect(res.state).toBe("Waiting on CI");
    expect(res.msg_count_at_write).toBe(3);
    expect(res.message_count).toBe(42);
    expect(res.title).toBe("Auth fix");
  });

  test("a session with no state reads as null, not an error", async () => {
    const db = makeFakeDb(tablesWith());
    const res = await (getThreadState as any)._handler(ctxAs(db, RUNNER), { session: "abc1234" });
    expect(res.state).toBeNull();
    expect(res.at).toBeNull();
  });

  test("a stranger cannot read it", async () => {
    const db = makeFakeDb(tablesWith({ thread_state: "secret" }));
    await expect(
      (getThreadState as any)._handler(ctxAs(db, STRANGER), { session: "abc1234" }),
    ).rejects.toThrow("No session found");
  });
});
