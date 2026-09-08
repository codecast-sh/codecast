import { describe, expect, test } from "bun:test";
import { computeInboxSessions, tallyInboxRows } from "./conversations";
import { makeFakeDb } from "./testDb";

// `cast sessions <id>` naming a subagent threw "tallyInboxRows: row … is not
// stamped with a projection" and took down the whole inbox (ct-49761).
//
// One emission, no stamp. computeInboxSessions stamped the projection onto the
// ENRICHED top-level rows only, and a subagent never becomes one:
// shouldShowInInbox drops subagents from the candidate set even when the caller
// names the id. Its only emission is buildSubagentChildRow under its parent —
// the row the stamp loop never touched. So naming any subagent by id threw and
// took every other session in the answer with it.
const ME = "users_me";
const H = 60 * 60 * 1000;
const NOW = Date.now();

function fixtures() {
  return makeFakeDb({
    users: [{ _id: ME, name: "Me", email: "me@example.com" }],
    conversations: [
      {
        _id: "conversations_parent",
        user_id: ME,
        status: "active",
        updated_at: NOW,
        started_at: NOW - H,
        message_count: 8,
        last_message_role: "assistant",
        title: "Orca deep dive",
      },
      {
        _id: "conversations_sub",
        user_id: ME,
        status: "active",
        updated_at: NOW,
        started_at: NOW - H,
        message_count: 30,
        last_message_role: "user",
        is_subagent: true,
        parent_conversation_id: "conversations_parent",
        title: "Clipboard injection fix review",
      },
    ],
    session_owners: [],
    managed_sessions: [],
    messages: [],
  });
}

const run = (db: any) =>
  computeInboxSessions({ db }, ME as any, {
    show_all: true,
    projection: true,
    extraConvIds: ["conversations_sub"],
  });

describe("every emitted inbox row carries the projection stamp", () => {
  test("every projected row carries a stamp, the subagent child included", async () => {
    const { sessions } = await run(fixtures());
    for (const s of sessions) {
      expect({ id: s._id.toString(), work_state: s.work_state, bucket: s.bucket }).toEqual({
        id: s._id.toString(),
        work_state: expect.any(String),
        bucket: expect.any(String),
      });
    }
    expect(sessions.map((s: any) => s._id.toString())).toContain("conversations_sub");
  });

  test("without projection:true the child stays unstamped — the web base list owns its own bucket", async () => {
    const { sessions } = await computeInboxSessions({ db: fixtures() }, ME as any, { show_all: true });
    const sub = sessions.find((s: any) => s._id.toString() === "conversations_sub");
    expect(sub.bucket).toBeUndefined();
    expect(sub.work_state).toBeUndefined();
  });

  test("`cast sessions <subagent-id>` tallies instead of throwing", async () => {
    const { sessions } = await run(fixtures());
    const { counts, rows } = tallyInboxRows(sessions, {
      showAll: true,
      stateFilter: null,
      labelByConv: new Map(),
      requestedIds: new Set(["conversations_sub"]),
    });
    expect(counts.unstamped).toBe(0);
    expect(rows.map((r) => r.id.toString()).sort()).toEqual([
      "conversations_parent",
      "conversations_sub",
    ]);
  });
});

describe("one stampless row degrades to one missing row, never a dead inbox", () => {
  const row = (over: Record<string, any> = {}) => ({
    _id: "conversations_ok",
    session_id: "sess-ok",
    title: "Ship the thing",
    updated_at: NOW,
    message_count: 3,
    work_state: "idle",
    bucket: "idle",
    is_subagent: false,
    is_pinned: false,
    is_connected: false,
    ...over,
  });

  test("the stampless row is skipped and counted; its neighbours still list", () => {
    const { counts, rows } = tallyInboxRows(
      [row(), row({ _id: "conversations_bad", session_id: "sess-bad", work_state: undefined, bucket: undefined })],
      { showAll: true, stateFilter: null, labelByConv: new Map() },
    );
    expect(counts.unstamped).toBe(1);
    expect(counts.total).toBe(1);
    expect(rows.map((r) => r.id.toString())).toEqual(["conversations_ok"]);
  });
});
