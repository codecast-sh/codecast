import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  placeInboxRows,
  __resetInboxPlacementCacheForTests,
  type InboxSession,
  type PlaceInboxState,
} from "../inboxStore";

// The session you are looking at is always on the list. A line station is a
// subagent of its run's log session, and a task's run log is born stashed and
// hidden, so the station has no listed parent to nest under. While focused it
// files on its own facts as a loose card; unfocused it stays off the list.

const NOW = 1_800_000_000_000 + 25_000;
const ME = "u".repeat(32);
const RUN_LOG = "r".repeat(32);
const STATION = "s".repeat(32);
const OTHER = "o".repeat(32);

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  nowSpy = spyOn(Date, "now").mockReturnValue(NOW);
  __resetInboxPlacementCacheForTests();
});
afterEach(() => nowSpy.mockRestore());

function row(id: string, extra: Partial<InboxSession> = {}): InboxSession {
  return {
    _id: id, session_id: `s-${id.slice(0, 3)}`, agent_type: "claude_code", user_id: ME, status: "active",
    message_count: 6, is_idle: true, has_pending: false, title: `t-${id.slice(0, 1)}`, updated_at: NOW - 60_000,
    started_at: NOW - 3_600_000, ...extra,
  } as InboxSession;
}
const station = (extra: Partial<InboxSession> = {}) =>
  row(STATION, { is_subagent: true, parent_conversation_id: RUN_LOG, title: "Refine · ct-1", ...extra } as Partial<InboxSession>);

function state(sessions: Record<string, InboxSession>): PlaceInboxState {
  return {
    sessions,
    killedShelf: { ids: [] },
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

const SECTIONS = ["questions", "pinned", "newSessions", "needsInput", "done", "dormant", "working"] as const;
const flatIds = (placed: ReturnType<typeof placeInboxRows>) => SECTIONS.flatMap((k) => placed[k].map((s) => s._id));

describe("a focused child row whose parent is not listed", () => {
  it("files as a loose card while it is the open session", () => {
    const s = state({ [STATION]: station(), [OTHER]: row(OTHER) });
    const placed = placeInboxRows(s, { scope: "mine", focusedId: STATION, now: NOW });
    expect(flatIds(placed)).toContain(STATION);
    // Never a working-set member: the tally only counts the other row.
    const shown = Object.values(placed.tally.shown).reduce((a, b) => a + b, 0);
    expect(shown).toBe(1);
  });

  it("stays off the list when another session is open", () => {
    const s = state({ [STATION]: station(), [OTHER]: row(OTHER) });
    const placed = placeInboxRows(s, { scope: "mine", focusedId: OTHER, now: NOW });
    expect(flatIds(placed)).not.toContain(STATION);
  });

  it("files loose when its parent is stashed", () => {
    const s = state({ [STATION]: station(), [RUN_LOG]: row(RUN_LOG, { inbox_stashed_at: NOW - 3_600_000 }) });
    const placed = placeInboxRows(s, { scope: "mine", focusedId: STATION, now: NOW });
    expect(flatIds(placed)).toContain(STATION);
  });

  it("still nests under an active parent", () => {
    const s = state({ [STATION]: station(), [RUN_LOG]: row(RUN_LOG) });
    const placed = placeInboxRows(s, { scope: "mine", focusedId: STATION, now: NOW });
    expect(flatIds(placed)).not.toContain(STATION);
    expect(placed.subsByParent.get(RUN_LOG)?.map((r) => r._id)).toEqual([STATION]);
  });
});
