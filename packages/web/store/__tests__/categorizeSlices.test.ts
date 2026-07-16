import { describe, expect, it } from "bun:test";
import { categorizeSessions, type InboxSession } from "../inboxStore";

// Guards the single-walk consolidation of categorizeSessions' three top-level
// slices (active `sorted`, `dismissed`, `stashed`) — previously three separate
// Object.values scans, now one pass. Output must be byte-identical: same
// membership, same orders.
const mk = (id: string, extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `s-${id}`,
  updated_at: 1,
  agent_type: "claude_code",
  message_count: 2,
  is_idle: true,
  has_pending: false,
  last_user_message: "hi",
  title: id,
  ...extra,
});

const ids = (xs: InboxSession[]) => xs.map((x) => x._id);

describe("categorizeSessions top-level slices", () => {
  it("routes each session to the correct slice (dismiss wins over stash)", () => {
    const sessions: Record<string, InboxSession> = {
      a: mk("a"),
      b: mk("b"),
      d: mk("d", { inbox_dismissed_at: 100 }),
      s: mk("s", { inbox_stashed_at: 100 }),
      ds: mk("ds", { inbox_dismissed_at: 50, inbox_stashed_at: 200 }),
    };
    const { sorted, dismissed, stashed } = categorizeSessions(sessions, new Set());
    expect(ids(sorted).sort()).toEqual(["a", "b"]); // hidden ones excluded
    expect(ids(dismissed).sort()).toEqual(["d", "ds"]); // ds counts as dismissed
    expect(ids(stashed).sort()).toEqual(["s"]); // ds excluded — dismiss wins
  });

  it("orders dismissed newest-first by inbox_dismissed_at", () => {
    const sessions = {
      old: mk("old", { inbox_dismissed_at: 100 }),
      neu: mk("neu", { inbox_dismissed_at: 300 }),
      mid: mk("mid", { inbox_dismissed_at: 200 }),
    };
    const { dismissed } = categorizeSessions(sessions, new Set());
    expect(ids(dismissed)).toEqual(["neu", "mid", "old"]);
  });

  it("orders stashed newest-first by inbox_stashed_at", () => {
    const sessions = {
      old: mk("old", { inbox_stashed_at: 100 }),
      neu: mk("neu", { inbox_stashed_at: 300 }),
      mid: mk("mid", { inbox_stashed_at: 200 }),
    };
    const { stashed } = categorizeSessions(sessions, new Set());
    expect(ids(stashed)).toEqual(["neu", "mid", "old"]);
  });

  it("sorts active sessions pinned-first with _id as the stable tiebreak", () => {
    const sessions = {
      z: mk("z"),
      a: mk("a"),
      p: mk("p", { is_pinned: true }),
    };
    const { sorted } = categorizeSessions(sessions, new Set());
    expect(ids(sorted)).toEqual(["p", "a", "z"]);
  });
});
