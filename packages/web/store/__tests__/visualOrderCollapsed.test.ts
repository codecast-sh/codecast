import { describe, expect, it } from "bun:test";
import { computeVisualOrder, visualOrderSessions, type InboxSession } from "../inboxStore";

// Regression: Ctrl+J/K walks computeVisualOrder()/visualOrderSessions(), which
// must mirror what GlobalSessionPanel renders. A collapsed section is hidden in
// the panel, so its cards must be skipped here too — otherwise the selection
// lands on invisible cards and the panel's auto-scroll effect force-expands the
// section to reveal them.

const session = (id: string, extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `session-${id}`,
  // Recent: a working fixture (is_idle:false) must read as genuinely working —
  // categorizeSessions sweeps an active session gone quiet past the trust TTL
  // into needs-input. All fixtures share one timestamp, so sort order is unchanged.
  updated_at: Date.now(),
  agent_type: "claude_code",
  message_count: 3,
  is_idle: true,
  has_pending: false,
  last_user_message: "hi",
  title: `Session ${id}`,
  ...extra,
});

// is_idle:true + messages → "needs_input"; is_idle:false + messages → "working".
const sessions: Record<string, InboxSession> = {
  ni1: session("ni1", { is_idle: true }),
  ni2: session("ni2", { is_idle: true }),
  wk1: session("wk1", { is_idle: false }),
  wk2: session("wk2", { is_idle: false }),
};

describe("visualOrderSessions collapsed sections (grouped view)", () => {
  it("includes every section when nothing is collapsed", () => {
    const ids = visualOrderSessions(sessions, new Set(), null, undefined, {}).map((s) => s._id).sort();
    expect(ids).toEqual(["ni1", "ni2", "wk1", "wk2"]);
  });

  it("skips a collapsed status section", () => {
    const ids = visualOrderSessions(sessions, new Set(), null, undefined, { collapsedSections: { working: true } })
      .map((s) => s._id).sort();
    expect(ids).toEqual(["ni1", "ni2"]);
  });

  it("skips multiple collapsed sections", () => {
    const ids = visualOrderSessions(sessions, new Set(), null, undefined, {
      collapsedSections: { working: true, needs_input: true },
    }).map((s) => s._id);
    expect(ids).toEqual([]);
  });
});

const baseState = {
  sessions,
  sessionsWithQueuedMessages: new Set<string>(),
  activeProjectFilter: null,
  pendingMessages: {},
  currentSessionId: null,
  pendingSessionCreates: {},
  activeBucketFilter: null,
  bucketAssignments: {},
  buckets: {},
  showFavorites: false,
  collapsedSections: {},
  // Empty set → partitionOldSessions hides nothing, so these collapse cases
  // exercise section collapse alone, not the old-session window.
  liveInboxIds: new Set<string>(),
  recentFreezeOrder: null,
  clientState: { ui: {} },
};

describe("computeVisualOrder respects collapse per view mode", () => {
  it("grouped view: Ctrl+J/K skips the collapsed Working section", () => {
    const order = computeVisualOrder({ ...baseState, collapsedSections: { working: true } })
      .map((s) => s._id).sort();
    expect(order).toEqual(["ni1", "ni2"]);
  });

  it("grouped view: nothing collapsed walks every card", () => {
    const order = computeVisualOrder(baseState).map((s) => s._id).sort();
    expect(order).toEqual(["ni1", "ni2", "wk1", "wk2"]);
  });

  it("time view: collapsing the single 'All' section empties keyboard nav", () => {
    const state = { ...baseState, clientState: { ui: { inbox_view_mode: "time" as const } }, collapsedSections: { all: true } };
    expect(computeVisualOrder(state)).toEqual([]);
  });

  it("time view: a grouped collapse key ('working') does NOT leak in (time has no status sections)", () => {
    const state = { ...baseState, clientState: { ui: { inbox_view_mode: "time" as const } }, collapsedSections: { working: true } };
    expect(computeVisualOrder(state).map((s) => s._id).sort()).toEqual(["ni1", "ni2", "wk1", "wk2"]);
  });
});
