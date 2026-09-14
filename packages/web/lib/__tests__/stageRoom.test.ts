import { replaceGlobals } from "../../test-helpers/globals";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { useInboxStore, type AppTab } from "../../store/inboxStore";
import { leavesOf } from "../../store/stageSplit";
import { openBrowserPane, stageHasRoom } from "../stage";

// The rules a gesture NOBODY CLICKED depends on. An agent's pane offer can
// open itself under a preference, so both of these carry the whole weight of
// "the machine never moves what the reader is looking at": stageHasRoom has to
// count the pane cap, not just the window width, and `beside: "only"` has to
// refuse the navigation fallback that the manual click is happy to take.

const tab = (over?: Partial<AppTab>): AppTab => ({ id: "t1", title: "A", path: "/tasks", createdAt: 0, ...over });
const state = () => useInboxStore.getState();
const activeTab = () => state().tabs.find((t) => t.id === state().activeTabId)!;
const source = { kind: "url", url: "http://localhost:8765/" } as const;

let restore: () => void;
beforeAll(() => {
  restore = replaceGlobals({
    window: {
      innerWidth: 1400,
      location: { pathname: "/tasks", search: "" },
      history: { pushState: () => {}, replaceState: () => {} },
    },
  });
});
afterAll(() => restore());
beforeEach(() => {
  useInboxStore.setState({ tabs: [tab()], activeTabId: "t1" } as any);
});

/** Fill the stage to the four-pane cap. */
function fillStage() {
  state().stageInsertLeaf("root", "right", "/docs");
  state().stageInsertLeaf("root", "right", "/plans");
  state().stageInsertLeaf("root", "right", "/tasks/ct-1");
  expect(leavesOf(activeTab().layout!)).toHaveLength(4);
}

describe("stageHasRoom", () => {
  it("says yes on a stage with room", () => {
    expect(stageHasRoom()).toBe(true);
  });

  it("says no at the four-pane cap, where width alone still says yes", () => {
    fillStage();
    expect(stageHasRoom()).toBe(false);
  });

  it("says no in a window too narrow to show two panes", () => {
    const narrow = replaceGlobals({ window: { innerWidth: 700, location: { pathname: "/tasks", search: "" } } });
    try {
      expect(stageHasRoom()).toBe(false);
    } finally {
      narrow();
    }
  });
});

describe('openBrowserPane beside: "only"', () => {
  it("opens beside when there is room, like the ordinary gesture", () => {
    expect(openBrowserPane(source, { beside: "only" })).toBe(true);
    expect(leavesOf(activeTab().layout!).map((l) => l.path.split("?")[0])).toEqual(["/tasks", "/browser"]);
  });

  it("at the cap it gives up instead of moving the tab", () => {
    fillStage();
    const before = activeTab().path;
    expect(openBrowserPane(source, { beside: "only" })).toBe(false);
    // The reader's view is exactly where they left it: same tab path, same panes.
    expect(activeTab().path).toBe(before);
    expect(leavesOf(activeTab().layout!).map((l) => l.path.split("?")[0]))
      .toEqual(["/tasks", "/docs", "/plans", "/tasks/ct-1"]);
  });
});
