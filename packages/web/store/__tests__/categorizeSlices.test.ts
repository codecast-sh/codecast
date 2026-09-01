import { describe, expect, it } from "bun:test";
import { type InboxSession } from "../inboxStore";
import { placeSections } from "./placeTestHarness";

// Guards the chokepoint's three top-level slices (active `sorted`,
// `dismissed`, `stashed`): same membership, same orders, one walk. Triage
// stamps are recent because the dismissed / stashed windows are 30 days deep.
const NOW = Date.now();
const mk = (id: string, extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `s-${id}`,
  updated_at: NOW,
  agent_type: "claude_code",
  message_count: 2,
  is_idle: true,
  has_pending: false,
  last_user_message: "hi",
  title: id,
  ...extra,
});

const ids = (xs: InboxSession[]) => xs.map((x) => x._id);

describe("placeSections top-level slices", () => {
  it("routes each session to the correct slice (dismiss wins over stash)", () => {
    const sessions: Record<string, InboxSession> = {
      a: mk("a"),
      b: mk("b"),
      d: mk("d", { inbox_dismissed_at: NOW - 100 }),
      s: mk("s", { inbox_stashed_at: NOW - 100 }),
      ds: mk("ds", { inbox_dismissed_at: NOW - 150, inbox_stashed_at: NOW - 50 }),
    };
    const { sorted, dismissed, stashed } = placeSections(sessions, new Set());
    expect(ids(sorted).sort()).toEqual(["a", "b"]); // hidden ones excluded
    expect(ids(dismissed).sort()).toEqual(["d", "ds"]); // ds counts as dismissed
    expect(ids(stashed).sort()).toEqual(["s"]); // ds excluded — dismiss wins
  });

  it("orders dismissed newest-first by inbox_dismissed_at", () => {
    const sessions = {
      old: mk("old", { inbox_dismissed_at: NOW - 300 }),
      neu: mk("neu", { inbox_dismissed_at: NOW - 100 }),
      mid: mk("mid", { inbox_dismissed_at: NOW - 200 }),
    };
    const { dismissed } = placeSections(sessions, new Set());
    expect(ids(dismissed)).toEqual(["neu", "mid", "old"]);
  });

  it("orders stashed newest-first by inbox_stashed_at", () => {
    const sessions = {
      old: mk("old", { inbox_stashed_at: NOW - 300 }),
      neu: mk("neu", { inbox_stashed_at: NOW - 100 }),
      mid: mk("mid", { inbox_stashed_at: NOW - 200 }),
    };
    const { stashed } = placeSections(sessions, new Set());
    expect(ids(stashed)).toEqual(["neu", "mid", "old"]);
  });

  it("sorts active sessions pinned-first with _id as the stable tiebreak", () => {
    const sessions = {
      z: mk("z"),
      a: mk("a"),
      p: mk("p", { is_pinned: true }),
    };
    const { sorted } = placeSections(sessions, new Set());
    expect(ids(sorted)).toEqual(["p", "a", "z"]);
  });

  it("shows a kept-draft blank in New (engaged-blank gate) while hiding plain blanks", () => {
    const sessions = {
      warm: mk("warm", { message_count: 0 }),
      draft: mk("draft", { message_count: 0, _hasDraft: true }),
    };
    const { newSessions } = placeSections(sessions, new Set());
    expect(ids(newSessions)).toEqual(["draft"]);
  });
});
