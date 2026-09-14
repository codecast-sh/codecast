import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore, type AppTab } from "../../store/inboxStore";
import { besideLeafId, leavesOf, seedLeafId } from "../../store/stageSplit";
import { openBeside, openBrowserPane, performStageDrop, stageRenderLayout } from "../stage";
import { parseBrowserRoute } from "../browserPane";

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
let restoreWindow: () => void;
beforeAll(() => {
  restoreWindow = replaceGlobals({ window: { innerWidth: 1400 } });
});
afterAll(() => {
  restoreWindow();
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

describe("openBrowserPane", () => {
  const source = { kind: "url", url: "http://localhost:8765/" } as const;

  // This is the one gesture that can fall back to moving the TAB, and
  // tabNavigate reads the live URL — the shared fake window has none.
  let restoreLocation: () => void;
  beforeAll(() => {
    restoreLocation = replaceGlobals({
      window: {
        innerWidth: 1400,
        location: { pathname: "/tasks", search: "" },
        history: { pushState: () => {}, replaceState: () => {} },
      },
    });
  });
  afterAll(() => restoreLocation());

  it("opens the page beside what is already on stage", () => {
    expect(openBrowserPane(source)).toBe(true);
    const leaves = leavesOf(activeTab().layout!);
    expect(leaves.map((l) => l.path.split("?")[0])).toEqual(["/tasks", "/browser"]);
    // The URL rides the path, which is what makes the pane survive a reload.
    expect(parseBrowserRoute(leaves[1].path)).toEqual({ kind: "url", url: source.url });
  });

  it("beside:false navigates the tab to the page instead", () => {
    expect(openBrowserPane(source, { beside: false })).toBe(false);
    const t = activeTab();
    expect(t.layout).toBeUndefined();
    expect(parseBrowserRoute(t.path)).toEqual({ kind: "url", url: source.url });
  });

  it("carries the native choice into the path", () => {
    openBrowserPane(source, { beside: false, native: true });
    expect(activeTab().path).toContain("native=1");
  });

  it("at the four-pane cap the tab navigates, and it says it did not open beside", () => {
    state().stageInsertLeaf("root", "right", "/docs");
    state().stageInsertLeaf("root", "right", "/plans");
    state().stageInsertLeaf("root", "right", "/feed");
    expect(leavesOf(activeTab().layout!)).toHaveLength(4);
    expect(openBrowserPane(source)).toBe(false);
    // Still four panes — and the tab moved to the page, so nothing is lost.
    expect(leavesOf(activeTab().layout!)).toHaveLength(4);
    expect(parseBrowserRoute(activeTab().path)).toEqual({ kind: "url", url: source.url });
  });
});

// Option-click ("open beside", reused): one stable target pane per tab, and
// the pane the click happened in does not move — no focus change, no path
// change, no URL rewrite.
describe("openBeside — the reused Option-click target", () => {
  it("opens one target pane, unfocused, and leaves the origin's focus and path alone", () => {
    expect(openBeside("/docs", { reuse: true })).toBe(true);
    const t = activeTab();
    expect(leavesOf(t.layout).map((l) => [l.id, l.path])).toEqual([
      [seedLeafId("t1"), "/tasks"],
      [besideLeafId("t1"), "/docs"],
    ]);
    expect(t.focusedLeafId).toBe(seedLeafId("t1"));
    expect(t.path).toBe("/tasks");
  });

  it("re-points the same pane on every later click instead of opening another", () => {
    openBeside("/docs", { reuse: true });
    openBeside("/plans", { reuse: true });
    openBeside("/feed", { reuse: true });
    const t = activeTab();
    expect(leavesOf(t.layout).map((l) => [l.id, l.path])).toEqual([
      [seedLeafId("t1"), "/tasks"],
      [besideLeafId("t1"), "/feed"],
    ]);
    expect(t.focusedLeafId).toBe(seedLeafId("t1"));
    expect(t.path).toBe("/tasks");
  });

  it("a path already on stage opens nothing and moves nothing", () => {
    state().stageInsertLeaf("root", "right", "/docs");
    const before = activeTab();
    expect(openBeside("/docs", { reuse: true })).toBe(true);
    expect(activeTab()).toBe(before);
    expect(openBeside("/tasks", { reuse: true })).toBe(true);
    expect(activeTab()).toBe(before);
  });

  it("the ordinary open beside still adds and focuses a fresh pane", () => {
    openBeside("/docs");
    openBeside("/plans");
    const t = activeTab();
    expect(leavesOf(t.layout).map((l) => l.path)).toEqual(["/tasks", "/docs", "/plans"]);
    expect(t.path).toBe("/plans");
  });
});

describe("stageRenderLayout", () => {
  it("renders a plain tab as the leaf its first split will keep", () => {
    const plain = stageRenderLayout(activeTab(), false);
    expect(plain).toEqual({ type: "leaf", id: seedLeafId("t1"), path: "/tasks" });
    state().stageInsertLeaf("root", "right", "/docs", { focus: false });
    const split = stageRenderLayout(activeTab(), false);
    expect(leavesOf(split)[0]).toEqual(plain);
    expect(leavesOf(split)[1].path).toBe("/docs");
  });

  it("a narrow stage renders the focused leaf alone, under its own id", () => {
    state().stageInsertLeaf("root", "right", "/docs");
    const t = activeTab();
    expect(stageRenderLayout(t, true)).toEqual(leavesOf(t.layout)[1]);
    expect(stageRenderLayout(t, true).path).toBe("/docs");
  });
});
