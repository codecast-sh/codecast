import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { placeInboxRows, __resetInboxPlacementCacheForTests, type InboxSession, type PlaceInboxState } from "../inboxStore";

// The Closed bucket lists a closed session the shelf paged in (an old close
// outside the scan's window) the way it lists an old kill. A row whose close
// was undone keeps a stale inbox_closed_at and is not listed.
const NOW = 1_800_000_000_000;
const ME = "u".repeat(32);
const OLD = NOW - 60 * 24 * 3_600_000;

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => { nowSpy = spyOn(Date, "now").mockReturnValue(NOW); __resetInboxPlacementCacheForTests(); });
afterEach(() => nowSpy.mockRestore());

const row = (id: string, extra: Partial<InboxSession>): InboxSession => ({
  _id: id, session_id: `s-${id[0]}`, agent_type: "claude_code", user_id: ME, status: "active", message_count: 6, is_idle: true,
  has_pending: false, title: `t-${id[0]}`, updated_at: OLD, started_at: OLD, ...extra,
} as InboxSession);

const state = (sessions: Record<string, InboxSession>, shelf: string[]): PlaceInboxState => ({
  sessions, killedShelf: { ids: shelf }, sessionsWithQueuedMessages: new Set(), pendingMessages: {},
  clientState: { ui: { inbox_scope: "mine", inbox_show_old: true } }, currentUser: { _id: ME }, sessionDecisions: {},
  questionResolutions: {}, pendingSessionCreates: {}, blockedReviveRequestedAt: {}, currentSessionId: null,
  sessionsProjection: {}, teamInboxIds: new Set(), pending: {},
} as unknown as PlaceInboxState);

describe("the Closed bucket's shelf rows", () => {
  it("lists an old close the shelf paged in, and not a stale marker", () => {
    const CLOSED = "c".repeat(32);
    const UNDONE = "d".repeat(32);
    const placed = placeInboxRows(state({
      [CLOSED]: row(CLOSED, { inbox_dismissed_at: OLD, inbox_closed_at: OLD }),
      [UNDONE]: row(UNDONE, { inbox_closed_at: OLD, inbox_dismissed_at: null }),
    }, [CLOSED, UNDONE]), { scope: "mine", focusedId: null, now: NOW });
    const ids = placed.dismissed.map((s) => s._id);
    expect(ids).toContain(CLOSED);
    expect(ids).not.toContain(UNDONE);
  });
});
