import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  lastPlacedInbox,
  placedInboxVersion,
  placeInboxRows,
  subscribePlacedInbox,
  railRowPlacement,
  sidebarStatusOf,
  __resetInboxPlacementCacheForTests,
  type InboxSession,
  type PlaceInboxState,
} from "../inboxStore";
import { declaredOfPlacement, threadStateView } from "../../lib/threadState";

// The rule: a pin's status chip agrees with the status section the sidebar drew
// the row in. Section assembly moves rows past their placement (an open ask
// under Questions, a wait the viewer cannot command under Dormant), so the chip
// reads the drawn section, never the bucket alone.

const NOW = 1_800_000_000_000;
const ME = "m".repeat(32);
const RUNNER = "r".repeat(32);
const ASKER = "a".repeat(32);
const THEIRS = "b".repeat(32);

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  nowSpy = spyOn(Date, "now").mockReturnValue(NOW);
  __resetInboxPlacementCacheForTests();
});
afterEach(() => nowSpy.mockRestore());

function session(id: string, extra: Partial<InboxSession>): InboxSession {
  return {
    _id: id, session_id: `s-${id.slice(0, 3)}`, agent_type: "claude_code", status: "active",
    message_count: 8, is_idle: true, has_pending: false, title: `t-${id.slice(0, 1)}`,
    thread_state: "Where this stands", thread_state_at: NOW - 60_000, thread_state_msg_count: 8,
    updated_at: NOW - 60_000, ...extra,
  } as InboxSession;
}

function state(sessions: Record<string, InboxSession>, scope: "mine" | "team", sessionDecisions: Record<string, unknown> = {}): PlaceInboxState {
  return {
    sessions,
    killedShelf: { ids: [] },
    sessionsWithQueuedMessages: new Set(),
    pendingMessages: {},
    clientState: { ui: { inbox_scope: scope, inbox_show_old: true } },
    currentUser: { _id: ME },
    sessionDecisions,
    questionResolutions: {},
    pendingSessionCreates: {},
    blockedReviveRequestedAt: {},
    currentSessionId: null,
    sessionsProjection: {},
    teamInboxIds: new Set(Object.keys(sessions)),
    pending: {},
  } as unknown as PlaceInboxState;
}

describe("sidebarStatusOf: the chip follows the section the sidebar drew", () => {
  it("an open ask files the row under Questions, so a dormant pin shows no chip", () => {
    const asker = session(ASKER, { user_id: ME, agent_status: "dormant", thread_state_status: "dormant" });
    const s = state({ [ASKER]: asker }, "mine", {
      d1: { _id: "d1", conversation_id: ASKER, session_id: "s-asker", question: "Which flow?", options: [{ label: "Ship" }, { label: "Wait" }], blocking: true, status: "pending", created_at: NOW - 30_000 },
    });
    const placed = placeInboxRows(s, { now: NOW });
    expect(placed.questions.map((r) => r._id)).toEqual([ASKER]);
    // On its own the row reads dormant: the ask is an overlay.
    expect(railRowPlacement(asker, NOW).bucket).toBe("dormant");
    expect(sidebarStatusOf(s, asker, NOW)).toBe("blocked");
    expect(threadStateView(asker, 8, NOW, sidebarStatusOf(s, asker, NOW))!.status).toBeNull();
  });

  it("a teammate's wait the viewer cannot command is drawn under Dormant, past its needs_input bucket", () => {
    const theirs = session(THEIRS, { user_id: RUNNER, agent_status: "idle", thread_state_status: "blocked" });
    const s = state({ [THEIRS]: theirs }, "team");
    const placed = placeInboxRows(s, { scope: "team", now: NOW });
    expect(placed.placements.get(THEIRS)?.bucket).toBe("needs_input");
    expect(placed.dormant.map((r) => r._id)).toEqual([THEIRS]);
    expect(sidebarStatusOf(s, theirs, NOW)).toBe("dormant");
    // Its "blocked" pin is not the viewer's to answer: no Needs you chip in a Dormant row.
    expect(threadStateView(theirs, 8, NOW, sidebarStatusOf(s, theirs, NOW))!.status).toBeNull();
  });

  it("a placement past the minute before now is a rail nobody draws (a closed phone drawer): the row reads its own", () => {
    const asker = session(ASKER, { user_id: ME, agent_status: "dormant", thread_state_status: "dormant" });
    const s = state({ [ASKER]: asker }, "mine", {
      d1: { _id: "d1", conversation_id: ASKER, session_id: "s-asker", question: "Which flow?", options: [{ label: "Ship" }], blocking: true, status: "pending", created_at: NOW - 30_000 },
    });
    placeInboxRows(s, { now: NOW });
    expect(sidebarStatusOf(s, asker, NOW + 60_000)).toBe("blocked");
    const later = NOW + 3 * 60_000;
    nowSpy.mockReturnValue(later);
    // The question overlay is gone with the stale placement: what is left is the row's own verdict at `later`.
    expect(sidebarStatusOf(s, asker, later)).toBe(declaredOfPlacement(railRowPlacement(asker, later)));
    expect(lastPlacedInbox(s)?.questions.map((r) => r._id)).toEqual([ASKER]);
  });

  it("while liveness facts are held (waking from sleep, offline) it reads the sidebar's held placement", () => {
    const asker = session(ASKER, { user_id: ME, agent_status: "dormant", thread_state_status: "dormant" });
    const s = { ...state({ [ASKER]: asker }, "mine", {
      d1: { _id: "d1", conversation_id: ASKER, session_id: "s-asker", question: "Which flow?", options: [{ label: "Ship" }], blocking: true, status: "pending", created_at: NOW - 30_000 },
    }), livenessHeldAt: NOW } as PlaceInboxState;
    const later = NOW + 10 * 60_000;
    nowSpy.mockReturnValue(later);
    expect(placeInboxRows(s, { now: later }).questions.map((r) => r._id)).toEqual([ASKER]);
    expect(sidebarStatusOf(s, asker, later)).toBe("blocked");
  });

  it("a surface reading the placement hears each new placement once, after the render that made it", async () => {
    const asker = session(ASKER, { user_id: ME, agent_status: "dormant", thread_state_status: "dormant" });
    const s = state({ [ASKER]: asker }, "mine");
    let heard = 0;
    const off = subscribePlacedInbox(() => { heard++; });
    const before = placedInboxVersion();
    placeInboxRows(s, { now: NOW });
    expect(heard).toBe(0);
    await Promise.resolve();
    expect(heard).toBe(1);
    expect(placedInboxVersion()).toBeGreaterThan(before);
    // The same placement again is no news.
    placeInboxRows(s, { now: NOW });
    await Promise.resolve();
    expect(heard).toBe(1);
    off();
  });

  it("a row the sidebar has not drawn reads its own placement", () => {
    const asker = session(ASKER, { user_id: ME, agent_status: "dormant", thread_state_status: "dormant" });
    expect(sidebarStatusOf(state({ [ASKER]: asker }, "mine"), asker, NOW)).toBe("dormant");
  });
});
