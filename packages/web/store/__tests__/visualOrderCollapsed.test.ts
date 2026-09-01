import { describe, expect, it } from "bun:test";
import { computeVisualOrder, type InboxSession } from "../inboxStore";
import { orderSections } from "./placeTestHarness";

// Regression: Ctrl+J/K walks computeVisualOrder()/visualOrderSessions(), which
// must mirror what GlobalSessionPanel renders. A collapsed section is hidden in
// the panel, so its cards must be skipped here too — otherwise the selection
// lands on invisible cards and the panel's auto-scroll effect force-expands the
// section to reveal them.

// Fixture ids are Convex-shaped: the chokepoint reads any other id as an
// optimistic create stub (rendered, never placed), and these tests are about
// PLACED rows. `tag` reads the short name back off session_id.
const cid = (t: string) => (/^[a-z0-9]{32}$/.test(t) ? t : `${t}z${t.length}`.padEnd(32, "0"));
const tag = (s: InboxSession) => (s.session_id ?? "").slice("session-".length);

const session = (id: string, extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: cid(id),
  session_id: `session-${id}`,
  // Recent: a working fixture (is_idle:false) must read as genuinely working —
  // the chokepoint sweeps an active session gone quiet past the trust TTL
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
const byId = (rows: InboxSession[]): Record<string, InboxSession> =>
  Object.fromEntries(rows.map((s) => [s._id, s]));

// is_idle:true + messages → "needs_input"; is_idle:false + messages → "working".
const sessions: Record<string, InboxSession> = byId([
  session("ni1", { is_idle: true }),
  session("ni2", { is_idle: true }),
  session("wk1", { is_idle: false }),
  session("wk2", { is_idle: false }),
]);

describe("orderSections collapsed sections (grouped view)", () => {
  it("includes every section when nothing is collapsed", () => {
    const ids = orderSections(sessions, new Set(), null, undefined, {}).map(tag).sort();
    expect(ids).toEqual(["ni1", "ni2", "wk1", "wk2"]);
  });

  it("skips a collapsed status section", () => {
    const ids = orderSections(sessions, new Set(), null, undefined, { collapsedSections: { working: true } })
      .map(tag).sort();
    expect(ids).toEqual(["ni1", "ni2"]);
  });

  it("skips multiple collapsed sections", () => {
    const ids = orderSections(sessions, new Set(), null, undefined, {
      collapsedSections: { working: true, needs_input: true },
    }).map(tag);
    expect(ids).toEqual([]);
  });
});

// Sessions sharing a plan are NOT clustered in the status view — grouping by
// plan is exclusively the "By plan" view's job. Nav walks a plan-bound session
// exactly like any other card in its status section (regression ct-37908: the
// old clustering hid working members from Working).
const plan = { _id: "pl-1", short_id: "pl-1", title: "Roadmap", status: "active" };
const planSessions: Record<string, InboxSession> = byId([
  session("pw1", { is_idle: false, active_plan: plan }),
  session("pw2", { is_idle: false, active_plan: plan }),
  session("ni1", { is_idle: true }),
]);

describe("orderSections plan-bound sessions (status view)", () => {
  it("plan-sharing sessions stay in their status sections — nav walks every one", () => {
    const ids = orderSections(planSessions, new Set(), null, undefined, { collapsedSections: {} })
      .map(tag).sort();
    expect(ids).toEqual(["ni1", "pw1", "pw2"]);
  });

  it("collapsing Working hides them like any other working card", () => {
    const ids = orderSections(planSessions, new Set(), null, undefined, { collapsedSections: { working: true } })
      .map(tag).sort();
    expect(ids).toEqual(["ni1"]);
  });
});

describe("computeVisualOrder plan view walks every member", () => {
  it("plan view dissolves the group — all sessions are reachable", () => {
    const state = { ...baseState, sessions: planSessions, clientState: { ui: { inbox_view_mode: "plan" as const } } };
    expect(computeVisualOrder(state).map(tag).sort()).toEqual(["ni1", "pw1", "pw2"]);
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
  recentFreezeOrder: null,
  clientState: { ui: {} },
};

describe("computeVisualOrder respects collapse per view mode", () => {
  it("grouped view: Ctrl+J/K skips the collapsed Working section", () => {
    const order = computeVisualOrder({ ...baseState, collapsedSections: { working: true } })
      .map(tag).sort();
    expect(order).toEqual(["ni1", "ni2"]);
  });

  it("grouped view: nothing collapsed walks every card", () => {
    const order = computeVisualOrder(baseState).map(tag).sort();
    expect(order).toEqual(["ni1", "ni2", "wk1", "wk2"]);
  });

  it("time view: collapsing the single 'All' section empties keyboard nav", () => {
    const state = { ...baseState, clientState: { ui: { inbox_view_mode: "time" as const } }, collapsedSections: { all: true } };
    expect(computeVisualOrder(state)).toEqual([]);
  });

  it("time view: a grouped collapse key ('working') does NOT leak in (time has no status sections)", () => {
    const state = { ...baseState, clientState: { ui: { inbox_view_mode: "time" as const } }, collapsedSections: { working: true } };
    expect(computeVisualOrder(state).map(tag).sort()).toEqual(["ni1", "ni2", "wk1", "wk2"]);
  });
});

// Trigger view: nav walks the panel-published group order (the store can't
// build it — trigger rows live in the panel's Convex subscription), then the
// project fallthrough for unclaimed sessions. No absorption in this mode.
describe("computeVisualOrder trigger view", () => {
  const triggerState = (extra: Partial<typeof baseState> & { scheduleNavSets?: any } = {}) => ({
    ...baseState,
    clientState: { ui: { inbox_view_mode: "trigger" as const } },
    ...extra,
  });

  it("walks trigger groups in published order, then the rest", () => {
    const order = computeVisualOrder(
      triggerState({
        scheduleNavSets: {
          absorbed: new Set<string>(),
          triggerOrder: [
            { key: "t1", ids: [cid("wk2")] },
            { key: "t2", ids: [cid("ni1")] },
          ],
        },
      }),
    ).map(tag);
    expect(order.slice(0, 2)).toEqual(["wk2", "ni1"]);
    expect(order.sort()).toEqual(["ni1", "ni2", "wk1", "wk2"]);
  });

  it("falls back to the status order before the panel publishes", () => {
    const order = computeVisualOrder(triggerState({ scheduleNavSets: null })).map(tag).sort();
    expect(order).toEqual(["ni1", "ni2", "wk1", "wk2"]);
  });

  it("skips a published id the visible set no longer holds, without dropping the group's siblings", () => {
    const order = computeVisualOrder(
      triggerState({
        scheduleNavSets: {
          absorbed: new Set<string>(),
          triggerOrder: [{ key: "t1", ids: [cid("gone"), cid("wk1")] }],
        },
      }),
    ).map(tag);
    expect(order[0]).toBe("wk1");
    expect(order).not.toContain("gone");
  });

  it("collapsing a project fallthrough tier hides only unclaimed sessions", () => {
    const order = computeVisualOrder(
      triggerState({
        collapsedSections: { trigproj_other: true },
        scheduleNavSets: {
          absorbed: new Set<string>(),
          triggerOrder: [{ key: "t1", ids: [cid("wk1")] }],
        },
      }),
    ).map(tag);
    expect(order).toEqual(["wk1"]);
  });
});

// QUESTIONS: a session that asked something (a pending `cast decide` row)
// lifts out of its status section into the leading Questions group — the
// original bug was Working/Pinned never being sampled, so an advisory decide
// showed in the queue badge but nowhere in the rail. Nav must walk it first,
// and a collapsed Questions section must skip it like any other section.
describe("computeVisualOrder lifts questions", () => {
  const decide = {
    _id: "d1", conversation_id: cid("wk1"), session_id: "session-wk1",
    question: "q", options: [{ label: "a" }, { label: "b" }],
    blocking: false, status: "pending" as const, created_at: Date.now(),
  };

  it("a working session with a pending decide walks first, out of Working", () => {
    const order = computeVisualOrder({ ...baseState, sessionDecisions: { d1: decide } }).map(tag);
    expect(order[0]).toBe("wk1");
    expect(order.filter((id) => id === "wk1")).toHaveLength(1);
  });

  it("collapsing the Questions section hides the lifted card from nav", () => {
    const order = computeVisualOrder({
      ...baseState,
      sessionDecisions: { d1: decide },
      collapsedSections: { questions: true },
    }).map(tag);
    expect(order).not.toContain("wk1");
  });

  it("an answered decide leaves the session in Working", () => {
    const order = computeVisualOrder({
      ...baseState,
      sessionDecisions: { d1: { ...decide, status: "answered" as const } },
    }).map(tag);
    expect(order).toContain("wk1");
    expect(order[0]).not.toBe("wk1");
  });
});

// Ctrl+I / queue advance walk computeVisualOrder(state, { yourMove: true }) —
// the questions / NEEDS INPUT / DONE cards in render order, taken from the same
// chokepoint verdicts the panel renders with. Regression: the handler used to
// re-classify each row (classifySession().waiting), which is blind to the
// staleness net — a "working" row quiet past the trust TTL that the panel
// files under NEEDS INPUT, oldest first, so it sits at the very top once old
// sessions are shown. Ctrl+I skipped it and landed on a lower card.
describe("computeVisualOrder yourMove mirrors the panel's your-move sections", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const yourMove = (state: Parameters<typeof computeVisualOrder>[0]) =>
    computeVisualOrder(state, { yourMove: true }).map(tag);
  // stale: claims "working" but went quiet two days ago → the net files it in
  // NEEDS INPUT above the fresh idle row (queues sort oldest first).
  const staleWorking = session("stale", { is_idle: false, agent_status: "working", updated_at: Date.now() - 2 * DAY });
  const idleFresh = session("idle", { is_idle: true, updated_at: Date.now() - DAY });
  const working = session("wk", { is_idle: false, agent_status: "working" });
  const withStale = { ...baseState, sessions: byId([staleWorking, idleFresh, working]) };

  it("grouped view: the stale row the panel shows first in NEEDS INPUT is the first target", () => {
    expect(yourMove(withStale)).toEqual(["stale", "idle"]);
    // and the plain order keeps walking every card
    expect(computeVisualOrder(withStale).map(tag)).toEqual(["stale", "idle", "wk"]);
  });

  it("flat views: same membership, walked in the flat order", () => {
    const time = { ...withStale, clientState: { ui: { inbox_view_mode: "time" as const } } };
    // creation order is by started_at, falling back to updated_at: idle (1d) is newer than stale (2d)
    expect(yourMove(time)).toEqual(["idle", "stale"]);
  });

  it("an in-flight send lifts a row out (it renders under WORKING with its pending pill)", () => {
    expect(yourMove({ ...withStale, sessionsWithQueuedMessages: new Set([cid("stale")]) })).toEqual(["idle"]);
  });

  it("a collapsed NEEDS INPUT section is not walked, exactly like the plain order", () => {
    expect(yourMove({ ...withStale, collapsedSections: { needs_input: true } })).toEqual([]);
  });

  it("with old sessions hidden the folded stale row is off screen, so it is not the target", () => {
    // The 12h fold cut (shared computeFold): wk (now) → idle (1d) is the first
    // gap over 12h, so the cutoff is idle's activity and only stale (2d) folds.
    // Shown (the default): the stale row is on screen at the top of NEEDS INPUT.
    expect(yourMove(withStale)).toEqual(["stale", "idle"]);
    // Hidden: it is not rendered, so it is not the target.
    expect(yourMove({ ...withStale, clientState: { ui: { inbox_show_old: false } } })).toEqual(["idle"]);
  });
});
