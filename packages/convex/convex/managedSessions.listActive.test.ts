import { describe, expect, test } from "bun:test";
import { makeFakeDb } from "./testDb";
import { performListActiveSessions } from "./managedSessions";

// The /sessions page is the PROCESS/TMUX view, not the inbox. It used to drop
// every killed row, so killing a session from that page made it vanish
// instantly — and a teardown that didn't take left the session invisible on the
// one surface built to catch that, while its tmux and process kept heartbeating.
// The investigation behind this page started at "why are there 41 tmux sessions
// but only ~10 in my sidebar?", so hiding rows here defeats its purpose.

const USER = "u".repeat(31) + "a";
const OTHER = "u".repeat(31) + "b";

function fixtures(convs: Array<Record<string, any>>) {
  const now = Date.now();
  return makeFakeDb({
    managed_sessions: convs.map((c, i) => ({
      _id: `ms${i}`,
      session_id: `sess${i}`,
      conversation_id: c._id,
      user_id: USER,
      pid: 100 + i,
      started_at: now - 60_000,
      last_heartbeat: now,
    })),
    conversations: convs,
    session_metrics: [],
    session_insights: [],
  });
}

describe("listActiveSessions surfaces killed rows", () => {
  test("a killed session is LISTED, not dropped", async () => {
    const db = fixtures([
      { _id: "conv_killed", user_id: USER, title: "Retired", inbox_killed_at: 111 },
    ]);
    const rows = await performListActiveSessions({ db } as any, USER as any);
    expect(rows).toHaveLength(1);
    expect(rows[0].conversation_title).toBe("Retired");
  });

  // The page cannot get this from its listInboxSessions join: computeInbox
  // Sessions applies shouldShowInInbox unconditionally, which drops a
  // killed-and-unpinned row — precisely the rows revealed here. So the marker
  // has to ride the projection or the badge can never render.
  test("the row carries is_killed so the page needs no join", async () => {
    const db = fixtures([
      { _id: "conv_killed", user_id: USER, title: "Retired", inbox_killed_at: 111 },
    ]);
    const rows = await performListActiveSessions({ db } as any, USER as any);
    expect(rows[0].is_killed).toBe(true);
  });

  test("a live session reports is_killed false, not undefined", async () => {
    const db = fixtures([{ _id: "conv_live", user_id: USER, title: "Working" }]);
    const rows = await performListActiveSessions({ db } as any, USER as any);
    expect(rows[0].is_killed).toBe(false);
  });

  // Conversation-less tmux-only rows are listed too; they must not read as killed.
  test("a session with no conversation reports is_killed false", async () => {
    const db = makeFakeDb({
      managed_sessions: [{
        _id: "ms_bare", session_id: "sess_bare", user_id: USER,
        pid: 1, started_at: Date.now(), last_heartbeat: Date.now(),
      }],
      conversations: [], session_metrics: [], session_insights: [],
    });
    const rows = await performListActiveSessions({ db } as any, USER as any);
    expect(rows).toHaveLength(1);
    expect(rows[0].is_killed).toBe(false);
  });

  test("killed and live sessions are listed side by side", async () => {
    const db = fixtures([
      { _id: "conv_killed", user_id: USER, title: "Retired", inbox_killed_at: 111 },
      { _id: "conv_live", user_id: USER, title: "Working" },
    ]);
    const rows = await performListActiveSessions({ db } as any, USER as any);
    expect(rows).toHaveLength(2);
    expect(rows.map((r: any) => r.is_killed).sort()).toEqual([false, true]);
  });

  // The 24h last_heartbeat cutoff stays the ONLY bound on the reveal: a session
  // whose teardown succeeded stops beating and ages out on its own, so killed
  // rows cannot accumulate indefinitely. (The fake db treats .gte as a no-op, so
  // this pins the user scope rather than the cutoff arithmetic.)
  test("the scan stays scoped to the calling user", async () => {
    const db = fixtures([
      { _id: "conv_killed", user_id: USER, title: "Retired", inbox_killed_at: 111 },
    ]);
    const rows = await performListActiveSessions({ db } as any, OTHER as any);
    expect(rows).toHaveLength(0);
  });
});
