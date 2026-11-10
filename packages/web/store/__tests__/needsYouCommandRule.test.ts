import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  placeInboxRows,
  viewerCommandsSession,
  waitsOnViewer,
  __resetInboxPlacementCacheForTests,
  type InboxSession,
  type PlaceInboxState,
} from "../inboxStore";

// Needs You lists what the viewer can unblock. A waiting session files there
// only for the people the server lets command it (commandsSession: its runner
// or its second-party owner). On 2026-11-08 a role's standing session, run and
// owned by one admin, sat in another admin's team-scope Needs You; his Resume
// was refused with "Not authorized".

const NOW = 1_800_000_000_000;
const ME = "m".repeat(32);
const RUNNER = "r".repeat(32);
const MINE = "a".repeat(32);
const THEIRS = "b".repeat(32);
const ROUTED = "c".repeat(32);

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  nowSpy = spyOn(Date, "now").mockReturnValue(NOW);
  __resetInboxPlacementCacheForTests();
});
afterEach(() => nowSpy.mockRestore());

// A session that declared itself blocked on a person (files under needs_input).
function waiting(id: string, extra: Partial<InboxSession>): InboxSession {
  return {
    _id: id, session_id: `s-${id.slice(0, 3)}`, agent_type: "claude_code", status: "active",
    message_count: 8, is_idle: true, has_pending: false, title: `t-${id.slice(0, 1)}`,
    agent_status: "idle", thread_state_status: "blocked", updated_at: NOW - 60_000, ...extra,
  } as InboxSession;
}

function state(sessions: Record<string, InboxSession>, scope: "mine" | "team"): PlaceInboxState {
  return {
    sessions,
    killedShelf: { ids: [] },
    sessionsWithQueuedMessages: new Set(),
    pendingMessages: {},
    clientState: { ui: { inbox_scope: scope, inbox_show_old: true } },
    currentUser: { _id: ME },
    sessionDecisions: {},
    questionResolutions: {},
    pendingSessionCreates: {},
    blockedReviveRequestedAt: {},
    currentSessionId: null,
    sessionsProjection: {},
    teamInboxIds: new Set(Object.keys(sessions)),
    pending: {},
  } as unknown as PlaceInboxState;
}

describe("Needs You follows the command rule", () => {
  it("a teammate's waiting session in team scope files under Dormant, not Needs You", () => {
    const sessions = {
      [MINE]: waiting(MINE, { user_id: ME }),
      [THEIRS]: waiting(THEIRS, { user_id: RUNNER }),
      [ROUTED]: waiting(ROUTED, { user_id: RUNNER, owner_user_id: ME, owned_by_me: true }),
    };
    const placed = placeInboxRows(state(sessions, "team"), { scope: "team", now: NOW });
    // The placement itself is viewer-blind and shared with the server.
    expect(placed.placements.get(THEIRS)?.bucket).toBe("needs_input");
    expect(placed.needsInput.map((r) => r._id).sort()).toEqual([MINE, ROUTED]);
    expect(placed.dormant.map((r) => r._id)).toEqual([THEIRS]);
    expect(placed.counts.needsInput).toBe(2);
    expect(placed.counts.dormant).toBe(1);
  });

  it("a co-owner who is neither runner nor primary owner is not asked to unblock it", () => {
    const sessions = { [THEIRS]: waiting(THEIRS, { user_id: RUNNER, owner_user_id: RUNNER, owned_by_me: true }) };
    const placed = placeInboxRows(state(sessions, "mine"), { scope: "mine", now: NOW });
    expect(placed.needsInput).toEqual([]);
  });
});

describe("viewerCommandsSession", () => {
  it("agrees with the server rule: runner or second-party owner", () => {
    expect(viewerCommandsSession({ user_id: ME }, ME)).toBe(true);
    expect(viewerCommandsSession({ user_id: RUNNER, owner_user_id: ME }, ME)).toBe(true);
    expect(viewerCommandsSession({ user_id: RUNNER }, ME)).toBe(false);
    expect(viewerCommandsSession({ user_id: RUNNER, owner_user_id: RUNNER }, ME)).toBe(false);
  });

  it("leaves the decision to the server when the row or viewer is unknown", () => {
    expect(viewerCommandsSession(undefined, ME)).toBe(true);
    expect(viewerCommandsSession({ user_id: RUNNER }, null)).toBe(true);
    expect(viewerCommandsSession({}, ME)).toBe(true);
    expect(waitsOnViewer({ _id: "stub-local-1", user_id: RUNNER }, ME)).toBe(true);
  });
});
