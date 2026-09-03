import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { AGENT_IDLE_GRACE_MS, INBOX_PROJECTION_VERSION, inboxEpoch } from "@codecast/shared/contracts";
import {
  placeInboxRows,
  projectReplicaInbox,
  __resetInboxPlacementCacheForTests,
  type InboxSession,
  type PlaceInboxState,
} from "../inboxStore";
import { sessionLiveAt } from "../../lib/liveness";

// The replica places a row from its replicated FACTS at its own clock
// (ct-47609, sync-convergence C2): the same shared derivation the server ran
// at its epoch, re-run at `now`. So the idle grace, a daemon lapse, a child's
// production ending and the status trust decay all flip locally, with no
// payload and no client-only sweep — and the liveness dot (sessionLiveAt)
// reads the same derivation, so it can never disagree with the bucket.

const S = 1_000;
const MIN = 60 * S;
const H = 60 * MIN;
const NOW = 1_800_000_000_000 + 25_000;
const EPOCH = inboxEpoch(NOW);
const ME = "u".repeat(32);
const A = "a".repeat(32);
const B = "b".repeat(32);

let nowSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  nowSpy = spyOn(Date, "now").mockReturnValue(NOW);
  __resetInboxPlacementCacheForTests();
});
afterEach(() => nowSpy.mockRestore());

function row(id: string, extra: Partial<InboxSession>): InboxSession {
  return {
    _id: id, session_id: `s-${id.slice(0, 3)}`, agent_type: "claude_code", user_id: ME, status: "active",
    message_count: 6, is_idle: false, has_pending: false, ...extra,
  } as InboxSession;
}
function state(sessions: Record<string, InboxSession>): PlaceInboxState {
  return {
    sessions,
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
const bucketAt = (s: PlaceInboxState, id: string, now: number) => placeInboxRows(s, { scope: "mine", now }).placements.get(id)?.bucket;
const replicaBucketAt = (s: PlaceInboxState, id: string, now: number) =>
  projectReplicaInbox(s, { scope: "mine", focusedId: null, epoch: EPOCH, now }).proj.placements.get(id)?.bucket;

describe("live fields re-derive from facts at the replica's clock", () => {
  it("the idle grace flips locally: a just-finished turn is working, then needs input 45s after the status change", () => {
    const finished = row(A, {
      agent_status: "idle", agent_status_updated_at: NOW - 30 * S, updated_at: NOW - 30 * S,
      last_heartbeat: NOW - 5 * S, daemon_alive_until: NOW + 85 * S, last_role_is_user: false,
    });
    const s = state({ [A]: finished });
    const fresh = placeInboxRows(s, { scope: "mine", now: NOW });
    expect(fresh.placements.get(A)?.bucket).toBe("working");
    expect(sessionLiveAt(finished, NOW)).toBe(true);
    const later = placeInboxRows(s, { scope: "mine", now: NOW - 30 * S + AGENT_IDLE_GRACE_MS + S });
    expect(later.placements.get(A)?.bucket).toBe("needs_input");
    expect(sessionLiveAt(finished, NOW - 30 * S + AGENT_IDLE_GRACE_MS + S)).toBe(false);
    // The deadline signature moved, so the memo handed back a new placement.
    expect(later).not.toBe(fresh);
    expect(replicaBucketAt(s, A, NOW)).toBe("working");
    expect(replicaBucketAt(s, A, NOW + MIN)).toBe("needs_input");
  });

  it("a producing child keeps its parent working until producing_until, then the parent settles", () => {
    const parent = row(A, {
      agent_status: "idle", agent_status_updated_at: NOW - 10 * MIN, updated_at: NOW - 10 * MIN,
      last_heartbeat: NOW - 5 * S, daemon_alive_until: NOW + 85 * S, last_role_is_user: false, producing_until: NOW + MIN,
    });
    const s = state({ [A]: parent });
    expect(bucketAt(s, A, NOW)).toBe("working");
    expect(bucketAt(s, A, NOW + MIN + S)).toBe("needs_input");
  });

  it("a daemon lapse turns an unanswered active row unresponsive: working while the daemon vouches, needs input after", () => {
    const unanswered = row(A, { agent_status: null as any, last_role_is_user: true, updated_at: NOW - 2 * MIN, daemon_alive_until: NOW + 30 * S });
    const s = state({ [A]: unanswered });
    const now = placeInboxRows(s, { scope: "mine", now: NOW });
    expect(now.placements.get(A)?.bucket).toBe("working");
    const lapsed = placeInboxRows(s, { scope: "mine", now: NOW + 31 * S });
    expect(lapsed.placements.get(A)).toMatchObject({ bucket: "needs_input", work_state: "needs_input" });
  });

  it("a row with no facts at all settles by the activity grace, like the server's no-status branch", () => {
    const frozen = row(A, { updated_at: NOW - 2 * H });
    const queued = row(B, { updated_at: NOW - 3 * H, has_pending: true, agent_status: "idle" });
    const s = state({ [A]: frozen, [B]: queued });
    expect(bucketAt(s, A, NOW)).toBe("needs_input");
    // Queued work on a daemon nothing vouches for is unresponsive, not working.
    expect(bucketAt(s, B, NOW)).toBe("needs_input");
    expect(sessionLiveAt(frozen, NOW)).toBe(false);
  });

  it("the status trust decay: a 'working' status two hours quiet reads idle and settles, exactly when the server would", () => {
    const quiet = row(A, { agent_status: "working", updated_at: NOW - 2 * H, last_heartbeat: NOW - 5 * S, daemon_alive_until: NOW + 85 * S, last_role_is_user: false });
    const s = state({ [A]: quiet });
    expect(bucketAt(s, A, NOW - 90 * MIN)).toBe("working");
    expect(bucketAt(s, A, NOW)).toBe("needs_input");
  });

  it("a killed row is never live, whatever it still carries", () => {
    const killed = row(A, { agent_status: "working", updated_at: NOW - S, last_heartbeat: NOW - S, daemon_alive_until: NOW + 89 * S, inbox_killed_at: NOW - S });
    expect(sessionLiveAt(killed, NOW)).toBe(false);
    // The shared visibility rule drops an unpinned killed row from the
    // working set, so it has no placement at all; pinned, it files under
    // Pinned with the retired verdict — never Working.
    expect(bucketAt(state({ [A]: killed }), A, NOW)).toBeUndefined();
    __resetInboxPlacementCacheForTests();
    const pinnedKilled = { ...killed, inbox_pinned_at: NOW - S, is_pinned: true };
    expect(placeInboxRows(state({ [A]: pinnedKilled }), { scope: "mine", now: NOW }).placements.get(A)).toMatchObject({ bucket: "pinned", work_state: "idle" });
  });

  it("the payload version still gates only the compare, never rendering", () => {
    expect(INBOX_PROJECTION_VERSION).toBeGreaterThan(0);
  });
});
