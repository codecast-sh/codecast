import { afterEach, describe, expect, it } from "bun:test";
import { useInboxStore, type InboxSession } from "../inboxStore";

// The "recent" view sorts by updated_at, which working sessions bump every
// heartbeat. Without a freeze the list re-sorts under the cursor and Ctrl+J/K
// steps through a moving target ("same row, different session"). These lock the
// fix: a keyboard-nav snapshot holds render+nav order until a short idle thaws it.

const session = (id: string, extra: Partial<InboxSession> = {}): InboxSession => ({
  _id: id,
  session_id: `session-${id}`,
  updated_at: 1,
  agent_type: "claude_code",
  message_count: 3,
  is_idle: true,
  has_pending: false,
  last_user_message: "hi",
  title: `Session ${id}`,
  ...extra,
});

describe("recent view freeze", () => {
  // Leave no frozen order or recent mode behind for sibling suites.
  afterEach(() => {
    useInboxStore.getState().thawRecentOrder();
    useInboxStore.setState({ sessions: {}, clientState: {}, recentFreezeOrder: null });
  });

  it("keyboard nav freezes the order so a heartbeat can't reshuffle it until thaw", () => {
    useInboxStore.setState({
      sessions: {
        a: session("a", { started_at: 1, updated_at: 100 }),
        b: session("b", { started_at: 2, updated_at: 200 }),
        c: session("c", { started_at: 3, updated_at: 300 }),
      },
      clientState: { ui: { inbox_view_mode: "recent" } },
      recentFreezeOrder: null,
    });
    const st = useInboxStore.getState();
    // Live recent order is newest-activity first.
    expect(st.visualOrder().map((s) => s._id)).toEqual(["c", "b", "a"]);
    // A j/k press snapshots that order.
    st.freezeRecentForNav();
    expect(useInboxStore.getState().recentFreezeOrder).toEqual(["c", "b", "a"]);
    // A heartbeat makes "a" the most recently active — live sort would lead with it…
    useInboxStore.setState({
      sessions: { ...useInboxStore.getState().sessions, a: session("a", { started_at: 1, updated_at: 999 }) },
    });
    // …but the frozen order holds while the user is navigating.
    expect(useInboxStore.getState().visualOrder().map((s) => s._id)).toEqual(["c", "b", "a"]);
    // Thaw (idle) resumes the live sort; "a" now leads.
    useInboxStore.getState().thawRecentOrder();
    expect(useInboxStore.getState().recentFreezeOrder).toBeNull();
    expect(useInboxStore.getState().visualOrder().map((s) => s._id)).toEqual(["a", "c", "b"]);
  });

  it("a session arriving mid-navigation falls to the end, not under the cursor", () => {
    useInboxStore.setState({
      sessions: {
        a: session("a", { started_at: 1, updated_at: 100 }),
        b: session("b", { started_at: 2, updated_at: 200 }),
      },
      clientState: { ui: { inbox_view_mode: "recent" } },
      recentFreezeOrder: null,
    });
    useInboxStore.getState().freezeRecentForNav();
    // A brand-new, most-recent session appears after the snapshot.
    useInboxStore.setState({
      sessions: { ...useInboxStore.getState().sessions, z: session("z", { started_at: 3, updated_at: 999 }) },
    });
    // It's appended, not slotted at the top where it would shove the frozen rows.
    expect(useInboxStore.getState().visualOrder().map((s) => s._id)).toEqual(["b", "a", "z"]);
  });

  it("freeze is a no-op outside recent mode (time is already stable)", () => {
    useInboxStore.setState({
      sessions: { a: session("a", { started_at: 1, updated_at: 1 }) },
      clientState: { ui: { inbox_view_mode: "time" } },
      recentFreezeOrder: null,
    });
    useInboxStore.getState().freezeRecentForNav();
    expect(useInboxStore.getState().recentFreezeOrder).toBeNull();
  });

  it("leaving recent mode thaws any frozen order", () => {
    useInboxStore.setState({
      sessions: { a: session("a", { updated_at: 1 }) },
      clientState: { ui: { inbox_view_mode: "recent" } },
      recentFreezeOrder: ["a"],
    });
    useInboxStore.getState().setInboxViewMode("grouped");
    expect(useInboxStore.getState().recentFreezeOrder).toBeNull();
  });
});
