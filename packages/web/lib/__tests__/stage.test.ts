import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore, type AppTab } from "../../store/inboxStore";
import { leavesOf } from "../../store/stageSplit";
import { performStageDrop } from "../stage";

// performStageDrop is the one entry point every drag source funnels into;
// these pin the branch behaviors that silently corrupt the arrangement when
// they regress (see the center-move ordering trap fixed alongside these).

const tab = (over?: Partial<AppTab>): AppTab => ({
  id: "t1",
  title: "A",
  path: "/tasks",
  createdAt: 0,
  ...over,
});

const state = () => useInboxStore.getState();
const activeTab = () => state().tabs.find((t) => t.id === state().activeTabId)!;

// syncUrl and the width gate read window; bun has no DOM.
const hadWindow = typeof (globalThis as any).window !== "undefined";
beforeAll(() => {
  if (!hadWindow) (globalThis as any).window = { innerWidth: 1400 };
});
afterAll(() => {
  if (!hadWindow) delete (globalThis as any).window;
});

beforeEach(() => {
  useInboxStore.setState({ tabs: [tab()], activeTabId: "t1" } as any);
});

describe("performStageDrop — center", () => {
  it("a center MOVE re-points the target before the source dissolves (2 panes collapse onto the moved content)", () => {
    state().stageInsertLeaf("root", "right", "/docs");
    const [a, b] = leavesOf(activeTab().layout!); // a=/tasks, b=/docs
    const ok = performStageDrop(
      { kind: "center", leafId: a.id },
      { path: "/docs", from: { kind: "leaf", leafId: b.id } },
    );
    expect(ok).toBe(true);
    const t = activeTab();
    // Two panes merged into one showing the moved content — not the stale target.
    expect(t.layout).toBeUndefined();
    expect(t.path).toBe("/docs");
  });

  it("dropping a pane on its own center is a no-op", () => {
    state().stageInsertLeaf("root", "right", "/docs");
    const before = activeTab().layout;
    const [a] = leavesOf(before!);
    const ok = performStageDrop(
      { kind: "center", leafId: a.id },
      { path: "/tasks", from: { kind: "leaf", leafId: a.id } },
    );
    expect(ok).toBe(false);
    expect(activeTab().layout).toBe(before);
  });
});

describe("performStageDrop — dragged-in tabs", () => {
  it("a background tab dissolves into the pane it becomes", () => {
    useInboxStore.setState({
      tabs: [tab(), tab({ id: "t2", path: "/docs", title: "B" })],
      activeTabId: "t1",
    } as any);
    const seed = performStageDrop(
      { kind: "edge", leafId: "anything", edge: "right" },
      { path: "/docs", from: { kind: "tab", tabId: "t2" } },
    );
    expect(seed).toBe(true);
    const s = state();
    expect(s.tabs.map((t) => t.id)).toEqual(["t1"]);
    expect(leavesOf(s.tabs[0].layout!).map((l) => l.path)).toEqual(["/tasks", "/docs"]);
  });

  it("dragging the ACTIVE tab into its own stage duplicates the view and keeps the tab", () => {
    const ok = performStageDrop(
      { kind: "edge", leafId: "anything", edge: "right" },
      { path: "/tasks", from: { kind: "tab", tabId: "t1" } },
    );
    expect(ok).toBe(true);
    const s = state();
    expect(s.tabs.map((t) => t.id)).toEqual(["t1"]);
    expect(leavesOf(s.tabs[0].layout!).map((l) => l.path)).toEqual(["/tasks", "/tasks"]);
  });
});

