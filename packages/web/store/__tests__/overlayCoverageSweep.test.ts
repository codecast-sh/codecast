import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { INBOX_PROJECTION_VERSION, inboxEpoch } from "@codecast/shared/contracts";
import {
  INBOX_PAYLOAD_FRESH_MS,
  placeInboxRows,
  projectReplicaInbox,
  __resetInboxPlacementCacheForTests,
  type InboxSession,
  type PlaceInboxState,
  type SessionsProjectionSlot,
} from "../inboxStore";
import { INBOX_COMPARE_MAX_PAYLOAD_AGE_MS } from "../inboxDigestCompare";

// THE STALENESS SWEEP IS GATED ON OVERLAY COVERAGE (sync-convergence C1/C5).
//
// The server's is_idle / has_pending facts are computed from inputs the
// replica does not hold (last_message_role, agent_status_updated_at, a
// producing subagent). A covered row — stamped by a payload younger than the
// fresh bound — must be placed from those facts exactly as the server placed
// it; the client-only sweep (quiet past the grace → settled, trust-stale →
// queue blanked) applies only to rows the payload cannot vouch for. The
// two-replica simulation found the ungated sweep filing a parent with a
// producing child, and a live daemon holding an unanswered message, under
// needs-input while the server and the CLI kept them working (2026-09-01).

const MIN = 60_000;
const H = 60 * MIN;
const NOW = 1_800_000_000_000 + 25_000;
const EPOCH = inboxEpoch(NOW);
const MONO = 5_000_000;
const ME = "u".repeat(32);
const A = "a".repeat(32);
const B = "b".repeat(32);

let nowSpy: ReturnType<typeof spyOn>;
let perfSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  nowSpy = spyOn(Date, "now").mockReturnValue(NOW);
  perfSpy = spyOn(performance, "now").mockReturnValue(MONO);
  __resetInboxPlacementCacheForTests();
});
afterEach(() => {
  nowSpy.mockRestore();
  perfSpy.mockRestore();
});

// A quiet row the server still calls "in flight": no status, is_idle false
// (the daemon is alive and the user's last message is unanswered), two hours
// old. The client sweep alone would call it settled.
function unansweredRow(id: string): InboxSession {
  return {
    _id: id, session_id: `s-${id.slice(0, 3)}`, agent_type: "claude_code", user_id: ME, status: "active",
    updated_at: NOW - 2 * H, message_count: 6, is_idle: false, has_pending: false,
  } as InboxSession;
}

// A queued row past the trust TTL: the server keeps has_pending and files it
// working (canDeliver && hasPending); the ungated sweep blanked the queue.
function queuedRow(id: string): InboxSession {
  return {
    _id: id, session_id: `s-${id.slice(0, 3)}`, agent_type: "claude_code", user_id: ME, status: "active",
    updated_at: NOW - 3 * H, message_count: 6, is_idle: false, has_pending: true, agent_status: "idle",
  } as InboxSession;
}

function slot(ids: string[], receivedAtMono: number): SessionsProjectionSlot {
  const stamps: SessionsProjectionSlot["stamps"] = {};
  for (const id of ids) stamps[id] = { bucket: "working", work_state: "working", asking: false, below_fold: false, bucket_stale_at: null, stale_bucket: null };
  return { v: INBOX_PROJECTION_VERSION, epoch: EPOCH, receivedAtMono, tally: { shown: {} as any, folded: {} as any }, set_digest: "x", truncated: [], stamps };
}

function state(over: Partial<PlaceInboxState> = {}): PlaceInboxState {
  return {
    sessions: { [A]: unansweredRow(A), [B]: queuedRow(B) },
    sessionsWithQueuedMessages: new Set(),
    pendingMessages: {},
    clientState: { ui: { inbox_scope: "mine", inbox_show_old: true } },
    currentUser: { _id: ME },
    sessionDecisions: {},
    questionResolutions: {},
    pendingSessionCreates: {},
    blockedReviveRequestedAt: {},
    currentSessionId: null,
    ...over,
  };
}

describe("overlay coverage gates the client staleness sweep", () => {
  it("the fresh bound is the compare's payload age bound", () => {
    expect(INBOX_COMPARE_MAX_PAYLOAD_AGE_MS).toBe(INBOX_PAYLOAD_FRESH_MS);
  });

  it("a row covered by a fresh payload is placed from the server's facts: working, as the server stamped it", () => {
    const s = state({ sessionsProjection: { mine: slot([A, B], MONO - 10_000) } });
    const placed = placeInboxRows(s, { scope: "mine", now: NOW, nowMono: MONO });
    expect(placed.placements.get(A)?.bucket).toBe("working");
    expect(placed.placements.get(B)?.bucket).toBe("working");
    const { proj } = projectReplicaInbox(s, { scope: "mine", focusedId: null, epoch: EPOCH, now: NOW, nowMono: MONO });
    expect(proj.placements.get(A)?.bucket).toBe("working");
    expect(proj.placements.get(B)?.bucket).toBe("working");
  });

  it("a row outside the payload, or with no payload at all, takes the sweep: settled, queue blanked", () => {
    for (const s of [
      state({ sessionsProjection: { mine: slot([], MONO - 10_000) } }),
      state({ sessionsProjection: {} }),
      state(),
    ]) {
      const placed = placeInboxRows(s, { scope: "mine", now: NOW, nowMono: MONO });
      expect(placed.placements.get(A)?.bucket).toBe("needs_input");
      expect(placed.placements.get(B)?.bucket).toBe("needs_input");
      __resetInboxPlacementCacheForTests();
    }
  });

  it("a payload past the fresh bound no longer vouches for its rows — the sweep resumes, and the memo notices the flip", () => {
    const s = state({ sessionsProjection: { mine: slot([A, B], MONO - 10_000) } });
    const fresh = placeInboxRows(s, { scope: "mine", now: NOW, nowMono: MONO });
    expect(fresh.placements.get(A)?.bucket).toBe("working");
    // Same state, same wall clock, only the receipt clock moved past the bound.
    const later = placeInboxRows(s, { scope: "mine", now: NOW, nowMono: MONO + INBOX_PAYLOAD_FRESH_MS + 1 });
    expect(later.placements.get(A)?.bucket).toBe("needs_input");
    expect(later.placements.get(B)?.bucket).toBe("needs_input");
    expect(later).not.toBe(fresh);
  });

  it("the status trust decay stays ungated: a covered 'working' row two hours quiet decays to idle locally", () => {
    const row = { ...unansweredRow(A), agent_status: "working" } as InboxSession;
    const s = state({ sessions: { [A]: row }, sessionsProjection: { mine: slot([A], MONO - 10_000) } });
    const placed = placeInboxRows(s, { scope: "mine", now: NOW, nowMono: MONO });
    // Decayed status + the server's is_idle:false fact = the in-flight arm, as
    // the server's own trustedAgentStatus + isSessionIdle would place it.
    expect(placed.placements.get(A)?.work_state).toBe("working");
    expect(placed.placements.get(A)?.bucket).toBe("working");
  });
});
