import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  placeInboxRows,
  __resetInboxPlacementCacheForTests,
  KILLED_RECENT_MS,
  type InboxSession,
  type PlaceInboxState,
} from "../inboxStore";

// The Killed bucket lists kills from the replica's own cached stamps — a kill
// is a working-set nonmember on every replica (inWorkingSet mirrors the
// server's cap exclusion of killed rows), so placement never sees it and the
// bucket would otherwise hold only pinned kills and plain dismissals (ct-50248).
// Presentation only: membership, the tally and the placements map stay as the
// shared computation produced them.

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000 + 25_000;
const ME = "u".repeat(32);
const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);
const D = "d".repeat(32);
const KID = "e".repeat(32);

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  nowSpy = spyOn(Date, "now").mockReturnValue(NOW);
  __resetInboxPlacementCacheForTests();
});
afterEach(() => nowSpy.mockRestore());

function row(id: string, extra: Partial<InboxSession>): InboxSession {
  return {
    _id: id, session_id: `s-${id.slice(0, 3)}`, agent_type: "claude_code", user_id: ME, status: "completed",
    message_count: 6, is_idle: true, has_pending: false, title: `t-${id.slice(0, 1)}`, ...extra,
  } as InboxSession;
}
function killed(id: string, killedAt: number, extra: Partial<InboxSession> = {}): InboxSession {
  return row(id, { inbox_killed_at: killedAt, inbox_dismissed_at: killedAt, updated_at: killedAt - 60_000, ...extra });
}
function state(sessions: Record<string, InboxSession>, shelfIds: string[] = []): PlaceInboxState {
  return {
    sessions,
    killedShelf: { ids: shelfIds },
    sessionsWithQueuedMessages: new Set(),
    pendingMessages: {},
    clientState: { ui: { inbox_scope: "mine", inbox_show_old: true } },
    currentUser: { _id: ME },
    sessionDecisions: {},
    questionResolutions: {},
    pendingSessionCreates: {},
    blockedReviveRequestedAt: {},
    currentSessionId: null,
    sessionsProjection: {},
    teamInboxIds: new Set(),
    pending: {},
  } as unknown as PlaceInboxState;
}
const dismissedIds = (s: PlaceInboxState) => placeInboxRows(s, { scope: "mine", now: NOW }).dismissed.map((r) => r._id);

describe("the Killed bucket lists cached kills", () => {
  it("a recent unpinned kill lists in the bucket without becoming a member", () => {
    const s = state({ [A]: killed(A, NOW - DAY) });
    const placed = placeInboxRows(s, { scope: "mine", now: NOW });
    expect(placed.dismissed.map((r) => r._id)).toEqual([A]);
    // Nonmember: the shared selection never placed it, and the tally is silent.
    expect(placed.placements.has(A)).toBe(false);
    expect(placed.sorted.map((r) => r._id)).toEqual([]);
  });

  it("kills older than the recent horizon stay out until the shelf pages them in", () => {
    const old = killed(A, NOW - KILLED_RECENT_MS - DAY);
    expect(dismissedIds(state({ [A]: old }))).toEqual([]);
    expect(dismissedIds(state({ [A]: old }, [A]))).toEqual([A]);
  });

  it("orders by retirement time, kills and plain dismissals interleaved, newest first", () => {
    const s = state({
      [A]: killed(A, NOW - 3 * DAY),
      [B]: row(B, { inbox_dismissed_at: NOW - DAY, updated_at: NOW - 2 * DAY }),
      [C]: killed(C, NOW - 2 * DAY),
    });
    expect(dismissedIds(s)).toEqual([B, C, A]);
  });

  it("a pinned kill lists once — the shared placement already filed it", () => {
    const s = state({ [A]: killed(A, NOW - DAY, { inbox_pinned_at: NOW - 2 * DAY, is_pinned: true }) });
    expect(dismissedIds(s)).toEqual([A]);
  });

  it("subagent children never list on their own", () => {
    const s = state({
      [D]: killed(D, NOW - DAY),
      [KID]: killed(KID, NOW - DAY, { is_subagent: true, parent_conversation_id: D }),
    });
    expect(dismissedIds(s)).toEqual([D]);
  });

  it("a shelf id with no cached row is ignored", () => {
    expect(dismissedIds(state({}, [A]))).toEqual([]);
  });

  it("the memo wakes when the shelf changes", () => {
    const old = killed(A, NOW - KILLED_RECENT_MS - DAY);
    const sessions = { [A]: old };
    expect(dismissedIds(state(sessions))).toEqual([]);
    expect(dismissedIds(state(sessions, [A]))).toEqual([A]);
  });
});