describe("performStageDrop — rearrange (edge/root moves)", () => {
  it("a 2-pane edge move swaps positions without respelling or remounting the stationary pane", () => {
    state().stageInsertLeaf("root", "right", "/conversation/bbb");
    useInboxStore.setState({
      tabs: [{ ...activeTab(), layout: undefined, focusedLeafId: undefined, path: "/x" }],
    } as any);
    // Rebuild as two conversation panes to hit the collapse-respell trap.
    useInboxStore.setState({ tabs: [tab({ path: "/conversation/aaa" })], activeTabId: "t1" } as any);
    state().stageInsertLeaf("root", "right", "/conversation/bbb");
    const [a, b] = leavesOf(activeTab().layout!);
    const ok = performStageDrop(
      { kind: "edge", leafId: a.id, edge: "left" },
      { path: "/conversation/bbb", from: { kind: "leaf", leafId: b.id } },
    );
    expect(ok).toBe(true);
    const t = activeTab();
    // Both panes survive with their spellings intact; the stationary pane
    // keeps its IDENTITY (no sl_seed_* remount), the moved pane keeps its id.
    expect(leavesOf(t.layout!).map((l) => l.path)).toEqual(["/conversation/bbb", "/conversation/aaa"]);
    expect(leavesOf(t.layout!).map((l) => l.id)).toEqual([b.id, a.id]);
    expect(t.focusedLeafId).toBe(b.id);
  });

  it("a move at the 4-pane cap rearranges instead of being refused", () => {
    state().stageInsertLeaf("root", "right", "/docs");
    let t = activeTab();
    state().stageInsertLeaf({ leafId: leavesOf(t.layout!)[0].id }, "bottom", "/plans");
    t = activeTab();
    state().stageInsertLeaf({ leafId: leavesOf(t.layout!)[2].id }, "bottom", "/feed");
    t = activeTab();
    expect(leavesOf(t.layout!)).toHaveLength(4);
    const [first, , , last] = leavesOf(t.layout!);
    const ok = performStageDrop(
      { kind: "edge", leafId: first.id, edge: "top" },
      { path: last.path, from: { kind: "leaf", leafId: last.id } },
    );
    expect(ok).toBe(true);
    // Still four panes, all four routes still present — nothing was discarded.
    const paths = leavesOf(activeTab().layout!).map((l) => l.path).sort();
    expect(paths).toEqual(["/docs", "/feed", "/plans", "/tasks"]);
    expect(leavesOf(activeTab().layout!)).toHaveLength(4);
  });

  it("dropping a pane on its own edge is a no-op", () => {
    state().stageInsertLeaf("root", "right", "/docs");
    const before = activeTab().layout;
    const [a] = leavesOf(before!);
    const ok = performStageDrop(
      { kind: "edge", leafId: a.id, edge: "left" },
      { path: "/tasks", from: { kind: "leaf", leafId: a.id } },
    );
    expect(ok).toBe(false);
    expect(activeTab().layout).toBe(before);
  });
});

describe("split-tab path invariants under shell writers", () => {
  it("closeTab's promoted-survivor rewrite skips split tabs (their focused conversation leaf is legitimate)", () => {
    useInboxStore.setState({
      tabs: [tab({ id: "t9", path: "/feed", title: "F" }), tab()],
      activeTabId: "t9",
    } as any);
    state().switchTab("t1");
    state().stageInsertLeaf("root", "right", "/conversation/abc");
    useInboxStore.setState({ activeTabId: "t9" } as any);
    state().closeTab("t9");
    const t = state().tabs[0];
    // The promoted split tab keeps /conversation/<id> mirrored with its
    // focused leaf; the plain-tab heal must not have respelled it.
    expect(t.path).toBe("/conversation/abc");
    expect(leavesOf(t.layout!).map((l) => l.path)).toContain("/conversation/abc");
  });

  it("openTab never seats a tab on the /conversation redirect route", () => {
    const id = state().openTab({ path: "/conversation/xyz", title: "S", makeActive: false });
    const opened = state().tabs.find((t) => t.id === id)!;
    expect(opened.path).toBe("/inbox?s=xyz");
  });
});

describe("performStageDrop — dedupe", () => {
  it("an edge drop of a path already on stage focuses the existing pane instead of doubling it", () => {
    state().stageInsertLeaf("root", "right", "/docs");
    const layoutBefore = activeTab().layout;
    const [a] = leavesOf(layoutBefore!);
    const ok = performStageDrop({ kind: "edge", leafId: a.id, edge: "bottom" }, { path: "/docs" });
    expect(ok).toBe(true);
    const t = activeTab();
    expect(leavesOf(t.layout!)).toHaveLength(2);
    expect(t.path).toBe("/docs");
    expect(t.focusedLeafId).toBe(leavesOf(t.layout!)[1].id);
  });
});
