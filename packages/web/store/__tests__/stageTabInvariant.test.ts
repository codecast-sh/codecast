import { beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore, type AppTab } from "../inboxStore";
import { leavesOf, findLeaf } from "../stageSplit";
import { healTabPaths } from "../../lib/tabRoutes";

// The stage-split contract at the STORE level: `tab.path` always mirrors the
// focused leaf's path (the invariant every consumer of a tab's path stands
// on), and a collapsing layout never leaves a tab sitting on the
// /conversation/<id> redirect route.

const tab = (over?: Partial<AppTab>): AppTab => ({
  id: "t1",
  title: "Tasks",
  path: "/tasks",
  createdAt: 0,
  ...over,
});

const state = () => useInboxStore.getState();
const activeTab = () => state().tabs.find((t) => t.id === state().activeTabId)!;
const leafPaths = () => leavesOf(activeTab().layout!).map((l) => l.path);

beforeEach(() => {
  useInboxStore.setState({ tabs: [tab()], activeTabId: "t1" } as any);
});

describe("stageInsertLeaf", () => {
  it("seeds a plain tab's first leaf from its path and focuses the newcomer", () => {
    const id = state().stageInsertLeaf("root", "right", "/docs");
    expect(id).toBeTruthy();
    expect(leafPaths()).toEqual(["/tasks", "/docs"]);
    expect(activeTab().focusedLeafId).toBe(id);
    expect(activeTab().path).toBe("/docs");
  });

  it("refuses a non-shell path", () => {
    expect(state().stageInsertLeaf("root", "right", "/login")).toBeNull();
    expect(activeTab().layout).toBeUndefined();
  });
});

describe("the tab.path / focused-leaf invariant", () => {
  it("updateTab({path}) flows into the focused leaf", () => {
    state().stageInsertLeaf("root", "right", "/docs");
    state().updateTab("t1", { path: "/plans" });
    const t = activeTab();
    expect(t.path).toBe("/plans");
    expect(findLeaf(t.layout!, t.focusedLeafId!)!.path).toBe("/plans");
    // The unfocused leaf is untouched.
    expect(leafPaths()).toEqual(["/tasks", "/plans"]);
  });

  it("stageFocusLeaf moves tab.path to the newly focused leaf", () => {
    state().stageInsertLeaf("root", "right", "/docs");
    const first = leavesOf(activeTab().layout!)[0];
    state().stageFocusLeaf(first.id);
    expect(activeTab().path).toBe("/tasks");
  });

  it("stageSetLeafPath on the focused leaf updates tab.path; on another leaf it does not", () => {
    state().stageInsertLeaf("root", "right", "/docs");
    const [first, second] = leavesOf(activeTab().layout!);
    state().stageSetLeafPath(first.id, "/plans");
    expect(activeTab().path).toBe("/docs");
    state().stageSetLeafPath(second.id, "/feed");
    expect(activeTab().path).toBe("/feed");
  });
});

describe("stageCloseLeaf", () => {
  it("closing the focused leaf drops focus to a survivor and re-syncs tab.path", () => {
    state().stageInsertLeaf("root", "right", "/docs");
    const focused = activeTab().focusedLeafId!;
    state().stageCloseLeaf(focused);
    const t = activeTab();
    expect(t.layout).toBeUndefined();
    expect(t.path).toBe("/tasks");
  });

  it("a tab collapsing onto a conversation leaf lands on the /inbox?s= spelling, never the redirect route", () => {
    state().stageInsertLeaf("root", "right", "/conversation/abc123");
    const first = leavesOf(activeTab().layout!)[0];
    state().stageCloseLeaf(first.id);
    const t = activeTab();
    expect(t.layout).toBeUndefined();
    expect(t.path).toBe("/inbox?s=abc123");
  });

  it("stageExpandLeaf applies the same spelling rule", () => {
    const id = state().stageInsertLeaf("root", "right", "/conversation/abc123")!;
    state().stageExpandLeaf(id);
    expect(activeTab().path).toBe("/inbox?s=abc123");
    expect(activeTab().layout).toBeUndefined();
  });
});

describe("healTabPaths layouts", () => {
  it("drops a malformed layout but keeps the tab's plain path", () => {
    const healed = healTabPaths([
      tab({ layout: { type: "split", id: "x", dir: "row", children: [], sizes: [] } as any, focusedLeafId: "nope" }),
    ]);
    expect(healed[0].layout).toBeUndefined();
    expect(healed[0].focusedLeafId).toBeUndefined();
    expect(healed[0].path).toBe("/tasks");
  });

  it("re-syncs the focused leaf to tab.path when an old client rewrote path alone", () => {
    state().stageInsertLeaf("root", "right", "/docs");
    const withLayout = activeTab();
    // An older client rewrote path without touching the layout:
    const stale = { ...withLayout, path: "/feed" };
    const healed = healTabPaths([stale]);
    const focused = findLeaf(healed[0].layout as any, healed[0].focusedLeafId as string)!;
    expect(focused.path).toBe("/feed");
  });

  it("is a no-op (same array identity) for healthy tabs", () => {
    state().stageInsertLeaf("root", "right", "/docs");
    const tabs = [activeTab()];
    expect(healTabPaths(tabs)).toBe(tabs);
  });
});
