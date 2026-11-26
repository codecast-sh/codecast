import { afterEach, describe, expect, it } from "bun:test";
import { flatViewSessions, manualOrderKeysForDrop, useInboxStore, type InboxSession } from "../inboxStore";

// The flat views (Updated, Created) run newest first unless the person flips
// them to oldest first in the Group by menu. Render, Ctrl+J/K and drag-to-
// reorder must all follow the flip.

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

const rows = [
  session("a", { started_at: 1000, updated_at: 3000 }),
  session("b", { started_at: 2000, updated_at: 1000 }),
  session("c", { started_at: 3000, updated_at: 2000 }),
];
const ids = (list: InboxSession[]) => list.map((s) => s._id);

describe("oldest first", () => {
  afterEach(() => {
    useInboxStore.getState().thawRecentOrder();
    useInboxStore.setState({ sessions: {}, clientState: {}, recentFreezeOrder: null });
  });

  it("flips both flat views", () => {
    const run = (mode: "time" | "recent", oldestFirst: boolean) =>
      ids(flatViewSessions(rows, new Map(), { mode, showSubagents: true, oldestFirst }));
    expect(run("time", false)).toEqual(["c", "b", "a"]);
    expect(run("time", true)).toEqual(["a", "b", "c"]);
    expect(run("recent", false)).toEqual(["a", "c", "b"]);
    expect(run("recent", true)).toEqual(["b", "c", "a"]);
  });

  it("keyboard nav walks the flipped order, and flipping thaws a frozen one", () => {
    useInboxStore.setState({
      sessions: Object.fromEntries(rows.map((r) => [r._id, r])),
      clientState: { ui: { inbox_view_mode: "recent" } },
      recentFreezeOrder: null,
    });
    useInboxStore.getState().freezeRecentForNav();
    expect(useInboxStore.getState().recentFreezeOrder).toEqual(["a", "c", "b"]);
    useInboxStore.getState().setInboxOldestFirst(true);
    expect(useInboxStore.getState().clientState.ui?.inbox_sort_oldest_first).toBe(true);
    expect(useInboxStore.getState().recentFreezeOrder).toBeNull();
    expect(ids(useInboxStore.getState().visualOrder())).toEqual(["b", "c", "a"]);
  });

  it("a drop lands where the person let go in either direction", () => {
    const noNest = () => null;
    const drop = (oldestFirst: boolean, moving: string[], targetId: string, pos: "before" | "after") => {
      const list = flatViewSessions(rows, new Map(), { mode: "time", showSubagents: true, oldestFirst });
      const manualOrder = manualOrderKeysForDrop(list, { moving: new Set(moving), targetId, pos, nestedUnder: noNest, oldestFirst })!;
      return ids(flatViewSessions(rows, new Map(), { mode: "time", showSubagents: true, oldestFirst, manualOrder }));
    };
    // Newest first: c b a. Drop a above b.
    expect(drop(false, ["a"], "b", "before")).toEqual(["c", "a", "b"]);
    // Oldest first: a b c. Drop c above b, then a below c, then c at the very top.
    expect(drop(true, ["c"], "b", "before")).toEqual(["a", "c", "b"]);
    expect(drop(true, ["a"], "c", "after")).toEqual(["b", "c", "a"]);
    expect(drop(true, ["c"], "a", "before")).toEqual(["c", "a", "b"]);
    // A two-card selection keeps its on-screen order: a b c, move a+b below c.
    expect(drop(true, ["a", "b"], "c", "after")).toEqual(["c", "a", "b"]);
  });

  it("a drop on a nested row lands after its parent's group, as the list shows it", () => {
    // Oldest first: a, p (with k nested under it), c. k owns no slot.
    const list = [
      session("a", { started_at: 1000 }),
      session("p", { started_at: 2000 }),
      session("k", { started_at: 2500 }),
      session("c", { started_at: 3000 }),
    ];
    const nestedUnder = (s: InboxSession) => (s._id === "k" ? "p" : null);
    const keys = manualOrderKeysForDrop(list, { moving: new Set(["c"]), targetId: "k", pos: "before", nestedUnder, oldestFirst: true })!;
    // c lands below p's group, the end of the list: newer than p.
    expect(keys.c).toBeGreaterThan(2000);
    const moved = manualOrderKeysForDrop(list, { moving: new Set(["a"]), targetId: "k", pos: "before", nestedUnder, oldestFirst: true })!;
    // a lands below p's group and above c: between p (2000) and c (3000).
    expect(moved.a).toBeGreaterThan(2000);
    expect(moved.a).toBeLessThan(3000);
  });
});
