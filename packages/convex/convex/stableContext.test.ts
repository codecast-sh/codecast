import { describe, expect, test } from "bun:test";
import { consumeStableContextSpool } from "./conversations";
import { enqueueStartSession } from "./devices";
import { makeFakeDb } from "./testDb";

const USER = "users_1" as any;

function spoolRow(overrides: Record<string, any> = {}) {
  return {
    _id: "stable_context_spool_1",
    user_id: USER,
    session_id: "uuid-real",
    data: JSON.stringify({ mode: "team", injected_at: 123, items: [] }),
    created_at: Date.now(),
    ...overrides,
  };
}

describe("consumeStableContextSpool", () => {
  test("attaches a parked record to the conversation and deletes the spool row", async () => {
    const db = makeFakeDb({
      conversations: [{ _id: "conversations_1", user_id: USER, session_id: "uuid-real" }],
      stable_context_spool: [spoolRow()],
      conversation_context: [],
    });

    await consumeStableContextSpool({ db }, USER, "uuid-real", "conversations_1" as any);

    // The record lives on the conversation_context side row, not the hot doc.
    expect(db._tables.conversation_context).toHaveLength(1);
    expect(db._tables.conversation_context[0].conversation_id).toBe("conversations_1");
    expect(db._tables.conversation_context[0].stable_context).toContain('"mode":"team"');
    expect(db._tables.conversations[0].stable_context).toBeUndefined();
    expect(db._tables.stable_context_spool).toHaveLength(0);
  });

  test("never clobbers a record already on the conversation", async () => {
    const db = makeFakeDb({
      conversations: [{ _id: "conversations_1", user_id: USER, session_id: "uuid-real", stable_context: "existing" }],
      stable_context_spool: [spoolRow()],
      conversation_context: [],
    });

    await consumeStableContextSpool({ db }, USER, "uuid-real", "conversations_1" as any);

    expect(db._tables.conversations[0].stable_context).toBe("existing");
    expect(db._tables.conversation_context).toHaveLength(0);
    // Consumed regardless — the spool is transient.
    expect(db._tables.stable_context_spool).toHaveLength(0);
  });

  test("no-op when nothing is spooled for the session", async () => {
    const db = makeFakeDb({
      conversations: [{ _id: "conversations_1", user_id: USER, session_id: "uuid-real" }],
      stable_context_spool: [spoolRow({ session_id: "some-other-session" })],
      conversation_context: [],
    });

    await consumeStableContextSpool({ db }, USER, "uuid-real", "conversations_1" as any);

    expect(db._tables.conversations[0].stable_context).toBeUndefined();
    expect(db._tables.conversation_context).toHaveLength(0);
    expect(db._tables.stable_context_spool).toHaveLength(1);
  });
});

describe("enqueueStartSession stable-context prefs", () => {
  test("stable prefs ride the start_session args; omitted when unset", async () => {
    const db = makeFakeDb({
      conversations: [{ _id: "conversations_1", user_id: USER, session_id: "stub" }],
      devices: [],
      daemon_commands: [],
    });

    await enqueueStartSession({ db }, USER, {
      conversationId: "conversations_1" as any,
      agentType: "claude",
      projectPath: "/tmp/p",
      stableMode: "off",
      stableExclude: ["jx7aaaa", "jx7bbbb"],
    });
    let args = JSON.parse(db._tables.daemon_commands[0].args);
    expect(args.stable_mode).toBe("off");
    expect(args.stable_exclude).toEqual(["jx7aaaa", "jx7bbbb"]);

    await enqueueStartSession({ db }, USER, {
      conversationId: "conversations_1" as any,
      agentType: "claude",
      projectPath: "/tmp/p",
    });
    args = JSON.parse(db._tables.daemon_commands[1].args);
    expect("stable_mode" in args).toBe(false);
    expect("stable_exclude" in args).toBe(false);
  });
});
