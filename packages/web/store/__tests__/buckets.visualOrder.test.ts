import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore } from "../inboxStore";
import { bucket, session } from "./bucketFixtures";

describe("visualOrder follows the active view mode", () => {
  beforeEach(() => {
    useInboxStore.setState({
      sessions: {},
      buckets: {},
      bucketAssignments: {},
      pending: {},
      pendingMessages: {},
      pendingSessionCreates: {},
      sessionsWithQueuedMessages: new Set(),
      activeBucketFilter: null,
      activeProjectFilter: null,
      currentSessionId: null,
      liveInboxIds: new Set(),
      clientState: {},
    });
  });
  afterEach(() => {
    useInboxStore.setState({ sessions: {}, buckets: {}, bucketAssignments: {}, clientState: {} });
  });

  it("bucket mode walks label groups, then project groups, each pinned row leading its own group", () => {
    useInboxStore.setState({
      sessions: {
        pin: session("pin", { is_pinned: true, updated_at: 1, git_root: "/x/web" }),
        lab: session("lab", { updated_at: 2, git_root: "/x/web" }),
        web1: session("web1", { updated_at: 9, git_root: "/x/web" }),
        web2: session("web2", { updated_at: 3, git_root: "/x/web" }),
      },
      buckets: { b1: bucket("b1", "mylabel") },
      bucketAssignments: {
        r1: { _id: "r1", conversation_id: "lab", bucket_id: "b1", updated_at: 1 },
      },
      clientState: { ui: { inbox_view_mode: "bucket" } },
    });
    const order = useInboxStore.getState().visualOrder().map((s) => s._id);
    expect(order).toEqual(["lab", "pin", "web1", "web2"]);
  });

  it("time mode sorts newest-created first regardless of status grouping", () => {
    useInboxStore.setState({
      sessions: {
        old: session("old", { started_at: 100, updated_at: 500, is_pinned: true }),
        mid: session("mid", { started_at: 200, updated_at: 100 }),
        fresh: session("fresh", { started_at: 300, updated_at: 50 }),
      },
      clientState: { ui: { inbox_view_mode: "time" } },
    });
    const order = useInboxStore.getState().visualOrder().map((s) => s._id);
    expect(order).toEqual(["fresh", "mid", "old"]);
  });

  it("recent mode sorts newest-activity first (updated_at), inverting the creation order", () => {
    useInboxStore.setState({
      sessions: {
        old: session("old", { started_at: 100, updated_at: 500, is_pinned: true }),
        mid: session("mid", { started_at: 200, updated_at: 100 }),
        fresh: session("fresh", { started_at: 300, updated_at: 50 }),
      },
      clientState: { ui: { inbox_view_mode: "recent" } },
    });
    const order = useInboxStore.getState().visualOrder().map((s) => s._id);
    expect(order).toEqual(["old", "mid", "fresh"]);
  });

  // Regression: Ctrl+J/K skipped New Session cards outside grouped view. The flat
  // (time/recent) panel renders EVERY non-hidden session — never-engaged blanks
  // included — but nav used to walk only the categorized status buckets, which
  // drop those blanks. A 0-message blank that is not the current session lands in
  // no status bucket, so it must appear in flat nav (matching the render) yet stay
  // out of grouped nav (matching the grouped render's deliberate hiding).
  it("flat (time/recent) mode walks never-engaged blank sessions so Ctrl+J/K can't skip New Session cards", () => {
    useInboxStore.setState({
      sessions: {
        blank: session("blank", { message_count: 0, started_at: 250, updated_at: 250 }),
        work: session("work", { message_count: 3, started_at: 100, updated_at: 100 }),
      },
      clientState: { ui: { inbox_view_mode: "time" } },
    });
    expect(useInboxStore.getState().visualOrder().map((s) => s._id)).toEqual(["blank", "work"]);
    useInboxStore.setState({ clientState: { ui: { inbox_view_mode: "recent" } } });
    expect(useInboxStore.getState().visualOrder().map((s) => s._id)).toEqual(["blank", "work"]);
  });

  it("grouped (by status) mode still hides the never-engaged blank — the behavior flat view diverges from", () => {
    useInboxStore.setState({
      sessions: {
        blank: session("blank", { message_count: 0, started_at: 250, updated_at: 250 }),
        work: session("work", { message_count: 3, started_at: 100, updated_at: 100 }),
      },
      clientState: { ui: { inbox_view_mode: "grouped" } },
    });
    expect(useInboxStore.getState().visualOrder().map((s) => s._id)).toEqual(["work"]);
  });

  // Regression: in grouped/bucket view, Ctrl+J/K landed on "old" sessions the
  // panel hides when "show old sessions" is off, so the highlight sat still while
  // the selection jumped onto an off-screen card. "Old" is the FOLD of the shared
  // working-set selection now (sync-convergence C4): a member past a 12h activity
  // gap hides behind the toggle; show-old reveals it INSIDE the computation. The
  // panel renders from computeInboxVisible(...).visibleSessions; nav must walk
  // the SAME set. (Membership only applies to real Convex ids — stubs are the
  // create_stub overlay — hence the 32-char fixtures.)
  const LIVE_ID = "live".padEnd(32, "0"); // fresh activity: above the fold
  const EDGE_ID = "edge".padEnd(32, "2"); // at the fold cut: stays visible
  const OLD_ID = "olds".padEnd(32, "1");  // past the cut → folded ("old")
  for (const mode of ["grouped", "bucket"] as const) {
    it(`${mode} mode skips "old" (folded) sessions when show_old is off, matching the render`, () => {
      const now = Date.now();
      const sessions = {
        [LIVE_ID]: session(LIVE_ID, { message_count: 3, updated_at: now, git_root: "/x/web" }),
        [EDGE_ID]: session(EDGE_ID, { message_count: 3, updated_at: now - 13 * 60 * 60 * 1000, git_root: "/x/web" }),
        [OLD_ID]: session(OLD_ID, { message_count: 3, updated_at: now - 14 * 60 * 60 * 1000, git_root: "/x/web" }),
      };
      // show_old off (the default): the folded card is hidden on screen, so nav
      // drops it too.
      useInboxStore.setState({
        sessions,
        clientState: { ui: { inbox_view_mode: mode, inbox_show_old: false } },
      });
      expect(useInboxStore.getState().visualOrder().map((s) => s._id).sort()).toEqual([LIVE_ID, EDGE_ID].sort());
      // show_old on (synced per-user view pref): both render and nav include
      // the folded session (membership is the contract here; the intra-status
      // tiebreak differs by mode).
      useInboxStore.setState({
        sessions,
        clientState: { ui: { inbox_view_mode: mode, inbox_show_old: true } },
      });
      expect(useInboxStore.getState().visualOrder().map((s) => s._id).sort()).toEqual([LIVE_ID, EDGE_ID, OLD_ID].sort());
    });
  }

  it("time mode: a manual pin overrides creation order; un-pinned rows stay by creation", () => {
    useInboxStore.setState({
      sessions: {
        old: session("old", { started_at: 100, updated_at: 1 }),
        mid: session("mid", { started_at: 200, updated_at: 1 }),
        fresh: session("fresh", { started_at: 300, updated_at: 1 }),
      },
      // Pin "old" above "fresh": key just over fresh's creation stamp.
      clientState: { ui: { inbox_view_mode: "time", inbox_manual_order: { old: 100_000 } } },
    });
    const order = useInboxStore.getState().visualOrder().map((s) => s._id);
    expect(order).toEqual(["old", "fresh", "mid"]);
  });

  it("setSessionManualOrders pins a row and persists the key in the synced ui bag", () => {
    useInboxStore.setState({
      sessions: {
        a: session("a", { started_at: 100, updated_at: 1 }),
        b: session("b", { started_at: 200, updated_at: 1 }),
      },
      clientState: { ui: { inbox_view_mode: "time" } },
    });
    useInboxStore.getState().setSessionManualOrders({ a: 999_999 });
    expect(useInboxStore.getState().clientState.ui?.inbox_manual_order).toEqual({ a: 999_999 });
    const order = useInboxStore.getState().visualOrder().map((s) => s._id);
    expect(order).toEqual(["a", "b"]); // a's pin now outranks b's later creation
  });
});
